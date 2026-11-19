// Contratos das rotinas agendadas (F12 criar e gerir, F13 execução; T9) compartilhados entre a API, o core e a web.
//
// Modelo (SCHED-01): uma rotina diz "este bot executa esta instrução nesta agenda". A agenda é guardada como DEFINIÇÃO ESTRUTURADA
// (`scheduleDefinitionSchema`: tipo e campos, exatamente o que o editor monta) mais fuso, início, fim e limite de execuções; o
// core gera dela as datas (rrule para os padrões de calendário, cron no modo avançado). Guardar a definição, e não o texto do
// rrule, é o que deixa o editor reabrir a rotina como ela foi montada e a descrição legível sempre coerente com o que roda.
//
// Horários locais: hora do dia (`HH:mm`), data e hora únicas, início e fim são HORÁRIO DE PAREDE no fuso da rotina, não instantes. É
// a forma natural de uma recorrência ("todo dia às 07:00 em Brasília") e a que o editor entrega sem depender do fuso do navegador.
// Só os instantes calculados (próxima execução, prévia, histórico) trafegam em UTC.
//
// Este arquivo não importa `conversation.ts` (que importa este, por causa dos cartões): ids em texto usam a mesma regra local.
import { z } from 'zod';
import { CONTROL_CHARS_EXCEPT_WHITESPACE } from './bots';

export const ROUTINE_NAME_MAX = 80;
export const ROUTINE_INSTRUCTION_MAX = 4000;
/** Intervalo mínimo de "a cada N minutos" (spec decisão 15). */
export const ROUTINE_MIN_INTERVAL_MINUTES = 5;
/** Limite de execuções de uma rotina (spec F12: de 1 a 10.000). */
export const ROUTINE_MAX_RUNS_LIMIT = 10_000;
/** Quantas próximas execuções a prévia e o cartão de proposta mostram. */
export const ROUTINE_PREVIEW_COUNT = 5;
/** Atraso até o qual uma execução perdida ainda roda, uma vez (spec decisão 15); acima disso é registrada como `perdida`. */
export const ROUTINE_CATCH_UP_MS = 60 * 60_000;
export const DEFAULT_ROUTINE_TIMEZONE = 'America/Sao_Paulo';
/** Itens por página do histórico de uma rotina. */
export const ROUTINE_HISTORY_PAGE_SIZE = 50;

/** Dias da semana como no iCalendar (RFC 5545): a semana começa na segunda. */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const weekdaySchema = z.enum(WEEKDAYS);

/** A posição do "Na [primeira...última] [dia da semana]" do tipo mensal por posição. */
export const MONTH_POSITIONS = ['first', 'second', 'third', 'fourth', 'last'] as const;
export type MonthPosition = (typeof MONTH_POSITIONS)[number];

const idText = z.string().regex(/^\d{1,18}$/);

// ---------------------------------------------------------------------------------------------
// Horários locais
// ---------------------------------------------------------------------------------------------

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d$/;

/** Hora do dia `HH:mm`. */
export const localTimeSchema = z.string().regex(TIME_PATTERN);

/** A data do texto existe no calendário (31/02 não existe)? */
function isRealDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Data e hora `YYYY-MM-DDTHH:mm` sem fuso: o horário de parede no fuso da rotina. */
export const localDateTimeSchema = z.string().refine((value) => {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value);
  return match !== null && isRealDate(Number(match[1]), Number(match[2]), Number(match[3]));
});

const isUnique = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;

const timesSchema = z.array(localTimeSchema).min(1).max(24).refine(isUnique);

// ---------------------------------------------------------------------------------------------
// Definição da agenda
// ---------------------------------------------------------------------------------------------

/**
 * Os tipos de agenda do editor (design: Única, Intervalo, Diária, Semanal, Mensal, Anual, Cron). O mensal tem duas formas (por dia
 * ou por posição) e por isso dois tipos aqui; a tela mostra um segmento só.
 *
 * Aqui só a FORMA e as faixas óbvias. As regras com mensagem legível (intervalo mínimo de 5 minutos, janela com início antes do fim,
 * cron válido, data única no futuro) são do core, que as devolve como `SCHEDULE_INVALID` com o motivo, também na prévia.
 */
