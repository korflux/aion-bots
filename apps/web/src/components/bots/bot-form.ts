// Regras do formulário do bot no cliente: valores em texto (como os campos os guardam), validação antes do envio
// e tradução dos erros da API para mensagens por campo. Funções puras, testadas em bot-form.test.ts.
//
// A validação reutiliza o MESMO schema da API (`botCreateSchema` de @aion/shared), então os limites e o formato
// nunca divergem do servidor; aqui só se troca o motivo genérico do Zod por uma frase para o dono. O servidor
// segue sendo a autoridade: qualquer erro que passe daqui volta no envelope e é mostrado no mesmo lugar.
import {
  BOT_COLORS,
  BOT_DEFAULT_COLOR,
  BOT_INSTRUCTIONS_MAX,
  BOT_NAME_MAX,
  BOT_STEP_LIMIT_DEFAULT,
  BOT_STEP_LIMIT_MAX,
  BOT_STEP_LIMIT_MIN,
  botCreateSchema,
  contextWindowTokensSchema,
  type ContextWindowTokens,
  effortLevelSchema,
  type Bot,
  type EffortLevel,
  type FieldError,
} from '@aion/shared';
import type { BotDraft } from './bots-api';

/** Campos do formulário que podem ter erro. */
export const FORM_FIELDS = ['name', 'color', 'instructions', 'model', 'effort', 'stepLimit', 'contextWindowTokens'] as const;
export type FormField = (typeof FORM_FIELDS)[number];

export interface BotFormValues {
  name: string;
  /** Texto da cor como digitado: `#RRGGBB` válido ou não (o campo personalizado aceita digitação parcial). */
  color: string;
  instructions: string;
  /** Modelo padrão escolhido no seletor (id do provedor); nulo usa o primeiro favorito. */
  model: string | null;
  /** Effort padrão: um dos níveis que o modelo aceitou no teste; nulo = padrão do modelo. */
  effort: EffortLevel | null;
  /** Texto do campo numérico: o dono pode apagar ou digitar lixo antes de corrigir. */
  stepLimit: string;
  contextWindowTokens: ContextWindowTokens | null;
}

export type BotFormErrors = Partial<Record<FormField, string>>;

export const EMPTY_FORM: BotFormValues = {
  name: '',
  color: BOT_DEFAULT_COLOR,
  instructions: '',
  model: null,
  effort: null,
  stepLimit: String(BOT_STEP_LIMIT_DEFAULT),
  contextWindowTokens: null,
};

/** O effort gravado no bot só pode ser um nível conhecido; qualquer outro valor vira "padrão do modelo". */
const knownEffort = (effort: string | null): EffortLevel | null => {
  const parsed = effortLevelSchema.safeParse(effort);
  return parsed.success ? parsed.data : null;
};

export const formFromBot = (bot: Bot): BotFormValues => ({
  name: bot.name,
  color: bot.color,
  instructions: bot.instructions,
  model: bot.model,
  effort: knownEffort(bot.effort),
  stepLimit: String(bot.stepLimit),
  contextWindowTokens: contextWindowTokensSchema.safeParse(bot.contextWindowTokens).success ? bot.contextWindowTokens : null,
});

/** A cor é uma das 12 pré-definidas? (senão o seletor abre em "Personalizada") */
export const isPresetColor = (color: string): boolean => BOT_COLORS.some((preset) => preset.hex === color.toUpperCase());

const number = (value: number) => value.toLocaleString('pt-BR');

/** Frase por campo e tipo de falha do Zod (`too_small`, `too_big`...); `default` cobre o resto. */
const MESSAGES: Record<FormField, Record<string, string>> = {
  name: {
    too_small: 'Informe um nome.',
    too_big: `Use até ${BOT_NAME_MAX} caracteres.`,
    default: 'O nome não pode ter quebra de linha nem caracteres de controle.',
  },
  color: { default: 'Use o formato #RRGGBB, por exemplo #60A5FA.' },
  instructions: {
    too_big: `As instruções passaram de ${number(BOT_INSTRUCTIONS_MAX)} caracteres.`,
    default: 'Remova os caracteres de controle das instruções.',
  },
  model: { default: 'Escolha um modelo da lista.' },
  effort: { default: 'Escolha um effort da lista do modelo.' },
  contextWindowTokens: { default: 'Escolha uma janela de contexto da lista.' },
  stepLimit: { default: `Informe um número inteiro de ${BOT_STEP_LIMIT_MIN} a ${BOT_STEP_LIMIT_MAX}.` },
};

const isField = (value: unknown): value is FormField => FORM_FIELDS.includes(value as FormField);

/**
 * Valida o formulário com o schema da API. Devolve o rascunho normalizado (nome aparado, cor em maiúsculas) para
 * enviar, ou os erros por campo (só o primeiro de cada campo).
 */
export function validateBotForm(values: BotFormValues): { draft: BotDraft; errors: null } | { draft: null; errors: BotFormErrors } {
  const stepLimit = /^\d+$/.test(values.stepLimit.trim()) ? Number(values.stepLimit.trim()) : Number.NaN;
  const result = botCreateSchema.safeParse({
    name: values.name,
    color: values.color,
    instructions: values.instructions,
    model: values.model,
    effort: values.effort,
    stepLimit,
    contextWindowTokens: values.contextWindowTokens,
  });
  if (result.success) {
    // O bot não tem personagem (a Faísca é única): o rascunho não leva `mascot`, que o schema da API recusaria como campo desconhecido.
    const { name, color, instructions, model, effort, stepLimit: limit, contextWindowTokens } = result.data;
    return { draft: { name, color, instructions, model, effort, stepLimit: limit, contextWindowTokens }, errors: null };
  }
  const errors: BotFormErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (!isField(field) || errors[field]) continue;
    errors[field] = MESSAGES[field][issue.code] ?? MESSAGES[field].default;
  }
  return { draft: null, errors };
}

/** Erros de campo devolvidos pela API (`VALIDATION_FAILED`) no formato do formulário; campos desconhecidos ficam de fora. */
export function errorsFromApi(fields: FieldError[] | undefined): BotFormErrors {
  const errors: BotFormErrors = {};
  for (const { field, reason } of fields ?? []) {
    if (isField(field) && !errors[field]) errors[field] = reason;
  }
  return errors;
}
