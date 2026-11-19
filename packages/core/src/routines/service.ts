// Serviço das rotinas (F12; T9): criar, editar, pausar, retomar, "executar agora", excluir, histórico e a prévia da agenda. Fonte única
// dessas regras; a API só traduz HTTP <-> chamadas daqui. Quem DISPARA as execuções agendadas é o `RoutineScheduler` (worker).
//
// Decisões:
// - Toda validação de agenda (fuso, intervalo mínimo, cron, data única no futuro, fim depois do início) é `scheduleProblem`, a mesma
//   da prévia: o que a tela mostra como "Agenda inválida: <motivo>" é o que o salvar recusa com `SCHEDULE_INVALID`.
// - Editar vale a partir do PRÓXIMO horário previsto, calculado da agenda nova depois de agora. A execução em andamento (ou já na
//   fila) segue com o que tinha: a instrução é copiada para a execução quando o horário dispara.
// - Pausar e excluir tiram da fila as execuções da rotina que ainda não começaram (`cancelQueuedRoutineRuns`) e nunca mexem na que
//   já está rodando. Retomar recalcula o próximo horário a partir de agora: o tempo parado não gera "perdida".
// - Uma rotina de bot arquivado fica pausada (o `BotService` a pausa) e não retoma nem executa até o bot ser desarquivado.
// - "Executar agora" cria uma ocorrência `manual` (fora da regra de um por horário previsto) e uma execução na fila do bot, com o
//   mesmo teto de 20 aguardando de qualquer mensagem do dono. Não consome o limite de execuções nem muda o próximo horário.
// - PROPOSTA ANTIGA de um bot (cartão `routine_proposal` pendente, criado antes da phase 10): vira rotina por esta mesma criação, com
//   `proposalMessageId`: o cartão só é aceito se for da conversa do bot indicado, e confirmar de novo devolve a rotina já criada (nunca duplica).
//   A proposta antiga de ALTERAÇÃO (cartão `routine_change` pendente: mudar, pausar, retomar ou excluir) vira realidade por `confirmChange`.
// - APLICADA PELO BOT (phase 10, SEC-03 substituída): `createByBot` e `applyChangeByBot` aplicam na hora o que o bot pediu e gravam, na MESMA
//   transação, o cartão `applied` ("Rotina criada pelo bot" / "Alteração de rotina"). O dono pode `refuse` (desfaz) ou editar pelo cartão
//   (`update` com `cardId`). Todas reaproveitam os corpos de criar, editar, pausar, retomar e excluir (`insertRoutine`, `updateIn`, `pauseIn`,
//   `resumeIn`, `removeIn`), então a regra é uma só (a do dono) e quem muda é só o AUTOR da ação na auditoria (`Actor`).
//   Repetir `propose_routine` (queda do worker, nova tentativa) não duplica: `createByBot` reencontra a rotina idêntica do bot sob o travamento da linha do bot e devolve `created: false`.
// - "Mudou depois" (`superseded`): um cartão aplicado só pode ser recusado ou editado enquanto a rotina continua como ele a deixou. Cada
//   alteração por este serviço marca na hora os cartões aplicados da rotina (`supersedeAppliedCards`, e `removeIn` na exclusão); o que muda
//   por fora do serviço (arquivar o bot, pausa automática do agendador) é pego na conferência do clique (`stillAsApplied`).
// - Recusar a EXCLUSÃO de uma rotina a traz de volta com o mesmo id e o mesmo histórico: antes de excluir, o cartão da exclusão guarda um
//   instantâneo só do servidor (`restore`, fora do contrato do cartão em `@aion/shared`, então não vai à tela) com a linha da rotina, as
//   ocorrências, as execuções e os cartões que perderão o vínculo. Sem migration e sem mudar o contrato de `remove`. As três listas têm o mesmo
//   teto (`RESTORE_OCCURRENCES_MAX`), porque o instantâneo é lido a cada carga da conversa: um histórico maior volta só na janela mais recente.
import {
  ROUTINE_CHANGE_FIELDS,
  ROUTINE_HISTORY_PAGE_SIZE,
  ROUTINE_PREVIEW_COUNT,
  routineChangeCardSchema,
  routineProposalCardSchema,
  routineStatusSchema,
  scheduleDefinitionSchema,
  type RoutineAction,
  type RoutineChangeCard,
  type RoutineChangeField,
  type RoutineChangeResult,
  type RoutineConfirmedCard,
  type RoutineEditedCard,
  type RoutineHistory,
  type RoutineHistoryState,
  type RoutineInput,
  type RoutineList,
  type RoutinePreview,
  type RoutineProposalCard,
  type RoutineRefusedCard,
  type RoutineReplace,
  type RoutineScheduleSettings,
  type RoutineSnapshot,
  type RoutineView,
  type RunView,
  hasModelProvider,
} from '@aion/shared';
import { z } from 'zod';
import type { AuditEvent } from '../audit';
import { recordAudit } from '../audit';
import type { RequestOrigin } from '../auth/service';
import { recordConversationEvent } from '../conversation/events';
import { resolveBotModelChoice } from '../conversation/model-choice';
import { queueRun } from '../conversation/run-queue';
import { toRunView } from '../conversation/views';
import { SlidingWindowLimiter } from '../credentials/rate-limit';
import type { CredentialService } from '../credentials/service';
import { withTransaction, type Pool, type PoolClient } from '../db/pool';
import { DomainError } from '../errors';
import { describeSchedule } from './describe';
import { cancelQueuedRoutineRuns } from './queue';
import { ROUTINE_SELECT, canonicalJson, planOfRow, toRoutineView, type RoutineRow } from './rows';
import { occurrencesAfter, scheduleProblem, schedulingState, type ScheduleProblem, type SchedulePlan } from './schedule';

/** Quantos "Executar agora" por minuto: cada clique enfileira uma execução que gasta o provedor, além do teto de 20 aguardando (R16). */
export const RUN_NOW_PER_MINUTE = 10;

/**
 * Quantas ocorrências (as mais recentes) o instantâneo de uma exclusão feita pelo bot guarda. O instantâneo mora na linha do cartão (`data.restore`) e é lido a
 * cada carregamento da conversa e a cada preparação do pedido (as linhas do histórico vêm com `data`); sem teto, uma rotina de 5 em 5 minutos com um ano de
 * histórico faria dele um objeto de megabytes. O mesmo teto vale para as outras duas listas que crescem com o histórico: as execuções guardadas são só as das
 * ocorrências guardadas (`captureRestore`) e os cartões religados são, no máximo, os mais recentes (`newestIds`). O contrato do cartão não declara o
 * instantâneo, então `toMessageView` (conversation/views.ts) o descarta em toda view enviada ao navegador (snapshot, paginação e SSE).
 * ponytail: recusar a exclusão de uma rotina com mais de 5.000 ocorrências traz de volta só as 5.000 mais recentes, com as execuções delas e os 5.000 cartões
 * mais recentes; o que ficou de fora segue sem rotina, como numa exclusão feita pelo dono (o aviso ao bot diz isso); guardar o histórico longo numa tabela
 * própria (migration) se o dono passar a recusar exclusões de rotinas muito antigas.
 */
export const RESTORE_OCCURRENCES_MAX = 5000;

/**
 * Os `max` ids mais recentes (maiores) de uma lista de ids numéricos em texto, para limitar o que o instantâneo de exclusão guarda. Compara como BigInt: o id
 * é `bigint` no banco e a conversão para `number` perderia precisão acima de 2^53. A ordem do resultado não importa para quem usa (`= ANY(...)`).
 */
function newestIds(ids: readonly string[], max: number): string[] {
  if (ids.length <= max) return [...ids];
  return ids.map((id) => BigInt(id)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, max).map(String);
}

/** O que o bot lê no aviso de confirmação, por ação: o verbo no particípio, concordando com "a rotina". */
const CONFIRMED_VERB: Record<RoutineConfirmedCard['action'], string> = {
  create: 'criada',
  update: 'alterada',
  pause: 'pausada',
  resume: 'retomada',
  delete: 'excluída',
};

/**
 * Quem pratica a ação sobre a rotina: o dono (pela API, com a origem da requisição) ou o bot (pelas ferramentas, com o bot e a execução). Os corpos
 * de criar, editar, pausar, retomar e excluir são os mesmos para os dois; só a auditoria muda (D3: o bot grava `system` com o bot, a execução e a
 * origem `bot` em `details`, nunca a instrução).
 */
type Actor = { by: 'owner'; origin: RequestOrigin } | { by: 'bot'; botId: string; runId: string };

/** O bot e a conversa em que uma ferramenta de rotina age (vêm do contexto da execução, nunca dos argumentos do modelo). */
export interface BotRoutineScope {
  botId: string;
  conversationId: string;
  runId: string;
}