export const scheduleDefinitionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('once'), at: localDateTimeSchema }),
  z.strictObject({
    type: z.literal('interval'),
    every: z.number().int().min(1).max(10_080),
    unit: z.enum(['minutes', 'hours']),
    /** Janela diária opcional: só dispara entre `from` e `to`, recomeçando a cada dia em `from`. */
    window: z.strictObject({ from: localTimeSchema, to: localTimeSchema }).nullable(),
  }),
  z.strictObject({ type: z.literal('daily'), times: timesSchema }),
  z.strictObject({ type: z.literal('weekly'), days: z.array(weekdaySchema).min(1).max(7).refine(isUnique), times: timesSchema }),
  z.strictObject({ type: z.literal('monthly_day'), day: z.union([z.number().int().min(1).max(31), z.literal('last')]), time: localTimeSchema }),
  z.strictObject({ type: z.literal('monthly_business_day'), position: z.union([z.number().int().min(1).max(20), z.literal('last')]), time: localTimeSchema }),
  z.strictObject({ type: z.literal('monthly_position'), position: z.enum(MONTH_POSITIONS), weekday: weekdaySchema, time: localTimeSchema }),
  z.strictObject({ type: z.literal('yearly'), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31), time: localTimeSchema }),
  z.strictObject({ type: z.literal('cron'), expression: z.string().trim().min(1).max(120) }),
]);
export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>;
export type ScheduleType = ScheduleDefinition['type'];

/** Identificador IANA (`America/Sao_Paulo`, `UTC`). A existência no banco de fusos é conferida pelo core. */
export const timezoneSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/);

/** Tudo que define QUANDO a rotina executa: a agenda, o fuso, o início e o fim opcionais e o limite de execuções. */
export const routineScheduleSettingsSchema = z.strictObject({
  schedule: scheduleDefinitionSchema,
  timezone: timezoneSchema,
  startsAt: localDateTimeSchema.nullable(),
  endsAt: localDateTimeSchema.nullable(),
  maxRuns: z.number().int().min(1).max(ROUTINE_MAX_RUNS_LIMIT).nullable(),
});
export type RoutineScheduleSettings = z.infer<typeof routineScheduleSettingsSchema>;

const trimmedText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_CHARS_EXCEPT_WHITESPACE.test(value));

export const routineNameSchema = trimmedText(ROUTINE_NAME_MAX);
export const routineInstructionSchema = trimmedText(ROUTINE_INSTRUCTION_MAX);

/** Criação: a agenda mais nome, bot e instrução. `proposalMessageId` liga a criação ao cartão de proposta de um bot (F12 passo 3). */
export const routineInputSchema = routineScheduleSettingsSchema.extend({
  name: routineNameSchema,
  botId: z.uuid(),
  instruction: routineInstructionSchema,
  proposalMessageId: idText.optional(),
});
export type RoutineInput = z.infer<typeof routineInputSchema>;

/** Edição: substitui os mesmos campos da criação (o editor sempre envia a rotina inteira). */
export const routineReplaceSchema = routineInputSchema.omit({ proposalMessageId: true });
export type RoutineReplace = z.infer<typeof routineReplaceSchema>;

export const routineIdParamsSchema = z.strictObject({ id: z.uuid() });

// ---------------------------------------------------------------------------------------------
// Visões
// ---------------------------------------------------------------------------------------------

export const ROUTINE_STATUSES = ['active', 'paused', 'completed'] as const;
export const routineStatusSchema = z.enum(ROUTINE_STATUSES);
export type RoutineStatus = z.infer<typeof routineStatusSchema>;

export const ROUTINE_STATUS_LABELS: Record<RoutineStatus, string> = { active: 'Ativa', paused: 'Pausada', completed: 'Concluída' };

