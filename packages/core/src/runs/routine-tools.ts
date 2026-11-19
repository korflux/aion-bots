// Ferramentas internas do bot sobre as ROTINAS DELE (T21): ver (`list_routines`, `get_routine`) e alterar (`propose_routine_change`: mudar,
// pausar, retomar ou excluir). Complementam `propose_routine` (criar) e valem só em conversa de bot (`botOnly`).
//
// Escopo: o id do bot vem do contexto da execução, e toda leitura filtra por ele (`routinesOfBot`, `routineOfBot`): o id de uma rotina de
// OUTRO bot é "não encontrada", sem revelar que existe. O schema estrito recusa qualquer outro argumento (`botId`...).
//
// Ler não tem efeito e não pede aprovação. Alterar também não pede a aprovação das ações do Composio (SEC-03) e, desde a phase 10, NÃO espera a
// confirmação do dono: a alteração é aplicada na hora pelo `RoutineService` (as mesmas regras do editor, na mesma transação do cartão "Alteração de
// rotina", que guarda o antes e o depois) e o dono recusa (desfaz) ou edita pelo cartão, com aviso ao bot. O que protege o dono continua sendo a regra
// de aprovação de CADA execução da rotina: aceitar por padrão muda só a agenda, nunca as ações externas que a rotina dispara.
import {
  DEFAULT_ROUTINE_TIMEZONE,
  ROUTINE_CHANGE_FIELDS,
  ROUTINE_MAX_RUNS_LIMIT,
  ROUTINE_STATUS_LABELS,
  localDateTimeSchema,
  routineInstructionSchema,
  routineNameSchema,
  scheduleDefinitionSchema,
  timezoneSchema,
  type RoutineView,
} from '@aion/shared';
import { z } from 'zod';
import { routineOfBot, routinesOfBot } from '../routines/rows';
import type { BotRoutineChange } from '../routines/service';
import { SCHEDULE_HELP, SCHEDULE_OUTLINE, routineFailureOf, routineServiceOf } from './propose-routine';
import { ToolFailure, defineTool, toolFailure, type ToolOutcome } from './tools';

export const LIST_ROUTINES_TOOL = 'list_routines';
/** Rotinas por página quando o bot não pede um tamanho: o resultado de uma ferramenta volta ao contexto da rodada a cada etapa seguinte. */
export const LIST_ROUTINES_PAGE = 20;
/** Teto de `limit` numa página de `list_routines`. */
export const LIST_ROUTINES_LIMIT = 50;
export const GET_ROUTINE_TOOL = 'get_routine';
export const PROPOSE_ROUTINE_CHANGE_TOOL = 'propose_routine_change';

/** Rotina que não é do bot (ou não existe): a mesma resposta nos dois casos. */
const NOT_FOUND = 'Rotina não encontrada entre as suas. Use list_routines para ver os ids das suas rotinas.';
const notFound = () => toolFailure('ROUTINE_NOT_FOUND', NOT_FOUND);

/** Data e hora de uma execução no fuso da rotina, legível para o modelo. */
const formatInZone = (iso: string, timezone: string): string =>
  `${new Date(iso).toLocaleString('pt-BR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' })} (${timezone})`;

/** Limite de execuções em texto ("12 de 100" ou "12, sem limite"). */
const runsOf = (routine: RoutineView): string => (routine.maxRuns === null ? `${routine.runCount}, sem limite` : `${routine.runCount} de ${routine.maxRuns}`);

/** As linhas de uma rotina que a lista e o detalhe têm em comum. */
function summaryLines(routine: RoutineView): string[] {
  return [
    `id: ${routine.id}`,
    `Nome: ${routine.name}`,
    `Estado: ${ROUTINE_STATUS_LABELS[routine.status]}`,
    `Agenda: ${routine.summary} (${routine.timezone})`,
    `Próxima execução: ${routine.nextRunAt === null ? 'nenhuma' : formatInZone(routine.nextRunAt, routine.timezone)}`,
    `Execuções: ${runsOf(routine)}`,
  ];
}

/** `offset` e `limit` na forma única de paginação das ferramentas (phase 15, A21): a próxima página é `nextOffset`, até ele ser `null`. */
const listArgs = z.strictObject({
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(LIST_ROUTINES_LIMIT).default(LIST_ROUTINES_PAGE),
});

