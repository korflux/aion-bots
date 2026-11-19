// Contratos de modelos (F8, T5) compartilhados entre a API, o core e a web: seletor de modelo, resultado do teste
// da primeira seleção, níveis de effort aceitos e favoritos.
//
// O catálogo em si vem dos provedores (OpenCode Go e, com a chave salva, Anthropic) a cada consulta, cada id como `provedor/modelo`; o que o Aion grava por modelo é só o que o provedor
// não informa: se já foi testado e com qual resultado, quais níveis de effort ele aceitou e se é favorito.
import { z } from 'zod';
import { MODEL_ID_MAX, modelContextCapacitySchema } from './context-window';

/**
 * Provedores de modelo (phase 17, DATA-02): registro fixo no código. O id gravado, aceito e mostrado é sempre `provedor/modelo` (`opencode/deepseek-v4.1-flash`,
 * `anthropic/claude-haiku-5-5`); o que o provedor recebe e o que o `# Dados` do pedido mostram é o id LOCAL, sem o prefixo (`localModelId`), para o pedido do OpenCode Go seguir
 * idêntico em bytes ao de antes da phase.
 */
export const MODEL_PROVIDERS = ['opencode', 'anthropic'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** Monta o id `provedor/modelo` a partir do provedor e do id local que o catálogo dele informa. */
export const qualifyModelId = (provider: ModelProvider, local: string): string => `${provider}/${local}`;

/** Separa o id em provedor e id local; `null` quando o prefixo não é de um provedor conhecido (id sem provedor não é um id válido do produto). */
export function parseModelId(id: string): { provider: ModelProvider; local: string } | null {
  for (const provider of MODEL_PROVIDERS) {
    if (id.startsWith(`${provider}/`) && id.length > provider.length + 1) return { provider, local: id.slice(provider.length + 1) };
  }
  return null;
}

/** Provedor do id, ou `null` se o prefixo não é conhecido. */
export const providerOfModel = (id: string): ModelProvider | null => parseModelId(id)?.provider ?? null;

/** Id local (sem `provedor/`); um id sem prefixo conhecido volta como veio. É o que a chamada ao provedor e o bloco `# Dados` usam. */
export const localModelId = (id: string): string => parseModelId(id)?.local ?? id;

/**
 * Identificador de modelo (`provedor/modelo`) vindo do cliente. O formato é frouxo de propósito (sem controles, 1 a `MODEL_ID_MAX` caracteres):
 * a autoridade é o catálogo atual do provedor do id, e o servidor só aceita um id que conste nele (allowlist).
 */
export const modelIdSchema = z
  .string()
  .min(1)
  .max(MODEL_ID_MAX)
  .regex(/^[^\p{Cc}]+$/u);

/**
 * Níveis de effort que o teste sabe sondar, do menor ao maior. Um modelo só expõe os que o provedor de fato aceitou
 * (descobertos no teste, nunca presumidos). O mesmo vocabulário vale para o bot, que só guarda um destes.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const effortLevelSchema = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

/** Rótulos do controle de effort (o "Padrão" é a ausência de nível: o provedor decide). */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Extra alto',
  max: 'Máximo',
};

/** Resultado do teste: `ok` = "Liberado"; `no_tools` = passa em texto e streaming e falha em ferramenta; `failed`. */
export const MODEL_TEST_STATUSES = ['ok', 'no_tools', 'failed'] as const;
export const modelTestStatusSchema = z.enum(MODEL_TEST_STATUSES);
export type ModelTestStatus = z.infer<typeof modelTestStatusSchema>;

/** Motivo seguro de um resultado que não é `ok` (nunca carrega texto do provedor). */
export const MODEL_TEST_REASONS = ['unsupported', 'bad_stream', 'empty_response', 'no_tool_call'] as const;
export const modelTestReasonSchema = z.enum(MODEL_TEST_REASONS);
export type ModelTestReason = z.infer<typeof modelTestReasonSchema>;

export const MODEL_TEST_REASON_MESSAGES: Record<ModelTestReason, string> = {
  unsupported: 'O provedor não aceitou este modelo em nenhum formato conhecido.',
  bad_stream: 'A resposta em streaming veio fora do formato esperado.',
  empty_response: 'O modelo respondeu sem texto.',
  no_tool_call: 'O modelo não chamou a ferramenta de teste.',
};

/** Quantos modelos a seção Recentes do seletor mostra (A26): o servidor devolve no máximo este tanto de ids e a tela corta no mesmo número. Fonte única. */
export const MODEL_RECENTS_LIMIT = 5;

/** Testes por minuto (spec: "testes de modelo limitados a 10 por minuto"). */
export const MODEL_TESTS_PER_MINUTE = 10;

export const modelTestSchema = z.object({
  status: modelTestStatusSchema,
  reason: modelTestReasonSchema.nullable(),
  /** Níveis de effort que o provedor aceitou neste modelo; vazio = o modelo não expõe o controle. */
  effortLevels: z.array(effortLevelSchema),
  testedAt: z.iso.datetime(),
});
export type ModelTest = z.infer<typeof modelTestSchema>;

/** Um modelo da lista do seletor: o id do provedor, o favorito e o último teste (nulo = nunca testado). */
export const modelEntrySchema = z.object({
  id: z.string(),
  contextCapacity: modelContextCapacitySchema.nullable().optional(),
  favorite: z.boolean(),
  /** Quando foi favoritado; define a ordem da seção Favoritos e qual é o "primeiro favorito". */
  favoritedAt: z.iso.datetime().nullable(),
  test: modelTestSchema.nullable(),
  /** Visão comprovada por sonda; null significa que ainda não houve resultado conclusivo. */
  acceptsImages: z.boolean().nullable().default(null),
  /**
   * `credits_exhausted`: a última chamada com a chave deste provedor (a Anthropic) recusou por saldo esgotado, então o modelo fica indisponível nas escolhas novas até uma chamada passar (A21).
   * Ausente ou nulo: disponível. Quem já usa o modelo segue tentando (a chamada que passar o libera).
   */
  unavailable: z.literal('credits_exhausted').nullable().optional(),
  /** Nome para exibição (`display_name` da Anthropic, ex.: `Claude Haiku 5.5`); nulo no OpenCode Go, cujo nome é o id local. */
  displayName: z.string().nullable().optional(),
  /** O dono ocultou o modelo em Conexões (A7): sai das escolhas novas, mas bot, rotina, conversa e resumo que já o usam seguem funcionando e mostram "oculto" (A9). */
  hidden: z.boolean().optional(),
  /** Preço em US$ por milhão de tokens (entrada e saída, A23); nulo = preço desconhecido (sem linha em `models/prices.ts`). */
  price: z.object({ input: z.number(), output: z.number() }).nullable().optional(),
});
export type ModelEntry = z.infer<typeof modelEntrySchema>;

/** `recents`: até 5 ids dos modelos usados mais recentemente em alguma execução (do mais novo ao mais antigo), só os que ainda constam na lista; ausente = nenhum. */
export const modelListSchema = z.object({ models: z.array(modelEntrySchema), recents: z.array(z.string()).optional() });
export type ModelList = z.infer<typeof modelListSchema>;

export const modelTestRequestSchema = z.strictObject({ model: modelIdSchema });
export const modelFavoriteRequestSchema = z.strictObject({ model: modelIdSchema, favorite: z.boolean() });
export const modelHiddenRequestSchema = z.strictObject({ model: modelIdSchema, hidden: z.boolean() });
