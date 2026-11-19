// O cartão "Rotina <nome> iniciada/concluída/falhou" (F13): UM cartão por execução de rotina, aberto quando ela COMEÇA e atualizado
// quando termina. Fonte única das duas pontas, usada pelo motor (abrir ao reivindicar a execução), pelo executor (fechar com o
// desfecho) e pelas aprovações (fechar quando o pedido expira).
//
// O cartão abre a rodada (spec decisão 10): é a "mensagem" que inicia a execução, no lugar da mensagem do dono. Por isso o `content`
// é o que o MODELO lê ("[Sistema] <content>"): o nome da rotina, o horário previsto e a instrução. O resultado final do bot NÃO é copiado
// para o cartão (T20): ele já é uma mensagem do bot na conversa, logo abaixo, e a cópia o mostrava duas vezes.
import type { RoutineRunCard } from '@aion/shared';
import { recordConversationEvent } from '../conversation/events';
import type { Queryable } from '../db/pool';
import { readAppSettings } from '../settings/service';

/** O que o motor sabe da execução ao abrir o cartão. */
export interface OpeningRun {
  id: string;
  conversation_id: string;
  input: string;
  routine_id: string | null;
  routine_name: string;
}

/** Horário como o modelo o lê no cartão, no fuso do dono (Configurações, T28). */
const formatForModel = (date: Date, timeZone: string): string => date.toLocaleString('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' });

/**
 * Abre o cartão da rotina como a mensagem que inicia a execução e devolve o id dele (vira o `trigger_message_id`). O horário previsto
 * e se foi "Executar agora" vêm do registro do horário (`routine_occurrences`).
 */
export async function openRoutineRunCard(tx: Queryable, run: OpeningRun, startedAt: Date): Promise<string> {
  const occurrence = await tx.query<{ scheduled_for: Date; manual: boolean }>('SELECT scheduled_for, manual FROM routine_occurrences WHERE run_id = $1', [run.id]);
  const scheduledFor = occurrence.rows[0]?.scheduled_for ?? startedAt;
  const manual = occurrence.rows[0]?.manual ?? false;

  const card: RoutineRunCard = {
    type: 'routine_run',
    routineId: run.routine_id,
    routineName: run.routine_name,
    scheduledFor: scheduledFor.toISOString(),
    startedAt: startedAt.toISOString(),
    manual,
    state: 'running',
    finishedAt: null,
    failureCode: null,
  };
  const { timeZone } = await readAppSettings(tx);
  const trigger = manual ? 'disparada agora pelo dono' : `horário previsto: ${formatForModel(scheduledFor, timeZone)}`;
  const content = `Rotina "${run.routine_name}" iniciada (${trigger}). Você foi acionado por esta rotina, sem o dono presente. Execute a instrução da rotina e responda com o resultado.\nInstrução da rotina: ${run.input}`;
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, data, created_at)
     VALUES ($1, $2, 'system', 'card', 'done', true, $3, $4, $5) RETURNING id::text AS id`,
    [run.conversation_id, run.id, content, JSON.stringify(card), startedAt],
  );
  const id = (inserted.rows[0] as { id: string }).id;
  await recordConversationEvent(tx, run.conversation_id, 'message', id, startedAt);
  return id;
}

/** Como a execução terminou, no vocabulário do cartão. */
export type RoutineRunEnd = Pick<RoutineRunCard, 'state' | 'failureCode'>;

/** Fecha o cartão da execução (se ela for de rotina) com o desfecho e a hora do fim. Sem cartão (execução de mensagem), não faz nada. */
export async function settleRoutineRunCard(tx: Queryable, run: { id: string; conversation_id: string }, end: RoutineRunEnd, at: Date): Promise<void> {
  const patch: Partial<RoutineRunCard> = { state: end.state, finishedAt: end.state === 'running' ? null : at.toISOString(), failureCode: end.failureCode };
  const updated = await tx.query<{ id: string }>(
    `UPDATE messages SET data = data || $2::jsonb
     WHERE run_id = $1 AND kind = 'card' AND data->>'type' = 'routine_run' RETURNING id::text AS id`,
    [run.id, JSON.stringify(patch)],
  );
  for (const row of updated.rows) await recordConversationEvent(tx, run.conversation_id, 'message', row.id, at);
}