export const listRoutinesTool = defineTool({
  definition: {
    name: LIST_ROUTINES_TOOL,
    description:
      'Lista as SUAS rotinas (as que rodam sozinhas em horários marcados), por nome: id, nome, estado (ativa, pausada ou concluída), agenda, próxima ' +
      'execução e quantas já rodaram. Não mostra a instrução; use get_routine para ela. Use para saber o que já existe antes de propor ' +
      `uma rotina nova ou uma alteração, e para achar o id de uma rotina. Páginas de até ${LIST_ROUTINES_LIMIT} rotinas (padrão ${LIST_ROUTINES_PAGE}); a última linha traz total e ` +
      'nextOffset: para as seguintes repita com offset igual ao nextOffset, até ele ser null.',
    parameters: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, description: 'Quantas rotinas pular (o nextOffset da página anterior). Padrão 0.' },
        limit: { type: 'integer', minimum: 1, maximum: LIST_ROUTINES_LIMIT, description: `Rotinas na página. Padrão ${LIST_ROUTINES_PAGE}.` },
      },
      additionalProperties: false,
    },
  },
  botOnly: true,
  argsSchema: listArgs,
  label: () => 'Consultou as rotinas',

  async execute({ offset, limit }, { pool, botId }): Promise<ToolOutcome> {
    // Rede de segurança: o motor não oferece esta ferramenta numa sessão do chat geral (a rotina pertence a um bot).
    if (botId === null) throw new ToolFailure('Rotinas só existem em conversas de bot.');
    const routines = await routinesOfBot(pool, botId);
    if (routines.length === 0) return { result: 'Você não tem nenhuma rotina.' };
    const end = offset + limit;
    const shown = routines.slice(offset, end);
    const blocks = shown.map((routine, index) => `${offset + index + 1}. ${summaryLines(routine).join('\n   ')}`);
    // Os nomes dos campos são os da paginação das outras ferramentas (doc_list, read_activity): `total` e `nextOffset` (null na última página).
    const page = `offset: ${offset} · limit: ${limit} · total: ${routines.length} · nextOffset: ${end < routines.length ? end : 'null'}`;
    return { result: `Suas rotinas (${routines.length}):\n${blocks.length > 0 ? `${blocks.join('\n')}\n` : ''}${page}` };
  },
});

export const getRoutineTool = defineTool({
  definition: {
    name: GET_ROUTINE_TOOL,
    description:
      'Mostra uma das SUAS rotinas por inteiro: a instrução completa, a agenda (no formato de propose_routine), o fuso, o início, o fim ' +
      'e o limite de execuções. Use antes de propor uma alteração, para partir do que a rotina realmente tem.',
    parameters: {
      type: 'object',
      properties: { routineId: { type: 'string', description: 'O id da rotina (campo "id" de list_routines).' } },
      required: ['routineId'],
      additionalProperties: false,
    },
  },
  botOnly: true,
  argsSchema: z.strictObject({ routineId: z.uuid() }),
  label: () => 'Consultou uma rotina',

  async execute({ routineId }, { pool, botId }): Promise<ToolOutcome> {
    if (botId === null) throw new ToolFailure('Rotinas só existem em conversas de bot.');
    const routine = await routineOfBot(pool, botId, routineId);
    if (routine === null) throw notFound();
    const lines = [
      ...summaryLines(routine),
      `Agenda (formato de propose_routine): ${JSON.stringify(routine.schedule)}`,
      `Início: ${routine.startsAt ?? 'sem início definido'}`,
      `Fim: ${routine.endsAt ?? 'sem fim definido'}`,
      `Instrução:\n${routine.instruction}`,
    ];
    return { result: lines.join('\n') };
  },
});

// ---------------------------------------------------------------------------------------------
// propose_routine_change
// ---------------------------------------------------------------------------------------------

const ACTIONS = ['update', 'pause', 'resume', 'delete'] as const;

/**
 * `startsAt`, `endsAt` e `maxRuns` aceitam `null` para REMOVER o valor; ausentes, ficam como estão. Os demais campos nunca são nulos.
 * ponytail: um modelo que envia `null` querendo dizer "não mudar" remove o valor; o cartão mostra o antes e o depois e o dono pode recusar (a rotina
 * volta como era), então o estrago é reversível. Tratar `null` como "sem mudança" se isso acontecer no uso.
 */
const argsSchema = z.strictObject({
  routineId: z.uuid(),
  action: z.enum(ACTIONS),
  name: routineNameSchema.optional(),
  instruction: routineInstructionSchema.optional(),
  schedule: scheduleDefinitionSchema.optional(),
  timezone: timezoneSchema.optional(),
  startsAt: localDateTimeSchema.nullable().optional(),
  endsAt: localDateTimeSchema.nullable().optional(),
  maxRuns: z.number().int().min(1).max(ROUTINE_MAX_RUNS_LIMIT).nullable().optional(),
});

/** Rótulo da atividade na conversa, por ação. */
const LABELS: Record<(typeof ACTIONS)[number], string> = {
  update: 'Alterou uma rotina',
  pause: 'Pausou uma rotina',
  resume: 'Retomou uma rotina',
  delete: 'Excluiu uma rotina',
};

/** O que o bot lê sobre o que o dono pode fazer no cartão, por ação (excluir não tem "editar": a rotina não existe mais). */
const OWNER_OPTIONS: Record<(typeof ACTIONS)[number], string> = {
  update: 'recusar (a rotina volta a ser como era antes) ou editar pelo cartão',
  pause: 'recusar (a rotina volta a rodar) ou editar pelo cartão',
  resume: 'recusar (a rotina volta a ficar pausada) ou editar pelo cartão',
  delete: 'recusar (a rotina volta, com a mesma configuração e o mesmo histórico)',
};

