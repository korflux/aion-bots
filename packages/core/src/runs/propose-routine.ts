// Ferramenta interna "propor rotina" (F12 passo 3; phase 10 substitui a confirmação do dono, SEC-03): o bot CRIA uma rotina e ela já vale. A
// ferramenta valida a agenda e cria a rotina ATIVA pelo `RoutineService` (a mesma criação do dono), gravando na mesma transação o cartão "Rotina
// criada pelo bot" com a agenda legível, o fuso e as próximas 5 datas. O dono pode recusar (a rotina é excluída) ou editar pelo cartão, e o
// bot é avisado na conversa quando isso acontece. A ferramenta continua sem passar por aprovação (SEC-03), mas o controle sobre o que a rotina
// FAZ não mudou: cada execução dela passa pela regra de aprovação de sempre (uma ação externa sem regra pausa pedindo o dono).
//
// Repetição (phase 15, A19): repetir a chamada, depois de uma queda do worker entre o commit da rotina e o registro do resultado (a atividade fecha como interrompida, a
// ferramenta não é replayable, e o bot chama de novo) ou numa nova tentativa do modelo, não cria segunda rotina. `RoutineService.createByBot` reencontra, sob o travamento da
// linha do bot no banco, a rotina do bot com exatamente esta configuração e a devolve (`created: false`), sem novo cartão; o resultado diz ao bot que ela já existe, com o estado
// atual. Sem coluna nem índice novos e sem chave por chamada: a identidade da chamada é o conteúdo dela, que é o que o bot repete.
//
// A rotina criada é do bot que a criou: o id vem do contexto da execução e o schema estrito recusa qualquer outro argumento (`botId`...). O schema
// de entrada é o mesmo do editor (`@aion/shared`), então uma agenda que o dono não conseguiria montar também não passa aqui; o motivo legível volta
// ao bot como falha da ferramenta para ele corrigir e tentar de novo.
import {
  ROUTINE_STATUS_LABELS,
  routineInstructionSchema,
  routineNameSchema,
  routineScheduleSettingsSchema,
  scheduleDefinitionSchema,
} from '@aion/shared';
import { DomainError } from '../errors';
import { RoutineService } from '../routines/service';
import { readAppSettings } from '../settings/service';
import { modelJsonSchema } from './tool-arguments';
import { ToolFailure, defineTool, toolFailure, type ToolContext, type ToolOutcome } from './tools';

export const PROPOSE_ROUTINE_TOOL = 'propose_routine';

/** Semântica do calendário que não é representável por JSON Schema; a gramática vem do validador compartilhado. */
export const SCHEDULE_HELP = [
  'Horários HH:mm e datas AAAA-MM-DDTHH:mm são locais no fuso da rotina. once exige data real futura; horários e dias em arrays não se repetem.',
  'interval em minutes exige mínimo 5; window.from deve preceder window.to. monthly_day ajusta meses curtos sem perder o dia-base; monthly_business_day considera segunda a sexta, incluindo feriados.',
  'cron usa 5 campos (minuto hora dia-do-mês mês dia-da-semana) dentro do objeto: {"type":"cron","expression":"0 9 * * *"}.',
].join(' ');

/**
 * O esquema de agenda que o modelo recebe por inteiro (phase 15, A18): `propose_routine` o publica. A validação das duas ferramentas é a mesma (`scheduleDefinitionSchema` e, depois,
 * `scheduleProblem` no serviço), então as recusas são as mesmas; o que não se repete é o JSON aninhado completo, que pesava 2.805 bytes em cada definição (ver `SCHEDULE_OUTLINE`).
 */
export const SCHEDULE_PARAMETER = modelJsonSchema(scheduleDefinitionSchema, { io: 'input', unrepresentable: 'any' });

type ScheduleBranch = { properties: Record<string, { const?: string; enum?: unknown[]; items?: { enum?: unknown[] } }>; required: string[] };