/** Os campos de uma rotina que o bot pode mudar; ausente fica como está e `null` remove início, fim e limite. */
export interface BotRoutineFields {
  name?: string | undefined;
  instruction?: string | undefined;
  schedule?: RoutineReplace['schedule'] | undefined;
  timezone?: string | undefined;
  startsAt?: string | null | undefined;
  endsAt?: string | null | undefined;
  maxRuns?: number | null | undefined;
}

/** Alteração que `propose_routine_change` pede e `applyChangeByBot` aplica na hora. */
export type BotRoutineChange = { action: 'update'; fields: BotRoutineFields } | { action: 'pause' } | { action: 'resume' } | { action: 'delete' };

/** O que a ferramenta devolve ao bot depois de aplicar: a rotina como ficou (nula na exclusão) e os campos que mudaram (só em `update`). */
export interface BotChangeResult {
  routine: RoutineView | null;
  changed: RoutineChangeField[];
}

/**
 * Instantâneo do que uma exclusão feita pelo bot apaga, para a recusa trazer a rotina de volta (ver o cabeçalho). Só do servidor: não é membro do
 * contrato do cartão, e o serializador da API remove o que o contrato não declara.
 */
const restoreSchema = z.object({
  routine: z.object({
    id: z.uuid(),
    botId: z.uuid(),
    name: z.string(),
    instruction: z.string(),
    schedule: scheduleDefinitionSchema,
    timezone: z.string(),
    startsLocal: z.string().nullable(),
    endsLocal: z.string().nullable(),
    maxRuns: z.number().int().nullable(),
    anchorAt: z.iso.datetime(),
    status: routineStatusSchema,
    runCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  }),
  /** Ocorrências em ordem crescente de id: [horário previsto, resultado, manual, id da execução, id do cartão, criada em]. */
  occurrences: z.array(z.tuple([z.iso.datetime(), z.enum(['fired', 'missed', 'skipped']), z.boolean(), z.string().regex(/^\d{1,18}$/).nullable(), z.string().regex(/^\d{1,18}$/).nullable(), z.iso.datetime()])),
  /** Havia mais ocorrências que o teto `RESTORE_OCCURRENCES_MAX`: as mais antigas não voltam. */
  occurrencesTruncated: z.boolean(),
  /**
   * Execuções das ocorrências guardadas (`runs.routine_id` é zerado na exclusão e a recusa o refaz só para estas). Toda execução de rotina nasce com a
   * ocorrência que a aponta (`fire` e `runNow`), então sem truncamento é o conjunto inteiro; com truncamento, as das ocorrências cortadas ficam sem rotina.
   */
  runIds: z.array(z.string().regex(/^\d{1,18}$/)),
  /** Cartões da conversa que perdem o `routineId` na exclusão e que a recusa religa (no máximo `RESTORE_OCCURRENCES_MAX`, os mais recentes). */
  cardIds: z.array(z.string().regex(/^\d{1,18}$/)),
});
type RestoreSnapshot = z.infer<typeof restoreSchema>;

/** Os cartões que o dono pode recusar ou editar: o de rotina criada e o de alteração, nos dois fluxos de vida. */
const routineCardSchema = z.discriminatedUnion('type', [routineProposalCardSchema, routineChangeCardSchema]);
type RoutineCard = z.infer<typeof routineCardSchema>;

/** Um cartão de rotina travado para escrita (`FOR UPDATE`), com a conversa e o bot dono dela. */
interface LockedCard {
  id: string;
  conversationId: string;
  botId: string;
  card: RoutineCard;
  /** Instantâneo de exclusão (só nos cartões de exclusão feitos pelo bot). */
  restore: RestoreSnapshot | null;
}

/**
 * O que o bot lê no aviso de recusa, por ação: o que foi desfeito e como a rotina ficou. `restoredCount` só vale na exclusão: é quantas ocorrências voltaram
 * quando o instantâneo foi truncado (nulo quando o histórico voltou inteiro). Vem do instantâneo, não do teto do serviço, para o aviso dizer o que de fato voltou.
 */
function refusedNotice(action: RoutineAction, name: string, routineId: string | null, restoredCount: number | null): string {
  const ref = `"${name}"${routineId === null ? '' : ` (id ${routineId})`}`;
  switch (action) {
    case 'create':
      return `O dono recusou a rotina que você criou: a rotina "${name}" foi excluída e deixou de existir. Não a crie de novo sem o dono pedir.`;
    case 'update':
      return `O dono recusou a sua alteração: a rotina ${ref} voltou a ser como era antes dela.`;
    case 'pause':
      return `O dono recusou a pausa: a rotina ${ref} foi retomada e voltou a rodar na agenda.`;
    case 'resume':
      return `O dono recusou a retomada: a rotina ${ref} voltou a ficar pausada.`;
    case 'delete':
      return `O dono recusou a exclusão: a rotina ${ref} voltou, com a mesma configuração e o mesmo histórico${restoredCount === null ? '' : ` (só as ${restoredCount} execuções mais recentes do histórico voltaram)`}.`;
  }
}

/** O aviso de edição: o estado FINAL da rotina (nome, agenda legível, fuso e instrução), o que o modelo precisa para seguir de onde o dono deixou. */
const editedNotice = (routine: RoutineView): string =>
  `O dono editou a rotina "${routine.name}" (id ${routine.id}) pelo cartão e ela vale assim agora. Nome: ${routine.name}. Agenda: ${routine.summary} (${routine.timezone}). Instrução:\n${routine.instruction}`;

/** Os campos editáveis de uma rotina com a agenda legível: o "antes" e o "depois" do cartão de alteração. */
const snapshotOf = (routine: RoutineView): RoutineSnapshot => ({
  name: routine.name,
  instruction: routine.instruction,
  schedule: routine.schedule,
  timezone: routine.timezone,
  startsAt: routine.startsAt,
  endsAt: routine.endsAt,
  maxRuns: routine.maxRuns,
  summary: routine.summary,
});

/**
 * Grava uma mensagem de cartão no fim da conversa e avisa o SSE. `runId` liga o cartão à execução que o bot estava rodando (cartões de rotina
 * criada e de alteração); os avisos entram sem execução. `opens_round` falso: o cartão entra na rodada em curso e não empurra rodadas para fora da
 * janela de contexto. `content` vazio mantém o cartão fora da busca do histórico e do contexto do modelo (ver `OWNER_ONLY_CARDS`).
 */