export const proposeRoutineChangeTool = defineTool({
  definition: {
    name: PROPOSE_ROUTINE_CHANGE_TOOL,
    description:
      'Altera uma das SUAS rotinas: action "update" muda campos, "pause" pausa, "resume" retoma uma pausada e ' +
      '"delete" exclui a rotina e o histórico. A alteração é aplicada NA HORA, sem confirmação do dono: ele recebe um cartão com o antes e o depois ' +
      'e pode recusá-la (a rotina volta ao estado anterior) ou editá-la, e um aviso do sistema entra na conversa quando isso acontecer. ' +
      'Veja antes list_routines e, para mudar, get_routine. Em "update" envie SÓ os campos que mudam ' +
      '(pelo menos um); startsAt, endsAt e maxRuns aceitam null para remover o valor. Nas outras ações não envie campos de alteração. ' +
      `${SCHEDULE_HELP}`,
    parameters: {
      type: 'object',
      properties: {
        routineId: { type: 'string', description: 'O id da rotina (campo "id" de list_routines).' },
        action: { type: 'string', enum: [...ACTIONS], description: 'update altera campos; pause, resume e delete não levam campos.' },
        name: { type: 'string', description: 'Novo nome (até 80 caracteres). Só em update.' },
        instruction: { type: 'string', description: 'Nova instrução completa (até 4.000 caracteres): ela substitui a atual. Só em update.' },
        // Só o contorno da agenda (tipos, campos obrigatórios e domínios): o esquema aninhado completo fica em `propose_routine` (A18). A validação e as recusas são as mesmas.
        schedule: { ...SCHEDULE_OUTLINE, description: 'Nova agenda completa (substitui a atual), no formato de schedule de propose_routine. Só em update.' },
        timezone: { type: 'string', description: `Novo fuso IANA, ex.: ${DEFAULT_ROUTINE_TIMEZONE}. Só em update.` },
        startsAt: { type: ['string', 'null'], description: 'Novo início "AAAA-MM-DDTHH:mm" (hora local do fuso) ou null para remover. Só em update.' },
        endsAt: { type: ['string', 'null'], description: 'Novo fim "AAAA-MM-DDTHH:mm" (hora local do fuso) ou null para remover. Só em update.' },
        maxRuns: { type: ['integer', 'null'], description: 'Novo limite de execuções (1 a 10.000) ou null para remover. Só em update.' },
      },
      required: ['routineId', 'action'],
      additionalProperties: false,
    },
  },
  botOnly: true,
  argsSchema,
  label: ({ action }) => LABELS[action],

  async execute(args, context): Promise<ToolOutcome> {
    const { pool, botId, conversationId, runId } = context;
    if (botId === null) throw new ToolFailure('Rotinas só existem em conversas de bot.');
    const routine = await routineOfBot(pool, botId, args.routineId);
    if (routine === null) throw notFound();

    const wantsChanges = ROUTINE_CHANGE_FIELDS.some((field) => args[field] !== undefined);
    let change: BotRoutineChange;
    if (args.action === 'update') {
      if (!wantsChanges) throw toolFailure('VALIDATION_FAILED', 'Em "update" envie pelo menos um campo para mudar (name, instruction, schedule, timezone, startsAt, endsAt ou maxRuns).');
      change = {
        action: 'update',
        fields: { name: args.name, instruction: args.instruction, schedule: args.schedule, timezone: args.timezone, startsAt: args.startsAt, endsAt: args.endsAt, maxRuns: args.maxRuns },
      };
    } else {
      if (wantsChanges) throw toolFailure('VALIDATION_FAILED', `Os campos de alteração só valem em "update"; para "${args.action}" envie só routineId e action.`);
      if (args.action === 'pause' && routine.status !== 'active') {
        throw toolFailure('ROUTINE_CHANGED', `A rotina já está ${ROUTINE_STATUS_LABELS[routine.status].toLowerCase()}; não há o que pausar.`);
      }
      if (args.action === 'resume' && routine.status !== 'paused') {
        throw toolFailure('ROUTINE_CHANGED', `A rotina está ${ROUTINE_STATUS_LABELS[routine.status].toLowerCase()}; só uma rotina pausada pode ser retomada.`);
      }
      change = { action: args.action };
    }

    let applied;
    try {
      // A mesma validação do editor (agenda, fuso, período, data única no futuro) corre na transação que aplica: o motivo volta ao bot para ele corrigir.
      applied = await routineServiceOf(context).applyChangeByBot({ botId, conversationId, runId }, routine.id, change);
    } catch (error) {
      throw routineFailureOf(error);
    }
    const what = {
      update: `foi alterada (campos: ${applied.changed.join(', ')})`,
      pause: 'foi pausada',
      resume: 'foi retomada',
      delete: 'foi excluída (com o histórico)',
    }[args.action];
    return {
      result:
        `Alteração aplicada: a rotina "${routine.name}" ${what} e a mudança JÁ VALE, sem confirmação do dono. O dono pode ${OWNER_OPTIONS[args.action]}; ` +
        'se isso acontecer, um aviso do sistema entra na conversa. Diga ao dono que a alteração já foi feita.',
    };
  },
});