/** O que fica de um campo no contorno: só o domínio fechado (lista de valores, também em lista de itens), nunca tipo, formato nem faixa. */
const outlineOf = (field: ScheduleBranch['properties'][string]): Record<string, unknown> =>
  field.enum ? { enum: field.enum } : field.items?.enum ? { items: { enum: field.items.enum } } : {};

/**
 * O contorno da agenda (phase 15, A18): a mesma união por `type`, derivada de `SCHEDULE_PARAMETER`, mas só com o que identifica cada variante: o valor de `type`, os campos que ela exige
 * (`required`) e os domínios fechados (dias da semana, unidade, posição). É o que `propose_routine_change` publica no lugar do esquema inteiro, que o modelo já recebe em `propose_routine`
 * (o catálogo core publica as duas juntas). Continua uma união com `type` constante em cada variante, que é de onde `describeArgumentIssues` tira "esperado objeto com type = once|...", então a
 * recusa de uma agenda inválida diz o mesmo nas duas ferramentas. Derivado, e não escrito à mão, para um tipo ou campo novo na agenda aparecer aqui sem outra edição.
 */
export const SCHEDULE_OUTLINE = {
  oneOf: (SCHEDULE_PARAMETER.oneOf as ScheduleBranch[]).map(({ properties, required }) => ({
    properties: Object.fromEntries(Object.entries(properties).map(([name, field]) => [name, name === 'type' ? { const: field.const } : outlineOf(field)])),
    required,
  })),
};

/**
 * O serviço de rotinas das ferramentas do bot: o mesmo da API, sobre o pool e o relógio da execução. Sem credenciais (só "Executar agora" as usa,
 * e o bot nunca enfileira execuções), então nada aqui chama o provedor.
 */
export const routineServiceOf = (context: Pick<ToolContext, 'pool' | 'now'>): RoutineService => new RoutineService({ pool: context.pool, now: context.now });

/**
 * Converte o que o serviço recusa em falha de ferramenta (texto seguro que o bot lê). Agenda inválida leva o motivo legível; o resto vira uma frase
 * fixa. Um erro que não é de domínio é bug e sobe como está (o motor o transforma em falha genérica e o registra só no log).
 */
export function routineFailureOf(error: unknown): unknown {
  if (!(error instanceof DomainError)) return error;
  switch (error.code) {
    case 'SCHEDULE_INVALID':
    case 'SCHEDULE_IN_PAST':
      return toolFailure(error.code, `Agenda inválida: ${error.fields?.[0]?.reason ?? 'verifique a agenda.'} Corrija e tente de novo.`);
    case 'BOT_ARCHIVED':
      return toolFailure('BOT_ARCHIVED', 'Este bot está arquivado: as rotinas dele ficam pausadas e não podem ser criadas nem alteradas até ele ser desarquivado.');
    case 'ROUTINE_NOT_FOUND':
      return toolFailure('ROUTINE_NOT_FOUND', 'Rotina não encontrada entre as suas. Use list_routines para ver os ids das suas rotinas.');
    case 'ROUTINE_CHANGED':
      return toolFailure('ROUTINE_CHANGED', 'A rotina mudou enquanto você pedia a alteração. Use list_routines e get_routine para ver como ela está agora e tente de novo.');
    case 'VALIDATION_FAILED':
      return toolFailure('VALIDATION_FAILED', 'Nada mudaria: os valores enviados são iguais aos que a rotina já tem.');
    default:
      return error;
  }
}

const argsSchema = routineScheduleSettingsSchema
  .extend({ name: routineNameSchema, instruction: routineInstructionSchema })
  .partial({ timezone: true, startsAt: true, endsAt: true, maxRuns: true });

