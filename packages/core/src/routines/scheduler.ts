// Agendador das rotinas (roda no worker; F13): de tempos em tempos procura as rotinas ativas cujo próximo horário previsto chegou e
// DISPARA a execução na fila do bot. Quem executa é o `RunEngine`; este arquivo só decide QUANDO uma rotina vira uma execução.
//
// Uma execução por horário previsto, mesmo com reinícios: cada rotina vencida é tratada numa transação que a trava
// (`FOR UPDATE SKIP LOCKED`, então dois workers não disputam), grava o horário em `routine_occurrences` (índice único por rotina e
// horário previsto) e avança o `next_run_at` NA MESMA transação. Uma queda no meio não deixa nada pela metade, e repetir o ciclo
// depois de um reinício encontra o horário já tratado.
//
// Execução perdida (spec decisão 15 e F13 passo 3). Ao tratar uma rotina vencida, reúne todos os horários previstos que já passaram
// e os separa pelo atraso em relação a agora:
//   - atraso de até 60 minutos: roda UMA vez, no horário previsto mais antigo do grupo (os demais do grupo são absorvidos por essa
//     execução; uma rotina a cada 5 minutos que ficou meia hora parada não vira seis execuções seguidas);
//   - atraso maior: não executa; fica registrada como `perdida` no histórico e num cartão na conversa do bot (os 10 mais recentes).
// Depois disso o próximo horário previsto é o primeiro depois de agora.
//
// Uma rotina que dispara com o bot ocupado entra na fila dele (FIFO). Para a fila não crescer sem controle quando a rotina é mais
// rápida que o bot, uma rotina nunca tem mais de uma execução AGUARDANDO: um horário que chega com a anterior ainda na fila é
// registrado como `pulada`.
import { ROUTINE_CATCH_UP_MS, type RoutineMissedCard } from '@aion/shared';
import { recordAudit } from '../audit';
import { recordConversationEvent } from '../conversation/events';
import { queueRun } from '../conversation/run-queue';
import { withTransaction, type Pool, type PoolClient } from '../db/pool';
import type { Logger } from '../logging';
import { ROUTINE_SELECT, planOfRow, type RoutineRow } from './rows';
import { occurrencesAfter, schedulingState } from './schedule';

export interface RoutineSchedulerConfig {
  /** De quanto em quanto tempo o agendador procura rotinas vencidas. */
  pollMs: number;
  /** Quantas rotinas vencidas trata por ciclo (as demais ficam para o próximo, 5 s depois). */
  batch: number;
}

export const DEFAULT_SCHEDULER_CONFIG: RoutineSchedulerConfig = { pollMs: 5_000, batch: 20 };

/**
 * Quantas execuções perdidas de uma mesma retomada ganham registro e cartão (as mais recentes).
 * ponytail: as perdidas além das 10 mais recentes não ficam no histórico; subir o teto ou resumir num cartão só se o dono precisar vê-las.
 */
const MAX_MISSED_RECORDED = 10;
/**
 * Teto de horários previstos examinados numa retomada (uma rotina de 5 em 5 minutos cabe em ~69 dias de parada).
 * ponytail: a varredura é síncrona dentro da transação da rotina; depois de uma parada acima do teto ela para antes de chegar aos horários mais
 * recentes (as perdidas registradas são as mais recentes DO QUE FOI VARRIDO) e a rotina segue do próximo horário depois de agora; tornar a
 * varredura incremental se uma parada de semanas virar rotina.
 */
const MAX_DUE_SCANNED = 20_000;
/** Horários lidos por vez ao reunir os vencidos. */
const SCAN_CHUNK = 500;

export interface RoutineSchedulerOptions {
  pool: Pool;
  logger: Logger;
  now?: () => Date;
  config?: Partial<RoutineSchedulerConfig>;
}

export class RoutineScheduler {
  private readonly pool: Pool;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly config: RoutineSchedulerConfig;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private ticking: Promise<unknown> = Promise.resolve();

  constructor({ pool, logger, now = () => new Date(), config = {} }: RoutineSchedulerOptions) {
    this.pool = pool;
    this.logger = logger;
    this.now = now;
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
  }