export const routineViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** O bot da rotina: `color` desenha a Faísca parada do seletor do editor. */
  bot: z.object({ id: z.uuid(), name: z.string(), color: z.string(), archived: z.boolean() }),
  instruction: z.string(),
  schedule: scheduleDefinitionSchema,
  timezone: z.string(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  maxRuns: z.number().int().nullable(),
  /** Execuções já disparadas (conta para o limite). */
  runCount: z.number().int().nonnegative(),
  status: routineStatusSchema,
  /** Agenda legível ("Dias úteis às 07:00"). */
  summary: z.string(),
  nextRunAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RoutineView = z.infer<typeof routineViewSchema>;

export const routineListSchema = z.object({ routines: z.array(routineViewSchema) });
export type RoutineList = z.infer<typeof routineListSchema>;

/** Prévia das próximas execuções (F12 passo 1). Agenda inválida não é erro HTTP: volta `valid: false` com o motivo para a tela mostrar. */
export const routinePreviewSchema = z.object({
  valid: z.boolean(),
  /** Motivo legível quando `valid` é falso. */
  reason: z.string().nullable(),
  /** Agenda legível, quando válida. */
  description: z.string().nullable(),
  occurrences: z.array(z.iso.datetime()),
});
export type RoutinePreview = z.infer<typeof routinePreviewSchema>;

/** Estado de uma linha do histórico: o da execução, ou `missed` (perdida) e `skipped` (pulada) quando nunca executou. */
export const ROUTINE_HISTORY_STATES = [
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'interrupted',
  'limit_reached',
  'expired',
  'cancelled',
  'missed',
  'skipped',
] as const;
export const routineHistoryStateSchema = z.enum(ROUTINE_HISTORY_STATES);
export type RoutineHistoryState = z.infer<typeof routineHistoryStateSchema>;

export const ROUTINE_HISTORY_LABELS: Record<RoutineHistoryState, string> = {
  queued: 'Na fila',
  running: 'Em execução',
  waiting_approval: 'Aguardando aprovação',
  completed: 'Concluída',
  failed: 'Falhou',
  interrupted: 'Interrompida',
  limit_reached: 'Limite atingido',
  expired: 'Expirada',
  cancelled: 'Cancelada',
  missed: 'Perdida',
  skipped: 'Pulada',
};

export const routineHistoryItemSchema = z.object({
  id: idText,
  scheduledFor: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  state: routineHistoryStateSchema,
  /** Disparada por "Executar agora" (e não pela agenda). */
  manual: z.boolean(),
  /** Mensagem (cartão) da conversa do bot que conta esta execução; leva ao link "Ver na conversa". */
  messageId: idText.nullable(),
});
export type RoutineHistoryItem = z.infer<typeof routineHistoryItemSchema>;

export const routineHistorySchema = z.object({ items: z.array(routineHistoryItemSchema), nextCursor: idText.nullable() });
export type RoutineHistory = z.infer<typeof routineHistorySchema>;

export const routineHistoryQuerySchema = z.strictObject({ cursor: idText.optional() });

// ---------------------------------------------------------------------------------------------
// Cartões da conversa (membros de `systemCardSchema`)
// ---------------------------------------------------------------------------------------------

/**
 * "Rotina <nome> iniciada/concluída/falhou" (F13): um cartão por execução, criado quando ela COMEÇA e atualizado quando termina.
 * `routineId` fica nulo se a rotina foi excluída depois. O cartão NÃO leva o texto final do bot: ele já é a mensagem do bot logo abaixo
 * do cartão, e copiá-lo aqui mostrava o resultado duas vezes na conversa (T20).
 */
export const routineRunCardSchema = z.object({
  type: z.literal('routine_run'),
  routineId: z.uuid().nullable(),
  routineName: z.string(),
  scheduledFor: z.iso.datetime(),
  startedAt: z.iso.datetime(),
  manual: z.boolean(),
  state: z.enum(['running', 'completed', 'failed', 'interrupted', 'limit_reached', 'expired']),
  finishedAt: z.iso.datetime().nullable(),
  failureCode: z.string().nullable(),
});
export type RoutineRunCard = z.infer<typeof routineRunCardSchema>;

/** "Rotina <nome> perdida" (F13 passo 3): o horário passou com o serviço parado há mais de 60 minutos e a execução não rodou. */
export const routineMissedCardSchema = z.object({
  type: z.literal('routine_missed'),
  routineId: z.uuid().nullable(),
  routineName: z.string(),
  scheduledFor: z.iso.datetime(),
});
export type RoutineMissedCard = z.infer<typeof routineMissedCardSchema>;

/** A rotina que o bot propôs (os mesmos campos do editor), antes de o dono confirmar. */
export const routineProposalSchema = routineScheduleSettingsSchema.extend({
  name: z.string(),
  instruction: z.string(),
});
export type RoutineProposal = z.infer<typeof routineProposalSchema>;

/**
 * Estado dos cartões `routine_proposal` e `routine_change`, que têm dois fluxos de vida (phase 10, SEC-03 substituída):
 * - PROPOSTA ANTIGA (criada antes da phase 10, o dono confirma no cartão): `pending` (aguarda o dono), `confirmed` (foi aplicada) e `stale`
 *   (só em `routine_change`: a rotina mudou ou sumiu antes da confirmação, nada foi aplicado). Convivem com o botão Confirmar.
 * - APLICADA PELO BOT (a rotina ou a alteração já valeu quando o cartão nasceu; o dono pode recusar ou editar): `applied` (em vigor, com
 *   Recusar e Editar), `refused` (o dono recusou e o servidor desfez), `edited` (o dono editou pelo cartão e a rotina passou a ser dele) e
 *   `superseded` (a rotina mudou depois do cartão, por outro caminho: Recusar e Editar ficam indisponíveis, "A rotina mudou depois desta proposta").
 * Os dois conjuntos nunca se misturam num mesmo cartão: é pelo estado que a tela escolhe o desenho (Confirmar ou Recusar e Editar).
 */
export const ROUTINE_CARD_STATUSES = ['pending', 'confirmed', 'stale', 'applied', 'refused', 'edited', 'superseded'] as const;
export const routineCardStatusSchema = z.enum(ROUTINE_CARD_STATUSES);
export type RoutineCardStatus = z.infer<typeof routineCardStatusSchema>;

/**
 * "Proposta de rotina" (proposta antiga: Confirmar e Editar) e "Rotina criada pelo bot" (`status: applied`, `refused`, `edited` ou `superseded`).
 * No fluxo novo `proposal` é o estado em que a rotina nasceu (o que o servidor compara para saber se ela mudou depois) e `routineId` aponta
 * a rotina criada (nulo depois de recusada). Agenda legível, fuso e próximas 5 datas valem nos dois fluxos.
 */
export const routineProposalCardSchema = z.object({
  type: z.literal('routine_proposal'),
  proposal: routineProposalSchema,
  summary: z.string(),
  nextRuns: z.array(z.iso.datetime()),
  status: routineCardStatusSchema,
  routineId: z.uuid().nullable(),
});
export type RoutineProposalCard = z.infer<typeof routineProposalCardSchema>;

/** Os campos de uma rotina que uma proposta de alteração pode mudar (os mesmos que o editor tem). */
export const ROUTINE_CHANGE_FIELDS = ['name', 'instruction', 'schedule', 'timezone', 'startsAt', 'endsAt', 'maxRuns'] as const;
export const routineChangeFieldSchema = z.enum(ROUTINE_CHANGE_FIELDS);
export type RoutineChangeField = z.infer<typeof routineChangeFieldSchema>;

export const ROUTINE_CHANGE_FIELD_LABELS: Record<RoutineChangeField, string> = {
  name: 'Nome',
  instruction: 'Instrução',
  schedule: 'Agenda',
  timezone: 'Fuso',
  startsAt: 'Início',
  endsAt: 'Fim',
  maxRuns: 'Limite de execuções',
};

/** Os campos editáveis de uma rotina num instante, mais a agenda legível: o "antes" e o "depois" de uma proposta de alteração. */
export const routineSnapshotSchema = routineProposalSchema.extend({ summary: z.string() });
export type RoutineSnapshot = z.infer<typeof routineSnapshotSchema>;

/**
 * "Alteração de rotina": o bot mudou, pausou, retomou ou excluiu uma rotina DELE. Na alteração, `before` é o que a rotina tinha e `after` o que
 * ficou, e `changed` lista só os campos que mudaram. Dois fluxos (ver `ROUTINE_CARD_STATUSES`):
 * - antigo (T21, propostas gravadas antes da phase 10): nada acontece antes de o dono confirmar; confirmar aplica `changed` sobre a rotina de agora
 *   e recusa (`stale`) se algum deles já foi alterado por outro caminho;
 * - novo (phase 10): a alteração JÁ foi aplicada (`applied`) e `before` guarda o estado anterior para o dono recusar (desfazer) ou editar. A
 *   recusa de uma exclusão devolve a rotina com o mesmo id e o mesmo histórico (o instantâneo para isso fica só no servidor, fora deste contrato).
 */
export const routineChangeCardSchema = z.object({
  type: z.literal('routine_change'),
  /** Nulo se a rotina foi excluída (pelo bot, pelo dono ou depois do cartão, R18): um cartão pendente vira `stale` e um aplicado, `superseded`. */
  routineId: z.uuid().nullable(),
  /** Nome da rotina quando o bot propôs (o título do cartão). */
  routineName: z.string(),
  change: z.discriminatedUnion('action', [
    z.object({
      action: z.literal('update'),
      before: routineSnapshotSchema,
      after: routineSnapshotSchema,
      changed: z.array(routineChangeFieldSchema).min(1),
      nextRuns: z.array(z.iso.datetime()),
    }),
    z.object({ action: z.literal('pause') }),
    z.object({ action: z.literal('resume') }),
    z.object({ action: z.literal('delete') }),
  ]),
  status: routineCardStatusSchema,
});
export type RoutineChangeCard = z.infer<typeof routineChangeCardSchema>;

/** As ações que o bot pode aplicar numa rotina dele (`propose_routine_change`) e que os avisos de recusa e de confirmação nomeiam. */
export const ROUTINE_ACTIONS = ['create', 'update', 'pause', 'resume', 'delete'] as const;
export type RoutineAction = (typeof ROUTINE_ACTIONS)[number];

/**
 * "Rotina confirmada": o dono confirmou uma proposta do bot (criar) ou uma proposta de alteração (alterar, pausar, retomar, excluir). Os cartões
 * `routine_proposal` e `routine_change` são só do dono e o resultado da ferramenta diz ao bot que nada foi feito ainda, então sem este aviso o bot
 * seguia achando que a rotina aguardava confirmação. Ele é gravado no FIM da conversa, na mesma transação da confirmação, e entra no contexto do
 * modelo pelo `content` (o histórico antigo não é reescrito: mudar o cartão antigo no pedido quebraria o cache e invalidaria o checkpoint). `routineId` nulo na exclusão.
 */
export const routineConfirmedCardSchema = z.object({
  type: z.literal('routine_confirmed'),
  routineId: z.uuid().nullable(),
  routineName: z.string(),
  action: z.enum(ROUTINE_ACTIONS),
});
export type RoutineConfirmedCard = z.infer<typeof routineConfirmedCardSchema>;

/**
 * "Rotina recusada" (phase 10): o dono recusou, no cartão, o que o bot aplicou, e o servidor desfez. Como `routine_confirmed`, é um AVISO de uma
 * linha gravado no FIM da conversa, na mesma transação da recusa: os cartões de rotina são só do dono, e é por este aviso (o `content` diz o que foi
 * desfeito) que o bot fica sabendo. `action` é o que foi recusado; `routineId` é a rotina que voltou (nulo quando a rotina criada foi excluída).
 * Não conta como novidade nem acende a bolinha de não lido: registra uma ação do próprio dono.
 */
export const routineRefusedCardSchema = z.object({
  type: z.literal('routine_refused'),
  routineId: z.uuid().nullable(),
  routineName: z.string(),
  action: z.enum(ROUTINE_ACTIONS),
});
export type RoutineRefusedCard = z.infer<typeof routineRefusedCardSchema>;

/**
 * "Rotina editada" (phase 10): o dono editou, pelo cartão, a rotina que o bot criou ou alterou. Mesmo papel e mesma posição de `routine_refused`.
 * O estado final (nome, agenda legível, fuso e instrução) vai só no `content`, que o modelo lê; a tela mostra uma linha curta.
 */
export const routineEditedCardSchema = z.object({
  type: z.literal('routine_edited'),
  routineId: z.uuid().nullable(),
  routineName: z.string(),
});
export type RoutineEditedCard = z.infer<typeof routineEditedCardSchema>;

/** `POST /api/routines/changes/:messageId/confirm` e `POST /api/routines/cards/:messageId/refuse`: o id é o da mensagem do cartão. */
export const routineChangeParamsSchema = z.strictObject({ messageId: idText });

/**
 * `PUT /api/routines/:id` com o editor aberto pelo cartão (`/rotinas/<id>?cartao=<cardId>`): a edição de sempre mais `cardId`, o id da mensagem
 * do cartão ("Rotina criada pelo bot" ou "Alteração de rotina" aplicada). Com `cardId` o servidor confere que o cartão é da rotina e que ela não
 * mudou depois dele, grava o cartão como `edited` e o aviso `routine_edited`; sem `cardId` é a edição comum. Os campos da rotina seguem estritos.
 */
export const routineEditSchema = routineReplaceSchema.extend({ cardId: idText.optional() });
export type RoutineEdit = z.infer<typeof routineEditSchema>;

/** Resultado de confirmar: a rotina como ficou, ou nulo quando a alteração era excluí-la. */
export const routineChangeResultSchema = z.object({ routine: routineViewSchema.nullable() });
export type RoutineChangeResult = z.infer<typeof routineChangeResultSchema>;