export const proposeRoutineTool = defineTool({
  definition: {
    name: PROPOSE_ROUTINE_TOOL,
    description:
      // As regras de rotinas que antes ficavam no "Funcionamento do Aion" vivem nas ferramentas de rotina (Suposição 16 da phase 3).
      'Cria uma ROTINA: instrução que você executará sozinho, num horário ou numa recorrência. Use quando o dono pedir que algo ' +
      'aconteça de novo ou numa hora marcada, ou quando um lembrete for necessário. A rotina é criada e já fica ATIVA, sem confirmação do dono; ' +
      'ele recebe um cartão e pode recusá-la (ela é excluída) ou editá-la, e um aviso do sistema entra na conversa quando isso acontecer. ' +
      'A rotina será sua e a instrução precisa bastar sozinha (você a executará sem o dono por perto). ' +
      // O bot propôs "todo dia até a data" para lembrar de eventos e passou a agenda como texto/cron solto: o formato e o momento certo ficam aqui.
      'schedule é SEMPRE um objeto com type, nunca texto livre nem cron solto: {"type":"daily","times":["09:00"]} ou, uma vez só, {"type":"once","at":"2026-11-07T09:00"}. ' +
      'Para lembrar de um evento, crie uma rotina única (once) no momento útil, como a manhã do dia ou a véspera, uma por evento, em vez de repetir todo dia até a data. ' +
      'Quando uma rodada começa com "[Sistema] Rotina ... iniciada", foi a agenda que o acionou, sem o dono presente: execute a instrução e ' +
      'responda com o resultado. Para ver as suas rotinas use list_routines e get_routine; para mudar, pausar, retomar ou excluir uma delas use ' +
      `propose_routine_change (também vale na hora). ${SCHEDULE_HELP}`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome curto da rotina (até 80 caracteres).' },
        instruction: { type: 'string', description: 'O que fazer a cada execução (até 4.000 caracteres).' },
        schedule: SCHEDULE_PARAMETER,
        timezone: { type: 'string', description: 'Fuso IANA. Padrão: o fuso do dono (o mesmo do "Agora" do contexto).' },
        startsAt: { type: ['string', 'null'], description: 'Início opcional "AAAA-MM-DDTHH:mm" (hora local do fuso).' },
        endsAt: { type: ['string', 'null'], description: 'Fim opcional "AAAA-MM-DDTHH:mm" (hora local do fuso).' },
        maxRuns: { type: ['integer', 'null'], description: 'Parar após N execuções (1 a 10.000), opcional.' },
      },
      required: ['name', 'instruction', 'schedule'],
      additionalProperties: false,
    },
  },
  botOnly: true,
  argsSchema,
  label: ({ name }) => `Criou a rotina "${name}"`,

  async execute(args, context): Promise<ToolOutcome> {
    const { pool, botId, conversationId, runId } = context;
    // Rede de segurança: o motor não oferece esta ferramenta numa sessão do chat geral (a rotina pertence a um bot).
    if (botId === null) throw new ToolFailure('Rotinas só existem em conversas de bot.');
    const settings = {
      schedule: args.schedule,
      timezone: args.timezone ?? (await readAppSettings(pool)).timeZone,
      startsAt: args.startsAt ?? null,
      endsAt: args.endsAt ?? null,
      maxRuns: args.maxRuns ?? null,
    };
    let outcome;
    try {
      outcome = await routineServiceOf(context).createByBot({ botId, conversationId, runId }, { name: args.name, instruction: args.instruction, ...settings });
    } catch (error) {
      throw routineFailureOf(error);
    }
    const { routine, created } = outcome;
    if (!created) {
      // A repetição (queda do worker ou nova tentativa): a rotina já existe com exatamente esta configuração. O estado atual vai junto, porque o dono pode tê-la pausado desde então.
      return {
        result:
          `Esta rotina já existe, com exatamente esta configuração: "${routine.name}" (id ${routine.id}) — ${routine.summary} (${routine.timezone}). Estado: ${ROUTINE_STATUS_LABELS[routine.status]}. ` +
          'Nada foi criado de novo. Não crie outra; para mudá-la use propose_routine_change.',
      };
    }
    return {
      result:
        `Rotina criada e ATIVA: "${args.name}" (id ${routine.id}) — ${routine.summary} (${routine.timezone}). Ela já vale e roda na agenda, sem confirmação do dono. ` +
        'O dono pode recusá-la (ela é excluída) ou editá-la pelo cartão; se isso acontecer, um aviso do sistema entra na conversa. Diga ao dono que a rotina já está ativa.',
    };
  },
});