async function insertCard(
  tx: PoolClient,
  conversationId: string,
  data: object,
  { content = '', runId = null, at }: { content?: string; runId?: string | null; at: Date },
): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, data, created_at)
     VALUES ($1, $2, 'system', 'card', 'done', false, $3, $4, $5) RETURNING id::text AS id`,
    [conversationId, runId, content, JSON.stringify(data), at],
  );
  const id = (inserted.rows[0] as { id: string }).id;
  await recordConversationEvent(tx, conversationId, 'message', id, at);
  return id;
}

/**
 * Grava no fim da conversa o aviso "Rotina confirmada" (ver `routineConfirmedCardSchema`): é por ele que o bot fica sabendo que o dono confirmou o
 * que ele propôs, já que os cartões de proposta são só do dono. Roda na transação da confirmação, então o aviso existe se e só se a confirmação valeu.
 * Sem `run_id`, porque não é fruto de uma execução.
 */
async function insertConfirmedCard(tx: PoolClient, conversationId: string, card: RoutineConfirmedCard, at: Date): Promise<void> {
  const id = card.routineId === null ? '' : ` (id ${card.routineId})`;
  const content = `O dono confirmou a sua proposta: a rotina "${card.routineName}"${id} foi ${CONFIRMED_VERB[card.action]} e isso já está valendo.`;
  await insertCard(tx, conversationId, card, { content, at });
}

export interface RoutineServiceOptions {
  pool: Pool;
  /** Só "Executar agora" a usa (o provedor precisa estar configurado). Ausente no serviço das ferramentas do bot, que nunca enfileira execuções. */
  credentials?: Pick<CredentialService, 'overview'>;
  /** Relógio injetável: os testes fixam o tempo. */
  now?: () => Date;
  /** Limite de "Executar agora" por minuto; os testes o baixam para provar a recusa. */
  runNowPerMinute?: number;
  /** Teto do instantâneo de exclusão (ver `RESTORE_OCCURRENCES_MAX`); os testes o baixam para provar o corte sem criar milhares de linhas. */
  restoreOccurrencesMax?: number;
}

/** O problema de agenda como exceção de domínio, com o motivo legível em `fields` (a tela o mostra no campo e na prévia). */
const problemToError = (problem: ScheduleProblem): DomainError => new DomainError(problem.code, { fields: [{ field: 'schedule', reason: problem.reason }] });

/** O valor atual de um campo editável da rotina, como o cartão de alteração o guarda. */
function currentValueOf(row: RoutineRow, field: RoutineChangeField): unknown {
  switch (field) {
    case 'name':
      return row.name;
    case 'instruction':
      return row.instruction;
    case 'schedule':
      return row.schedule;
    case 'timezone':
      return row.timezone;
    case 'startsAt':
      return row.starts_local;
    case 'endsAt':
      return row.ends_local;
    case 'maxRuns':
      return row.max_runs;
  }
}

type UpdateChange = Extract<RoutineChangeCard['change'], { action: 'update' }>;

/** Algum campo que a proposta muda foi alterado por outro caminho desde que o bot propôs? Então ela está desatualizada. */
const differsFromProposal = (change: UpdateChange, row: RoutineRow): boolean =>
  change.changed.some((field) => canonicalJson(change.before[field]) !== canonicalJson(currentValueOf(row, field)));

/** A rotina de agora com os campos `fields` trocados (ausentes ficam como estão; `null` remove início, fim e limite). */
function withFields(row: RoutineRow, fields: BotRoutineFields): RoutineReplace {
  return {
    botId: row.bot_id,
    name: fields.name ?? row.name,
    instruction: fields.instruction ?? row.instruction,
    schedule: fields.schedule ?? row.schedule,
    timezone: fields.timezone ?? row.timezone,
    startsAt: fields.startsAt === undefined ? row.starts_local : fields.startsAt,
    endsAt: fields.endsAt === undefined ? row.ends_local : fields.endsAt,
    maxRuns: fields.maxRuns === undefined ? row.max_runs : fields.maxRuns,
  };
}

/**
 * A rotina de agora com SÓ os campos da alteração trocados pelo lado pedido (`after` aplica a proposta antiga; `before` desfaz uma alteração
 * aplicada pelo bot): o que o dono não viu mudar (e mudou por fora) fica como está.
 */
function applyChangeSide(change: UpdateChange, row: RoutineRow, side: 'before' | 'after'): RoutineReplace {
  const merged: Record<string, unknown> = { ...withFields(row, {}) };
  for (const field of change.changed) merged[field] = change[side][field];
  return merged as unknown as RoutineReplace;
}

/** Todos os campos editáveis do estado dado são iguais aos da rotina de agora? */
const fieldsMatch = (state: Pick<RoutineSnapshot, RoutineChangeField>, row: RoutineRow): boolean =>
  ROUTINE_CHANGE_FIELDS.every((field) => canonicalJson(state[field]) === canonicalJson(currentValueOf(row, field)));

/**
 * A rotina ainda está como o cartão APLICADO a deixou? Só então Recusar e Editar valem (spec decisão 20). Criada: os campos como nasceram e não
 * pausada; alterada: os campos do "depois"; pausada: ainda pausada; retomada: ainda ativa. A exclusão é tratada à parte (a rotina não existe).
 * Complementa a marca `superseded` que o serviço grava na hora: pega o que mudou fora dele (arquivar o bot, pausa automática do agendador).
 */
function stillAsApplied(card: RoutineCard, row: RoutineRow): boolean {
  if (card.type === 'routine_proposal') return fieldsMatch(card.proposal, row) && row.status !== 'paused';
  switch (card.change.action) {
    case 'update':
      return fieldsMatch(card.change.after, row);
    case 'pause':
      return row.status === 'paused';
    case 'resume':
      return row.status === 'active';
    case 'delete':
      return false;
  }
}

export class RoutineService {
  private readonly pool: Pool;
  private readonly credentials: Pick<CredentialService, 'overview'> | undefined;
  private readonly now: () => Date;
  private readonly runNowLimiter: SlidingWindowLimiter;
  private readonly restoreMax: number;

  constructor({ pool, credentials, now = () => new Date(), runNowPerMinute = RUN_NOW_PER_MINUTE, restoreOccurrencesMax = RESTORE_OCCURRENCES_MAX }: RoutineServiceOptions) {
    this.pool = pool;
    this.credentials = credentials;
    this.now = now;
    this.restoreMax = restoreOccurrencesMax;
    // ponytail: o contador vive na memória do processo da API (vale por instância); contador no banco se houver mais de uma API.
    this.runNowLimiter = new SlidingWindowLimiter({ max: runNowPerMinute, windowMs: 60_000, now });
  }

  // ---------------------------------------------------------------------------------------------
  // Leitura
  // ---------------------------------------------------------------------------------------------

  /**
   * Todas as rotinas, por bot (ordem alfabética) e nome; a tela filtra por estado. ponytail: lista inteira sem paginação, paginar se
   * o dono passar de algumas centenas de rotinas.
   */
  async list(): Promise<RoutineList> {
    const rows = await this.pool.query<RoutineRow>(
      `SELECT ${ROUTINE_SELECT} FROM routines r JOIN bots b ON b.id = r.bot_id ORDER BY b.name_key, b.created_at, lower(r.name), r.created_at`,
    );
    return { routines: rows.rows.map(toRoutineView) };
  }

  /** Uma rotina. Lança ROUTINE_NOT_FOUND. */
  async get(id: string): Promise<RoutineView> {
    const found = await this.pool.query<RoutineRow>(`SELECT ${ROUTINE_SELECT} FROM routines r JOIN bots b ON b.id = r.bot_id WHERE r.id = $1`, [id]);
    const row = found.rows[0];
    if (!row) throw new DomainError('ROUTINE_NOT_FOUND');
    return toRoutineView(row);
  }

  /**
   * Prévia das próximas execuções de uma agenda ainda não salva (F12 passo 1). Agenda inválida NÃO é erro: volta `valid: false` com
   * o motivo, que a tela mostra no lugar da lista de datas.
   */
  preview(settings: RoutineScheduleSettings): RoutinePreview {
    const at = this.now();
    const plan = this.planFrom(settings, at);
    const problem = scheduleProblem(plan, at);
    if (problem) return { valid: false, reason: problem.reason, description: null, occurrences: [] };
    return {
      valid: true,
      reason: null,
      description: describeSchedule(settings.schedule),
      occurrences: occurrencesAfter(plan, at, ROUTINE_PREVIEW_COUNT).map((date) => date.toISOString()),
    };
  }

  /**
   * Histórico de horários previstos da rotina, do mais recente ao mais antigo, 50 por página (cursor = id da última linha).
   * ponytail: o histórico cresce sem retenção (uma linha por horário previsto); acrescentar um job de limpeza quando uma rotina de 5 em 5
   * minutos acumular dezenas de milhares de linhas.
   */
  async history(id: string, cursor: string | undefined): Promise<RoutineHistory> {
    await this.get(id);
    const rows = await this.pool.query<{
      id: string;
      scheduled_for: Date;
      outcome: 'fired' | 'missed' | 'skipped';
      manual: boolean;
      run_status: string | null;
      started_at: Date | null;
      message_id: string | null;
    }>(
      `SELECT o.id::text AS id, o.scheduled_for, o.outcome, o.manual, r.status AS run_status, r.started_at,
              coalesce(o.message_id, r.trigger_message_id)::text AS message_id
       FROM routine_occurrences o LEFT JOIN runs r ON r.id = o.run_id
       WHERE o.routine_id = $1 AND ($2::bigint IS NULL OR o.id < $2::bigint)
       ORDER BY o.id DESC LIMIT $3`,
      [id, cursor ?? null, ROUTINE_HISTORY_PAGE_SIZE + 1],
    );
    const page = rows.rows.slice(0, ROUTINE_HISTORY_PAGE_SIZE);
    return {
      items: page.map((row) => ({
        id: row.id,
        scheduledFor: row.scheduled_for.toISOString(),
        startedAt: row.started_at?.toISOString() ?? null,
        state: (row.outcome === 'fired' ? (row.run_status ?? 'skipped') : row.outcome) as RoutineHistoryState,
        manual: row.manual,
        messageId: row.message_id,
      })),
      nextCursor: rows.rows.length > ROUTINE_HISTORY_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Comandos do dono
  // ---------------------------------------------------------------------------------------------

  /**
   * Cria a rotina ativa, com o próximo horário calculado. Lança BOT_NOT_FOUND, BOT_ARCHIVED, SCHEDULE_INVALID ou SCHEDULE_IN_PAST. Com
   * `proposalMessageId`, confirma o cartão de proposta antiga do bot (idempotente).
   */
  async create(input: RoutineInput, origin: RequestOrigin): Promise<RoutineView> {
    const at = this.now();
    const actor: Actor = { by: 'owner', origin };
    return withTransaction(this.pool, async (tx) => {
      await this.requireActiveBot(tx, input.botId);
      if (input.proposalMessageId !== undefined) {
        const confirmed = await this.confirmedProposal(tx, input.botId, input.proposalMessageId);
        if (confirmed) return confirmed;
      }
      const id = await this.insertRoutine(tx, input, at);
      if (input.proposalMessageId !== undefined) await this.markProposalConfirmed(tx, input.proposalMessageId, { id, name: input.name }, at);
      await recordAudit(tx, this.auditOf('routine.create', actor, id, { bot: input.botId }), at);
      return this.getIn(tx, id);
    });
  }

  /**
   * Substitui os campos da rotina. A agenda nova vale a partir do próximo horário (calculado depois de agora). Uma rotina pausada
   * continua pausada; uma concluída volta a ficar ativa se a agenda nova tem execuções futuras. Lança ROUTINE_NOT_FOUND, BOT_NOT_FOUND,
   * BOT_ARCHIVED (ao trocar para um bot arquivado), SCHEDULE_INVALID ou SCHEDULE_IN_PAST.
   *
   * Com `cardId` (o editor aberto pelo cartão da rotina que o bot criou ou alterou), a edição também liga ao cartão: ele precisa ser de uma rotina
   * aplicada pelo bot e em vigor (`applied`) e a rotina não pode ter mudado depois dele, senão ROUTINE_CHANGED (o cartão vira `superseded` e nada é
   * gravado). Valendo, a edição segue as mesmas regras de sempre, o cartão passa a `edited` (a rotina passa a ser do dono naquele estado) e o aviso
   * `routine_edited`, com o estado final, entra no fim da conversa do bot. Lança NOT_FOUND se o cartão não é de rotina aplicada pelo bot ou não é desta rotina.
   */
  async update(id: string, input: RoutineReplace, origin: RequestOrigin, link?: { cardId: string }): Promise<RoutineView> {
    const at = this.now();
    const actor: Actor = { by: 'owner', origin };
    if (link === undefined) return withTransaction(this.pool, (tx) => this.updateIn(tx, id, input, actor, at));

    type Outcome = { superseded: true } | { superseded: false; routine: RoutineView };
    const outcome = await withTransaction(this.pool, async (tx): Promise<Outcome> => {
      const locked = await this.lockCard(tx, link.cardId);
      const { card } = locked;
      // Cartão já tratado (recusado ou editado) ou desatualizado: o mesmo código estável, e a mensagem pública (`ERROR_CODES.ROUTINE_CHANGED`) cobre os três casos.
      if (card.status === 'refused' || card.status === 'edited' || card.status === 'superseded') throw new DomainError('ROUTINE_CHANGED');
      if (card.status !== 'applied') throw new DomainError('NOT_FOUND');
      if (card.routineId === null) throw new DomainError('ROUTINE_NOT_FOUND');
      if (card.routineId !== id) throw new DomainError('NOT_FOUND');

      const current = await this.lockIfExists(tx, id);
      if (current === null) throw new DomainError('ROUTINE_NOT_FOUND');
      if (current.bot_id !== locked.botId || !stillAsApplied(card, current)) {
        await this.patchCard(tx, locked, { status: 'superseded' }, at);
        return { superseded: true };
      }

      const routine = await this.updateIn(tx, id, input, actor, at);
      await this.patchCard(tx, locked, { status: 'edited' }, at);
      const notice: RoutineEditedCard = { type: 'routine_edited', routineId: routine.id, routineName: routine.name };
      await insertCard(tx, locked.conversationId, notice, { content: editedNotice(routine), at });
      await recordAudit(tx, this.auditOf('routine.card_edited', actor, id, { card: locked.id }), at);
      return { superseded: false, routine };
    });
    if (outcome.superseded) throw new DomainError('ROUTINE_CHANGED');
    return outcome.routine;
  }

  /** O corpo de `update` dentro de uma transação já aberta: a confirmação de uma proposta antiga, a edição pelo cartão, a recusa e o bot o usam. */
  private async updateIn(tx: PoolClient, id: string, input: RoutineReplace, actor: Actor, at: Date): Promise<RoutineView> {
    const current = await this.lock(tx, id);
    const botChanged = input.botId !== current.bot_id;
    if (botChanged) await this.requireActiveBot(tx, input.botId);

    // Mexer na agenda recomeça a contagem do "a cada N minutos" a partir de agora.
    const scheduleChanged =
      canonicalJson(input.schedule) !== canonicalJson(current.schedule) || input.timezone !== current.timezone || input.startsAt !== current.starts_local;
    const plan = this.planFrom(input, scheduleChanged ? at : current.anchor_at);
    const problem = scheduleProblem(plan, at);
    if (problem) throw problemToError(problem);

    let status = current.status;
    let nextRunAt: Date | null = null;
    const botArchived = botChanged ? false : current.bot_archived_at !== null;
    if (status !== 'paused' && !botArchived) {
      const state = schedulingState(plan, { runCount: current.run_count, maxRuns: input.maxRuns }, at);
      status = state.status;
      nextRunAt = state.nextRunAt;
      // Sem mudar a agenda, um horário previsto que já venceu e ainda não foi tratado (o worker estava parado) continua sendo o próximo:
      // recalculá-lo a partir de agora o empurraria para o horário seguinte e a execução sumiria sem registro de `perdida` (R17).
      // O agendador o trata pela regra de sempre (até 60 minutos de atraso dispara, acima disso fica como perdida).
      if (state.status === 'active' && !scheduleChanged && current.status === 'active' && current.next_run_at !== null && current.next_run_at.getTime() <= at.getTime()) {
        nextRunAt = current.next_run_at;
      }
    }
    if (botChanged) await cancelQueuedRoutineRuns(tx, { routineId: id }, at);
    await tx.query(
      `UPDATE routines SET bot_id = $2, name = $3, instruction = $4, schedule = $5, timezone = $6, starts_local = $7, ends_local = $8, max_runs = $9,
              anchor_at = $10, status = $11, next_run_at = $12, updated_at = $13
       WHERE id = $1`,
      [id, input.botId, input.name, input.instruction, JSON.stringify(input.schedule), input.timezone, input.startsAt, input.endsAt, input.maxRuns, plan.anchorAt, status, nextRunAt, at],
    );
    await this.supersedeAppliedCards(tx, id, current.bot_id, at);
    await recordAudit(tx, this.auditOf('routine.update', actor, id, { bot: input.botId }), at);
    return this.getIn(tx, id);
  }

  /** Pausa a rotina e tira da fila o que ainda não começou. Idempotente (pausar uma pausada ou concluída não muda nada). */
  async pause(id: string, origin: RequestOrigin): Promise<RoutineView> {
    const at = this.now();
    return withTransaction(this.pool, (tx) => this.pauseIn(tx, id, { by: 'owner', origin }, at));
  }

  /** O corpo de `pause` dentro de uma transação já aberta (ver `updateIn`). */
  private async pauseIn(tx: PoolClient, id: string, actor: Actor, at: Date): Promise<RoutineView> {
    const current = await this.lock(tx, id);
    if (current.status !== 'active') return toRoutineView(current);
    await tx.query("UPDATE routines SET status = 'paused', next_run_at = NULL, updated_at = $2 WHERE id = $1", [id, at]);
    await cancelQueuedRoutineRuns(tx, { routineId: id }, at);
    await this.supersedeAppliedCards(tx, id, current.bot_id, at);
    await recordAudit(tx, this.auditOf('routine.pause', actor, id), at);
    return this.getIn(tx, id);
  }

  /**
   * Retoma uma rotina pausada: o próximo horário é o primeiro depois de agora (o tempo parado não vira "perdida"). Se a agenda já
   * acabou, a rotina fica concluída. Lança BOT_ARCHIVED enquanto o bot estiver arquivado. Idempotente.
   */
  async resume(id: string, origin: RequestOrigin): Promise<RoutineView> {
    const at = this.now();
    return withTransaction(this.pool, (tx) => this.resumeIn(tx, id, { by: 'owner', origin }, at));
  }

  /** O corpo de `resume` dentro de uma transação já aberta (ver `updateIn`). */
  private async resumeIn(tx: PoolClient, id: string, actor: Actor, at: Date): Promise<RoutineView> {
    const current = await this.lock(tx, id);
    if (current.status !== 'paused') return toRoutineView(current);
    if (current.bot_archived_at !== null) throw new DomainError('BOT_ARCHIVED');
    const state = schedulingState(planOfRow(current), { runCount: current.run_count, maxRuns: current.max_runs }, at);
    await tx.query('UPDATE routines SET status = $2, next_run_at = $3, updated_at = $4 WHERE id = $1', [id, state.status, state.nextRunAt, at]);
    await this.supersedeAppliedCards(tx, id, current.bot_id, at);
    await recordAudit(tx, this.auditOf('routine.resume', actor, id), at);
    return this.getIn(tx, id);
  }

  /**
   * Exclui a rotina e o histórico dela; tira da fila o que não começou. A execução em andamento termina e os cartões ficam, mas passam
   * a ter `routineId` nulo (o contrato dos cartões diz isso): sem isso "Ver rotina" levaria a um 404 e confirmar de novo uma proposta
   * já apagada devolveria ROUTINE_NOT_FOUND (R18). A busca fica nas conversas em que a rotina deixou rastro (a do bot atual e as das
   * execuções dela), e não na tabela inteira de mensagens.
   */
  async remove(id: string, origin: RequestOrigin): Promise<void> {
    const at = this.now();
    await withTransaction(this.pool, (tx) => this.removeIn(tx, id, { by: 'owner', origin }, at));
  }

  /** O corpo de `remove` dentro de uma transação já aberta (ver `updateIn`). Devolve os ids dos cartões que perderam o vínculo (a recusa de uma exclusão os religa). */
  private async removeIn(tx: PoolClient, id: string, actor: Actor, at: Date): Promise<string[]> {
    const current = await this.lock(tx, id);
    await cancelQueuedRoutineRuns(tx, { routineId: id }, at);
    // Os cartões da rotina perdem o vínculo com ela. Uma proposta de alteração antiga ainda pendente nunca mais poderá ser aplicada, então já vira
    // `stale` aqui (e não só no clique do dono, que levaria a um 409); um cartão APLICADO pelo bot vira `superseded` ("mudou depois"). O cartão que
    // está sendo confirmado ou recusado agora também passa por aqui e quem chama o marca com o estado final logo depois.
    const detached = await tx.query<{ id: string; conversation_id: string }>(
      `UPDATE messages SET data = CASE
           WHEN data ->> 'type' = 'routine_change' AND data ->> 'status' = 'pending'
             THEN jsonb_set(jsonb_set(data, '{routineId}', 'null'::jsonb), '{status}', '"stale"'::jsonb)
           WHEN data ->> 'type' IN ('routine_proposal', 'routine_change') AND data ->> 'status' = 'applied'
             THEN jsonb_set(jsonb_set(data, '{routineId}', 'null'::jsonb), '{status}', '"superseded"'::jsonb)
           ELSE jsonb_set(data, '{routineId}', 'null'::jsonb)
         END
       WHERE kind = 'card' AND data ->> 'routineId' = $1::text
         AND conversation_id IN (SELECT conversation_id FROM runs WHERE routine_id = $1::uuid UNION SELECT id FROM conversations WHERE bot_id = $2::uuid)
       RETURNING id::text AS id, conversation_id`,
      [id, current.bot_id],
    );
    for (const card of detached.rows) await recordConversationEvent(tx, card.conversation_id, 'message', card.id, at);
    // A execução em andamento fica sem rotina (o nome dela na hora do disparo continua em `routine_name`).
    await tx.query('UPDATE runs SET routine_id = NULL WHERE routine_id = $1', [id]);
    await tx.query('DELETE FROM routines WHERE id = $1', [id]);
    await recordAudit(tx, this.auditOf('routine.delete', actor, id), at);
    return detached.rows.map((card) => card.id);
  }

  /**
   * "Executar agora": enfileira já uma execução da rotina no bot. Lança RATE_LIMITED (mais de `RUN_NOW_PER_MINUTE` por minuto),
   * ROUTINE_NOT_FOUND, BOT_ARCHIVED, PROVIDER_NOT_CONFIGURED, MODEL_UNAVAILABLE (sem modelo para usar) e QUEUE_FULL.
   */
  async runNow(id: string, origin: RequestOrigin): Promise<RunView> {
    if (!this.credentials) throw new Error('RoutineService sem credenciais: "Executar agora" só existe no serviço da API.');
    this.runNowLimiter.consume();
    const at = this.now();
    const routine = await this.get(id);
    if (routine.bot.archived) throw new DomainError('BOT_ARCHIVED');
    if (!hasModelProvider(await this.credentials.overview())) throw new DomainError('PROVIDER_NOT_CONFIGURED');
    if ((await resolveBotModelChoice(this.pool, routine.bot.id)).model === null) throw new DomainError('MODEL_UNAVAILABLE');

    return withTransaction(this.pool, async (tx) => {
      const current = await this.lock(tx, id);
      const conversation = await tx.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [current.bot_id]);
      const conversationId = (conversation.rows[0] as { id: string }).id;
      const occurrence = await tx.query<{ id: string }>(
        "INSERT INTO routine_occurrences (routine_id, scheduled_for, outcome, manual, created_at) VALUES ($1, $2, 'fired', true, $2) RETURNING id",
        [id, at],
      );
      const run = await queueRun(tx, { botId: current.bot_id, conversationId, input: current.instruction, routine: { id, name: current.name }, at, enforceLimit: true });
      await tx.query('UPDATE routine_occurrences SET run_id = $2 WHERE id = $1', [(occurrence.rows[0] as { id: string }).id, run.id]);
      await recordAudit(tx, this.auditOf('routine.run_now', { by: 'owner', origin }, id, { bot: current.bot_id }), at);
      return toRunView(run);
    });
  }

  /**
   * Confirma uma proposta ANTIGA de alteração de rotina do bot (cartão `routine_change` pendente, T21): aplica a mudança com as MESMAS regras da
   * edição feita pelo dono (agenda validada, fila limpa ao pausar ou excluir) e marca o cartão como confirmado, tudo numa transação. Quem decide o
   * que aplicar é o cartão que o servidor gravou, nunca o navegador: a requisição só diz qual cartão. Idempotente (confirmar de novo devolve o
   * mesmo resultado). Se a rotina foi excluída, trocou de bot ou teve alterado por outro caminho algum campo da proposta, o cartão vira
   * `stale` e a resposta é ROUTINE_CHANGED, sem aplicar nada. Lança NOT_FOUND (a mensagem não é um cartão de alteração pendente: os cartões
   * aplicados pelo bot já valem e só se recusam ou editam) e os erros da própria alteração (SCHEDULE_INVALID, SCHEDULE_IN_PAST, BOT_ARCHIVED ao
   * retomar), que deixam o cartão pendente.
   */
  async confirmChange(messageId: string, origin: RequestOrigin): Promise<RoutineChangeResult> {
    const at = this.now();
    const actor: Actor = { by: 'owner', origin };
    type Outcome = { stale: true } | { stale: false; routine: RoutineView | null };
    const outcome = await withTransaction(this.pool, async (tx): Promise<Outcome> => {
      const found = await tx.query<{ data: unknown; conversation_id: string; bot_id: string | null }>(
        `SELECT m.data, m.conversation_id, c.bot_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = $1 AND m.kind = 'card' AND m.data->>'type' = 'routine_change' FOR UPDATE OF m`,
        [messageId],
      );
      const row = found.rows[0];
      const parsed = row ? routineChangeCardSchema.safeParse(row.data) : null;
      if (!row || !parsed?.success) throw new DomainError('NOT_FOUND');
      const card = parsed.data;
      if (card.status === 'stale') return { stale: true };
      if (card.status === 'confirmed') return { stale: false, routine: card.change.action === 'delete' || card.routineId === null ? null : await this.findIn(tx, card.routineId) };
      if (card.status !== 'pending') throw new DomainError('NOT_FOUND');

      const current = card.routineId === null ? null : await this.lockIfExists(tx, card.routineId);
      if (current === null || current.bot_id !== row.bot_id || (card.change.action === 'update' && differsFromProposal(card.change, current))) {
        await tx.query("UPDATE messages SET data = jsonb_set(data, '{status}', '\"stale\"'::jsonb) WHERE id = $1", [messageId]);
        await recordConversationEvent(tx, row.conversation_id, 'message', messageId, at);
        return { stale: true };
      }

      let routine: RoutineView | null = null;
      switch (card.change.action) {
        case 'update':
          routine = await this.updateIn(tx, current.id, applyChangeSide(card.change, current, 'after'), actor, at);
          break;
        case 'pause':
          routine = await this.pauseIn(tx, current.id, actor, at);
          break;
        case 'resume':
          routine = await this.resumeIn(tx, current.id, actor, at);
          break;
        case 'delete':
          await this.removeIn(tx, current.id, actor, at);
          break;
      }
      await tx.query("UPDATE messages SET data = jsonb_set(data, '{status}', '\"confirmed\"'::jsonb) WHERE id = $1", [messageId]);
      await recordConversationEvent(tx, row.conversation_id, 'message', messageId, at);
      await insertConfirmedCard(tx, row.conversation_id, {
        type: 'routine_confirmed', routineId: routine?.id ?? null, routineName: routine?.name ?? card.routineName, action: card.change.action,
      }, at);
      await recordAudit(tx, this.auditOf('routine.change_confirmed', actor, current.id, { action: card.change.action, proposal: messageId }), at);
      return { stale: false, routine };
    });
    if (outcome.stale) throw new DomainError('ROUTINE_CHANGED');
    return { routine: outcome.routine };
  }

  /**
   * Recusa, pelo cartão, o que o bot aplicou (phase 10, A13 a A15): desfaz na mesma transação e grava o aviso `routine_refused` no fim da conversa.
   * Rotina criada: é excluída; alteração: volta ao estado anterior; pausa: é retomada; retomada: volta a pausar; exclusão: a rotina volta com o
   * mesmo id e o mesmo histórico (`restore`). O dono recusa pelo cartão que o servidor gravou (a requisição só diz qual): o corpo do desfazer
   * nunca vem do navegador. Idempotente (a segunda recusa devolve o mesmo resultado, sem aviso nem efeito). Se a rotina mudou depois do cartão
   * (marca `superseded`, edição pelo cartão ou conferência do estado atual) responde ROUTINE_CHANGED, sem desfazer nada. Lança NOT_FOUND (a
   * mensagem não é um cartão de rotina aplicada pelo bot, nem proposta antiga: essas se confirmam) e os erros do próprio desfazer
   * (SCHEDULE_IN_PAST ao restaurar uma data única que já passou, BOT_ARCHIVED ao retomar).
   */
  async refuse(messageId: string, origin: RequestOrigin): Promise<RoutineChangeResult> {
    const at = this.now();
    const actor: Actor = { by: 'owner', origin };
    type Outcome = { superseded: true } | { superseded: false; routine: RoutineView | null };
    const outcome = await withTransaction(this.pool, async (tx): Promise<Outcome> => {
      const locked = await this.lockCard(tx, messageId);
      const { card } = locked;
      if (card.status === 'refused') return { superseded: false, routine: card.routineId === null ? null : await this.findIn(tx, card.routineId) };
      if (card.status === 'superseded' || card.status === 'edited') return { superseded: true };
      if (card.status !== 'applied') throw new DomainError('NOT_FOUND');

      const action: RoutineAction = card.type === 'routine_proposal' ? 'create' : card.change.action;
      let routine: RoutineView | null = null;
      let routineName = card.type === 'routine_proposal' ? card.proposal.name : card.routineName;
      let restoredCount: number | null = null;

      if (action === 'delete') {
        if (locked.restore === null) throw new DomainError('NOT_FOUND');
        if ((await this.lockIfExists(tx, locked.restore.routine.id)) !== null) return { superseded: true };
        routine = await this.restoreRoutine(tx, locked.restore, at);
        restoredCount = locked.restore.occurrencesTruncated ? locked.restore.occurrences.length : null;
      } else {
        const current = card.routineId === null ? null : await this.lockIfExists(tx, card.routineId);
        if (current === null) throw new DomainError('ROUTINE_NOT_FOUND');
        if (current.bot_id !== locked.botId || !stillAsApplied(card, current)) {
          await this.patchCard(tx, locked, { status: 'superseded' }, at);
          return { superseded: true };
        }
        routineName = current.name;
        if (card.type === 'routine_proposal') await this.removeIn(tx, current.id, actor, at);
        else if (card.change.action === 'update') routine = await this.updateIn(tx, current.id, applyChangeSide(card.change, current, 'before'), actor, at);
        else if (card.change.action === 'pause') routine = await this.resumeIn(tx, current.id, actor, at);
        else routine = await this.pauseIn(tx, current.id, actor, at);
      }

      await this.patchCard(tx, locked, { status: 'refused', routineId: routine?.id ?? null }, at);
      const notice: RoutineRefusedCard = { type: 'routine_refused', routineId: routine?.id ?? null, routineName, action };
      await insertCard(tx, locked.conversationId, notice, { content: refusedNotice(action, routineName, routine?.id ?? null, restoredCount), at });
      await recordAudit(tx, this.auditOf('routine.card_refused', actor, routine?.id ?? (card.routineId ?? locked.restore?.routine.id ?? null), { action, card: locked.id }), at);
      return { superseded: false, routine };
    });
    if (outcome.superseded) throw new DomainError('ROUTINE_CHANGED');
    return { routine: outcome.routine };
  }

  // ---------------------------------------------------------------------------------------------
  // Comandos do bot (phase 10: valem na hora, o dono recusa ou edita pelo cartão)
  // ---------------------------------------------------------------------------------------------

  /**
   * `propose_routine`: cria a rotina ATIVA do bot e grava o cartão "Rotina criada pelo bot" (`applied`), na mesma transação, com a execução que a
   * pediu. Mesmas validações da criação do dono (agenda, fuso, data única no futuro, bot não arquivado): o erro volta como DomainError e nada é gravado.
   * O cartão guarda o estado em que a rotina nasceu (`proposal`), que é o que a conferência de "mudou depois" compara.
   *
   * Repetição sem duplicar (phase 15, A19): se o bot já tem uma rotina com exatamente esta configuração (nome, instrução, agenda, fuso, início, fim e limite) e ela ainda
   * não terminou, devolve essa rotina com `created: false`, sem criar rotina, cartão nem auditoria. É o que cobre a queda do worker entre o commit e o registro do resultado
   * (a execução recomeça e o bot repete a chamada) e a nova tentativa do modelo. Sem coluna nem índice novos: a leitura da rotina idêntica e a criação acontecem sob o
   * travamento da linha do bot (`FOR NO KEY UPDATE`, `requireActiveBot`), então duas chamadas simultâneas se enfileiram no banco e a segunda já enxerga a rotina da primeira.
   * Duas rotinas idênticas do mesmo bot não têm uso (rodariam a mesma instrução no mesmo horário), então reencontrar a existente vale também fora da mesma execução.
   */
  async createByBot(scope: BotRoutineScope, input: RoutineScheduleSettings & { name: string; instruction: string }): Promise<{ routine: RoutineView; created: boolean }> {
    const at = this.now();
    const actor: Actor = { by: 'bot', botId: scope.botId, runId: scope.runId };
    return withTransaction(this.pool, async (tx) => {
      await this.requireActiveBot(tx, scope.botId, true);
      const existing = await this.findIdentical(tx, scope.botId, input);
      if (existing) return { routine: existing, created: false };
      const id = await this.insertRoutine(tx, { ...input, botId: scope.botId }, at);
      const row = await this.lock(tx, id);
      const routine = toRoutineView(row);
      const card: RoutineProposalCard = {
        type: 'routine_proposal',
        proposal: { name: input.name, instruction: input.instruction, schedule: input.schedule, timezone: input.timezone, startsAt: input.startsAt, endsAt: input.endsAt, maxRuns: input.maxRuns },
        summary: routine.summary,
        nextRuns: occurrencesAfter(planOfRow(row), at, ROUTINE_PREVIEW_COUNT).map((date) => date.toISOString()),
        status: 'applied',
        routineId: id,
      };
      await insertCard(tx, scope.conversationId, card, { runId: scope.runId, at });
      await recordAudit(tx, this.auditOf('routine.create', actor, id), at);
      return { routine, created: true };
    });
  }

  /** A rotina não concluída do bot com exatamente esta configuração (a mais antiga), ou nulo. A agenda compara como jsonb, então a ordem das chaves não importa. */
  private async findIdentical(tx: PoolClient, botId: string, input: RoutineScheduleSettings & { name: string; instruction: string }): Promise<RoutineView | null> {
    const found = await tx.query<RoutineRow>(
      `SELECT ${ROUTINE_SELECT} FROM routines r JOIN bots b ON b.id = r.bot_id
       WHERE r.bot_id = $1 AND r.name = $2 AND r.instruction = $3 AND r.schedule = $4::jsonb AND r.timezone = $5
         AND r.starts_local IS NOT DISTINCT FROM $6 AND r.ends_local IS NOT DISTINCT FROM $7 AND r.max_runs IS NOT DISTINCT FROM $8 AND r.status <> 'completed'
       ORDER BY r.created_at, r.id LIMIT 1`,
      [botId, input.name, input.instruction, JSON.stringify(input.schedule), input.timezone, input.startsAt, input.endsAt, input.maxRuns],
    );
    const row = found.rows[0];
    return row ? toRoutineView(row) : null;
  }

  /**
   * `propose_routine_change`: aplica NA HORA mudar, pausar, retomar ou excluir uma rotina do bot e grava o cartão de alteração (`applied`) com o que
   * mudou, na mesma transação. Só rotina do próprio bot (outra é ROUTINE_NOT_FOUND, sem revelar que existe). Guarda o estado anterior antes de
   * aplicar: `before` no cartão (mudar) ou o instantâneo do servidor (excluir), de onde a recusa desfaz. Lança ROUTINE_CHANGED quando a rotina já
   * não está no estado que a ação supõe (pausar uma não ativa, retomar uma não pausada) e VALIDATION_FAILED quando "mudar" não mudaria nada, além
   * dos erros da própria alteração (SCHEDULE_INVALID, SCHEDULE_IN_PAST, BOT_ARCHIVED ao retomar).
   */
  async applyChangeByBot(scope: BotRoutineScope, routineId: string, change: BotRoutineChange): Promise<BotChangeResult> {
    const at = this.now();
    const actor: Actor = { by: 'bot', botId: scope.botId, runId: scope.runId };
    return withTransaction(this.pool, async (tx) => {
      const current = await this.lockIfExists(tx, routineId);
      if (current === null || current.bot_id !== scope.botId) throw new DomainError('ROUTINE_NOT_FOUND');
      const before = toRoutineView(current);
      let routine: RoutineView | null = null;
      let changed: RoutineChangeField[] = [];
      let cardChange: RoutineChangeCard['change'];
      let restore: RestoreSnapshot | null = null;

      switch (change.action) {
        case 'update': {
          const merged = withFields(current, change.fields);
          changed = ROUTINE_CHANGE_FIELDS.filter((field) => canonicalJson(merged[field]) !== canonicalJson(currentValueOf(current, field)));
          if (changed.length === 0) throw new DomainError('VALIDATION_FAILED');
          routine = await this.updateIn(tx, routineId, merged, actor, at);
          const after = await this.lock(tx, routineId);
          cardChange = {
            action: 'update',
            before: snapshotOf(before),
            after: snapshotOf(routine),
            changed,
            // Rotina pausada continua pausada depois da alteração: as datas que o cartão mostraria não aconteceriam, então não vão no cartão.
            nextRuns: routine.status === 'paused' ? [] : occurrencesAfter(planOfRow(after), at, ROUTINE_PREVIEW_COUNT).map((date) => date.toISOString()),
          };
          break;
        }
        case 'pause':
          if (current.status !== 'active') throw new DomainError('ROUTINE_CHANGED');
          routine = await this.pauseIn(tx, routineId, actor, at);
          cardChange = { action: 'pause' };
          break;
        case 'resume':
          if (current.status !== 'paused') throw new DomainError('ROUTINE_CHANGED');
          routine = await this.resumeIn(tx, routineId, actor, at);
          cardChange = { action: 'resume' };
          break;
        case 'delete': {
          const snapshot = await this.captureRestore(tx, current);
          const cardIds = await this.removeIn(tx, routineId, actor, at);
          restore = { ...snapshot, cardIds: newestIds(cardIds, this.restoreMax) };
          cardChange = { action: 'delete' };
          break;
        }
      }

      const card: RoutineChangeCard = { type: 'routine_change', routineId: routine === null ? null : routineId, routineName: before.name, change: cardChange, status: 'applied' };
      // `restore` só existe na exclusão e fica fora do contrato do cartão (ver `restoreSchema`).
      await insertCard(tx, scope.conversationId, restore === null ? card : { ...card, restore }, { runId: scope.runId, at });
      return { routine, changed };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Apoio
  // ---------------------------------------------------------------------------------------------

  /** Monta o plano de cálculo (agenda, fuso, período) a partir das configurações; `anchorAt` é de onde a contagem do "a cada N" parte. */
  private planFrom(settings: Pick<RoutineScheduleSettings, 'schedule' | 'timezone' | 'startsAt' | 'endsAt'>, anchorAt: Date): SchedulePlan {
    return { schedule: settings.schedule, timezone: settings.timezone, startsAt: settings.startsAt, endsAt: settings.endsAt, anchorAt };
  }

  /**
   * Valida a agenda e insere a rotina ativa (com o próximo horário calculado), na transação dada; devolve o id. Corpo comum da criação do dono e da
   * criação pelo bot. Lança SCHEDULE_INVALID ou SCHEDULE_IN_PAST.
   */
  private async insertRoutine(tx: PoolClient, input: Omit<RoutineInput, 'proposalMessageId'>, at: Date): Promise<string> {
    const plan = this.planFrom(input, at);
    const problem = scheduleProblem(plan, at);
    if (problem) throw problemToError(problem);
    const state = schedulingState(plan, { runCount: 0, maxRuns: input.maxRuns }, at);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO routines (bot_id, name, instruction, schedule, timezone, starts_local, ends_local, max_runs, anchor_at, status, next_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $9, $9) RETURNING id`,
      [input.botId, input.name, input.instruction, JSON.stringify(input.schedule), input.timezone, input.startsAt, input.endsAt, input.maxRuns, at, state.status, state.nextRunAt],
    );
    return (inserted.rows[0] as { id: string }).id;
  }

  /** Lê a rotina travando a linha até o fim da transação (edições, pausas e disparos da mesma rotina esperam). Nulo se ela não existe. */
  private async lockIfExists(tx: PoolClient, id: string): Promise<RoutineRow | null> {
    const found = await tx.query<RoutineRow>(
      `SELECT ${ROUTINE_SELECT} FROM routines r JOIN bots b ON b.id = r.bot_id WHERE r.id = $1 FOR UPDATE OF r`,
      [id],
    );
    return found.rows[0] ?? null;
  }

  /** `lockIfExists` que lança ROUTINE_NOT_FOUND quando a rotina não existe. */
  private async lock(tx: PoolClient, id: string): Promise<RoutineRow> {
    const row = await this.lockIfExists(tx, id);
    if (!row) throw new DomainError('ROUTINE_NOT_FOUND');
    return row;
  }

  /** A rotina como `get` a devolve, lida dentro da transação dada: o estado já traz as mudanças feitas nela. */
  private async getIn(tx: PoolClient, id: string): Promise<RoutineView> {
    const found = await tx.query<RoutineRow>(`SELECT ${ROUTINE_SELECT} FROM routines r JOIN bots b ON b.id = r.bot_id WHERE r.id = $1`, [id]);
    const row = found.rows[0];
    if (!row) throw new DomainError('ROUTINE_NOT_FOUND');
    return toRoutineView(row);
  }

  /** A rotina lida dentro da transação dada, ou nulo se não existe (a confirmação de uma proposta não pode lançar no meio do caminho). */
  private async findIn(tx: PoolClient, id: string): Promise<RoutineView | null> {
    const found = await tx.query<RoutineRow>(`SELECT ${ROUTINE_SELECT} FROM routines r JOIN bots b ON b.id = r.bot_id WHERE r.id = $1`, [id]);
    const row = found.rows[0];
    return row ? toRoutineView(row) : null;
  }

  /**
   * Trava para escrita o cartão de rotina (criada ou alteração) da mensagem dada. Lança NOT_FOUND se a mensagem não é um cartão desses (ou se não
   * está numa conversa de bot): é a única porta dos cartões para recusar e editar, então um id de outra mensagem nunca alcança nada. A ordem de
   * trava do sistema é cartão e depois rotina.
   */
  private async lockCard(tx: PoolClient, messageId: string): Promise<LockedCard> {
    const found = await tx.query<{ id: string; data: Record<string, unknown>; conversation_id: string; bot_id: string | null }>(
      `SELECT m.id::text AS id, m.data, m.conversation_id, c.bot_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = $1 AND m.kind = 'card' AND m.data->>'type' IN ('routine_proposal', 'routine_change') FOR UPDATE OF m`,
      [messageId],
    );
    const row = found.rows[0];
    const parsed = row ? routineCardSchema.safeParse(row.data) : null;
    if (!row || row.bot_id === null || !parsed?.success) throw new DomainError('NOT_FOUND');
    const restore = restoreSchema.safeParse(row.data.restore);
    return { id: row.id, conversationId: row.conversation_id, botId: row.bot_id, card: parsed.data, restore: restore.success ? restore.data : null };
  }

  /** Muda campos do cartão (o estado, o vínculo) e avisa a conversa pelo SSE. O instantâneo de exclusão sai: depois de recusado, não serve mais. */
  private async patchCard(tx: PoolClient, locked: LockedCard, patch: { status: RoutineCard['status']; routineId?: string | null }, at: Date): Promise<void> {
    await tx.query("UPDATE messages SET data = (data - 'restore') || $2::jsonb WHERE id = $1", [locked.id, JSON.stringify(patch)]);
    await recordConversationEvent(tx, locked.conversationId, 'message', locked.id, at);
  }

  /**
   * A rotina mudou: os cartões APLICADOS dela (criada ou alterada pelo bot) viram `superseded` ("mudou depois"), na mesma transação. Quem decide o
   * estado final do cartão que gerou a mudança (recusado, editado) o grava depois. A busca fica na conversa do bot dono, como a de `removeIn`.
   * ponytail: varre as mensagens de cartão da conversa do bot a cada alteração; indexar `data->>'routineId'` se a conversa passar de algumas centenas
   * de milhares de linhas. Pausa por arquivamento do bot e pausa automática do agendador não passam por aqui (`stillAsApplied` as pega no clique).
   */
  private async supersedeAppliedCards(tx: PoolClient, routineId: string, botId: string, at: Date): Promise<void> {
    const marked = await tx.query<{ id: string; conversation_id: string }>(
      `UPDATE messages SET data = jsonb_set(data, '{status}', '"superseded"'::jsonb)
       WHERE kind = 'card' AND data ->> 'type' IN ('routine_proposal', 'routine_change') AND data ->> 'status' = 'applied' AND data ->> 'routineId' = $1::text
         AND conversation_id IN (SELECT id FROM conversations WHERE bot_id = $2::uuid)
       RETURNING id::text AS id, conversation_id`,
      [routineId, botId],
    );
    for (const card of marked.rows) await recordConversationEvent(tx, card.conversation_id, 'message', card.id, at);
  }

  /** O bot existe e não está arquivado? Trava a linha do bot, então arquivar não corre ao lado de uma criação. */
  private async requireActiveBot(tx: PoolClient, botId: string, serialize = false): Promise<void> {
    // `serialize` (criação pelo bot): `FOR NO KEY UPDATE` enfileira os criadores do mesmo bot (conflita consigo mesmo) sem bloquear a chave estrangeira das rotinas.
    const found = await tx.query<{ archived_at: Date | null }>(`SELECT archived_at FROM bots WHERE id = $1 ${serialize ? 'FOR NO KEY UPDATE' : 'FOR SHARE'}`, [botId]);
    const row = found.rows[0];
    if (!row) throw new DomainError('BOT_NOT_FOUND');
    if (row.archived_at !== null) throw new DomainError('BOT_ARCHIVED');
  }

  /**
   * Guarda, antes de a exclusão apagar, o que a recusa precisa para trazer a rotina de volta (ver `restoreSchema`): a linha da rotina, as ocorrências
   * (as `restoreMax` mais recentes) e as execuções que essas ocorrências apontam. As execuções vêm das ocorrências guardadas, e não de uma busca por
   * `runs.routine_id`, para o instantâneo ter um teto só e o histórico restaurado ficar coerente: execução cuja ocorrência foi cortada não volta. Os cartões
   * que perdem o vínculo entram depois, pelo retorno de `removeIn`.
   */
  private async captureRestore(tx: PoolClient, row: RoutineRow): Promise<Omit<RestoreSnapshot, 'cardIds'>> {
    const occurrences = await tx.query<{ scheduled_for: Date; outcome: 'fired' | 'missed' | 'skipped'; manual: boolean; run_id: string | null; message_id: string | null; created_at: Date }>(
      `SELECT scheduled_for, outcome, manual, run_id::text AS run_id, message_id::text AS message_id, created_at
       FROM routine_occurrences WHERE routine_id = $1 ORDER BY id DESC LIMIT $2`,
      [row.id, this.restoreMax + 1],
    );
    const kept = occurrences.rows.slice(0, this.restoreMax).reverse();
    return {
      routine: {
        id: row.id,
        botId: row.bot_id,
        name: row.name,
        instruction: row.instruction,
        schedule: row.schedule,
        timezone: row.timezone,
        startsLocal: row.starts_local,
        endsLocal: row.ends_local,
        maxRuns: row.max_runs,
        anchorAt: row.anchor_at.toISOString(),
        status: row.status,
        runCount: row.run_count,
        createdAt: row.created_at.toISOString(),
      },
      occurrences: kept.map((occurrence) => [occurrence.scheduled_for.toISOString(), occurrence.outcome, occurrence.manual, occurrence.run_id, occurrence.message_id, occurrence.created_at.toISOString()]),
      occurrencesTruncated: occurrences.rows.length > this.restoreMax,
      runIds: kept.flatMap((occurrence) => (occurrence.run_id === null ? [] : [occurrence.run_id])),
    };
  }

  /**
   * Recria a rotina excluída pelo bot com o MESMO id e religa o histórico: ocorrências (na ordem original), execuções (`runs.routine_id`) e cartões da
   * conversa (`routineId`). Uma execução ou mensagem que não existe mais é simplesmente deixada de fora (a restauração nunca falha por referência
   * perdida). A rotina ativa recalcula o próximo horário a partir de agora, como `resumeIn` (o tempo excluído não vira "perdida"), e volta pausada se o bot
   * foi arquivado desde então. Pausada e concluída voltam como estavam. O contador de execuções e a âncora da agenda são preservados.
   */
  private async restoreRoutine(tx: PoolClient, restore: RestoreSnapshot, at: Date): Promise<RoutineView> {
    const saved = restore.routine;
    const bot = await tx.query<{ archived_at: Date | null }>('SELECT archived_at FROM bots WHERE id = $1 FOR SHARE', [saved.botId]);
    if (!bot.rows[0]) throw new DomainError('BOT_NOT_FOUND');
    let status = saved.status;
    let nextRunAt: Date | null = null;
    if (status === 'active') {
      if (bot.rows[0].archived_at !== null) {
        status = 'paused';
      } else {
        const plan = { schedule: saved.schedule, timezone: saved.timezone, startsAt: saved.startsLocal, endsAt: saved.endsLocal, anchorAt: new Date(saved.anchorAt) };
        const state = schedulingState(plan, { runCount: saved.runCount, maxRuns: saved.maxRuns }, at);
        status = state.status;
        nextRunAt = state.nextRunAt;
      }
    }
    await tx.query(
      `INSERT INTO routines (id, bot_id, name, instruction, schedule, timezone, starts_local, ends_local, max_runs, anchor_at, status, run_count, next_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [saved.id, saved.botId, saved.name, saved.instruction, JSON.stringify(saved.schedule), saved.timezone, saved.startsLocal, saved.endsLocal, saved.maxRuns, saved.anchorAt, status, saved.runCount, nextRunAt, saved.createdAt, at],
    );
    if (restore.occurrences.length > 0) {
      const column = <T>(index: number): T[] => restore.occurrences.map((occurrence) => occurrence[index] as T);
      // LEFT JOIN: execução ou cartão que sumiu desde a exclusão vira nulo em vez de derrubar a recusa.
      await tx.query(
        `INSERT INTO routine_occurrences (routine_id, scheduled_for, outcome, manual, run_id, message_id, created_at)
         SELECT $1::uuid, t.scheduled_for, t.outcome, t.manual, r.id, m.id, t.created_at
         FROM unnest($2::timestamptz[], $3::text[], $4::boolean[], $5::bigint[], $6::bigint[], $7::timestamptz[])
           WITH ORDINALITY AS t(scheduled_for, outcome, manual, run_id, message_id, created_at, position)
         LEFT JOIN runs r ON r.id = t.run_id LEFT JOIN messages m ON m.id = t.message_id
         ORDER BY t.position`,
        [saved.id, column(0), column(1), column(2), column(3), column(4), column(5)],
      );
    }
    await tx.query('UPDATE runs SET routine_id = $1 WHERE routine_id IS NULL AND id = ANY($2::bigint[])', [saved.id, restore.runIds]);
    const relinked = await tx.query<{ id: string; conversation_id: string }>(
      `UPDATE messages SET data = jsonb_set(data, '{routineId}', to_jsonb($1::text))
       WHERE id = ANY($2::bigint[]) AND kind = 'card' AND data -> 'routineId' = 'null'::jsonb
       RETURNING id::text AS id, conversation_id`,
      [saved.id, restore.cardIds],
    );
    for (const card of relinked.rows) await recordConversationEvent(tx, card.conversation_id, 'message', card.id, at);
    return this.getIn(tx, saved.id);
  }

  /**
   * Cartão de proposta antiga do bot indicado. Se já foi confirmado, devolve a rotina criada (confirmar duas vezes nunca duplica); se o
   * cartão não existe, é de outro bot ou não é uma proposta pendente (os cartões da rotina que o bot criou já valem e se recusam ou editam),
   * NOT_FOUND (sem IDOR entre bots).
   */
  private async confirmedProposal(tx: PoolClient, botId: string, messageId: string): Promise<RoutineView | null> {
    const found = await tx.query<{ data: { status: RoutineProposalCard['status']; routineId: string | null } }>(
      `SELECT m.data FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = $1 AND c.bot_id = $2 AND m.kind = 'card' AND m.data->>'type' = 'routine_proposal' FOR UPDATE OF m`,
      [messageId, botId],
    );
    const card = found.rows[0];
    if (!card) throw new DomainError('NOT_FOUND');
    if (card.data.status === 'pending') return null;
    if (card.data.status !== 'confirmed') throw new DomainError('NOT_FOUND');
    if (card.data.routineId === null) throw new DomainError('ROUTINE_NOT_FOUND');
    return this.getIn(tx, card.data.routineId);
  }

  /**
   * Marca o cartão de proposta como confirmado e o liga à rotina criada, avisando a conversa pelo SSE, e grava o aviso que conta ao bot. O nome é o
   * da rotina criada, não o da proposta: pelo "Editar" o dono pode ter mudado o nome antes de confirmar.
   */
  private async markProposalConfirmed(tx: PoolClient, messageId: string, routine: { id: string; name: string }, at: Date): Promise<void> {
    const updated = await tx.query<{ conversation_id: string }>(
      `UPDATE messages SET data = data || $2::jsonb WHERE id = $1 RETURNING conversation_id`,
      [messageId, JSON.stringify({ status: 'confirmed', routineId: routine.id })],
    );
    const conversationId = updated.rows[0]?.conversation_id;
    if (!conversationId) return;
    await recordConversationEvent(tx, conversationId, 'message', messageId, at);
    await insertConfirmedCard(tx, conversationId, { type: 'routine_confirmed', routineId: routine.id, routineName: routine.name, action: 'create' }, at);
  }

  /**
   * Evento de auditoria de uma ação sobre a rotina: só ids e o bot, nunca o texto da instrução. O dono grava `owner` com a origem da requisição; o bot
   * grava `system` com o bot, a execução e a origem `bot` (D3), porque quem agiu foi a ferramenta e não uma sessão do dono.
   */
  private auditOf(action: string, actor: Actor, target: string | null, details?: AuditEvent['details']): AuditEvent {
    if (actor.by === 'bot') return { action, outcome: 'success', actor: 'system', target, details: { ...details, bot: actor.botId, origin: 'bot', run: actor.runId } };
    return { action, outcome: 'success', actor: 'owner', ip: actor.origin.ip, userAgent: actor.origin.userAgent, target, details };
  }
}