  /** Começa a procurar rotinas vencidas a cada `pollMs`. Erro de um ciclo é logado e o laço continua. */
  start(): void {
    if (this.timer !== null || this.stopping) return;
    const tick = () => {
      this.ticking = this.tickOnce()
        .catch((error: unknown) => this.logger.error({ err: error }, 'falha ao disparar rotinas'))
        .finally(() => {
          if (!this.stopping) this.timer = setTimeout(tick, this.config.pollMs);
        });
    };
    this.timer = setTimeout(tick, 0);
  }

  /** Para de procurar e espera o ciclo em andamento terminar. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.ticking;
  }

  /** Trata as rotinas vencidas agora, uma transação por rotina. Devolve quantas tratou. Exposto para os testes. */
  async tickOnce(): Promise<number> {
    let handled = 0;
    while (!this.stopping && handled < this.config.batch) {
      const done = await withTransaction(this.pool, async (tx) => {
        const at = this.now();
        const found = await tx.query<RoutineRow>(
          `SELECT ${ROUTINE_SELECT} FROM routines r JOIN bots b ON b.id = r.bot_id
           WHERE r.status = 'active' AND r.next_run_at <= $1
           ORDER BY r.next_run_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
          [at],
        );
        const row = found.rows[0];
        if (!row) return false;
        await this.handleDue(tx, row, at);
        return true;
      });
      if (!done) break;
      handled += 1;
    }
    return handled;
  }

  /**
   * Os horários previstos vencidos, em ordem, até o teto de varredura: o próprio `next_run_at` (que é a verdade gravada, mesmo que o
   * banco de fusos tenha mudado desde que foi calculado) e os que a agenda produz depois dele, até agora (inclusive).
   */
  private dueInstants(row: RoutineRow, at: Date): number[] {
    const plan = planOfRow(row);
    const first = row.next_run_at as Date;
    const due: number[] = [first.getTime()];
    let cursor = first;
    while (due.length < MAX_DUE_SCANNED) {
      const chunk = occurrencesAfter(plan, cursor, SCAN_CHUNK);
      for (const date of chunk) {
        if (date.getTime() > at.getTime()) return due;
        due.push(date.getTime());
      }
      if (chunk.length < SCAN_CHUNK) break;
      cursor = chunk.at(-1) as Date;
    }
    return due;
  }

  /** Trata UMA rotina vencida: perdidas, a execução (se houver) e o próximo horário, tudo na transação que a travou. */
  private async handleDue(tx: PoolClient, row: RoutineRow, at: Date): Promise<void> {
    // Defesa: o arquivamento pausa as rotinas, então uma ativa de bot arquivado só existe por inconsistência. Não dispara.
    if (row.bot_archived_at !== null) {
      await tx.query("UPDATE routines SET status = 'paused', next_run_at = NULL, updated_at = $2 WHERE id = $1", [row.id, at]);
      return;
    }

    // O cálculo da agenda é só código (rrule, cron, fusos), mas pode lançar para uma rotina específica: um fuso que o banco de fusos
    // deixou de reconhecer, um cron que uma versão nova do parser recusa. Sem tratar, a transação desfaz, a MESMA rotina continua sendo
    // a mais antiga a cada ciclo e nenhuma das outras dispara nunca (R15). Então a rotina que não calcula é pausada e o ciclo segue.
    let due: number[];
    try {
      due = this.dueInstants(row, at);
    } catch (error) {
      await this.pauseUnschedulable(tx, row, at, error, row.run_count);
      return;
    }
    const catchUpFrom = at.getTime() - ROUTINE_CATCH_UP_MS;
    const late = due.filter((instant) => instant < catchUpFrom);
    const recent = due.filter((instant) => instant >= catchUpFrom);

    const conversation = await tx.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [row.bot_id]);
    const conversationId = (conversation.rows[0] as { id: string }).id;

    for (const instant of late.slice(-MAX_MISSED_RECORDED)) await this.recordMissed(tx, row, conversationId, new Date(instant), at);

    let fired = 0;
    const first = recent[0];
    if (first !== undefined && (await this.fire(tx, row, conversationId, new Date(first), at))) fired = 1;

    let state: ReturnType<typeof schedulingState>;
    try {
      state = schedulingState(planOfRow(row), { runCount: row.run_count + fired, maxRuns: row.max_runs }, at);
    } catch (error) {
      await this.pauseUnschedulable(tx, row, at, error, row.run_count + fired); // a execução já enfileirada acima fica contada
      return;
    }
    await tx.query('UPDATE routines SET run_count = $2, status = $3, next_run_at = $4, updated_at = $5 WHERE id = $1', [
      row.id,
      row.run_count + fired,
      state.status,
      state.nextRunAt,
      at,
    ]);
    this.logger.info({ routineId: row.id, due: due.length, missed: Math.min(late.length, MAX_MISSED_RECORDED), fired }, 'rotina tratada');
  }

  /**
   * Pausa a rotina cuja agenda não pôde ser calculada, na própria transação do ciclo, com auditoria (`routine.auto_pause`, ator
   * `system`) e o erro no log. O dono vê a rotina pausada e, depois de corrigir a agenda, a retoma. Só o motivo vai para a auditoria
   * (o texto do erro fica no log). `runCount` preserva as execuções já disparadas neste ciclo.
   */
  private async pauseUnschedulable(tx: PoolClient, row: RoutineRow, at: Date, error: unknown, runCount: number): Promise<void> {
    await tx.query("UPDATE routines SET status = 'paused', next_run_at = NULL, run_count = $2, updated_at = $3 WHERE id = $1", [row.id, runCount, at]);
    await recordAudit(tx, { action: 'routine.auto_pause', outcome: 'failure', actor: 'system', target: row.id, details: { reason: 'SCHEDULE_ERROR' } }, at);
    this.logger.error({ routineId: row.id, err: error }, 'rotina pausada: não foi possível calcular a agenda');
  }

  /** Registra a execução perdida: a linha do histórico e o cartão "Rotina perdida" na conversa do bot. */
  private async recordMissed(tx: PoolClient, row: RoutineRow, conversationId: string, scheduledFor: Date, at: Date): Promise<void> {
    const occurrence = await tx.query<{ id: string }>(
      `INSERT INTO routine_occurrences (routine_id, scheduled_for, outcome, created_at) VALUES ($1, $2, 'missed', $3)
       ON CONFLICT (routine_id, scheduled_for) WHERE NOT manual DO NOTHING RETURNING id`,
      [row.id, scheduledFor, at],
    );
    const occurrenceId = occurrence.rows[0]?.id;
    if (occurrenceId === undefined) return;
    const card: RoutineMissedCard = { type: 'routine_missed', routineId: row.id, routineName: row.name, scheduledFor: scheduledFor.toISOString() };
    // `content` vazio de propósito: o cartão é do dono, fora da busca e do contexto do modelo.
    const message = await tx.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, role, kind, status, content, data, created_at) VALUES ($1, 'system', 'card', 'done', '', $2, $3) RETURNING id::text AS id`,
      [conversationId, JSON.stringify(card), at],
    );
    const messageId = (message.rows[0] as { id: string }).id;
    await tx.query('UPDATE routine_occurrences SET message_id = $2 WHERE id = $1', [occurrenceId, messageId]);
    await recordConversationEvent(tx, conversationId, 'message', messageId, at);
  }

  /** Enfileira a execução do horário previsto no bot. Devolve se disparou (`false`: já tratado antes, ou pulada pela fila). */
  private async fire(tx: PoolClient, row: RoutineRow, conversationId: string, scheduledFor: Date, at: Date): Promise<boolean> {
    const occurrence = await tx.query<{ id: string }>(
      `INSERT INTO routine_occurrences (routine_id, scheduled_for, outcome, created_at) VALUES ($1, $2, 'fired', $3)
       ON CONFLICT (routine_id, scheduled_for) WHERE NOT manual DO NOTHING RETURNING id`,
      [row.id, scheduledFor, at],
    );
    const occurrenceId = occurrence.rows[0]?.id;
    if (occurrenceId === undefined) return false;

    const waiting = await tx.query("SELECT 1 FROM runs WHERE routine_id = $1 AND status = 'queued' LIMIT 1", [row.id]);
    if (waiting.rowCount) {
      await tx.query("UPDATE routine_occurrences SET outcome = 'skipped' WHERE id = $1", [occurrenceId]);
      return false;
    }
    const run = await queueRun(tx, {
      botId: row.bot_id,
      conversationId,
      input: row.instruction,
      routine: { id: row.id, name: row.name },
      at,
      enforceLimit: false,
    });
    await tx.query('UPDATE routine_occurrences SET run_id = $2 WHERE id = $1', [occurrenceId, run.id]);
    return true;
  }
}
