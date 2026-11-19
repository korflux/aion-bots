// Registro de capacidade por provedor+ID (o id é o do produto, `provedor/modelo`); não infere limites por família ou resultado de sondas.
// Duas fontes, as duas fundamentadas no próprio provedor: a tabela fixa abaixo (OpenCode Go, que não informa capacidade na listagem, então cada modelo entra com fonte pública e data de
// conferência) e as capacidades que a Anthropic informa por modelo em `GET /v1/models` (`max_input_tokens` e `max_tokens`), guardadas em memória a cada leitura do catálogo
// (`ModelService`) e lidas aqui de forma síncrona, como a tabela fixa.
import { modelContextCapacitySchema, type ModelContextCapacity, type ModelProvider } from '@aion/shared';

const DEEPSEEK_FLASH = modelContextCapacitySchema.parse({
  provider: 'opencode_go', model: 'opencode/deepseek-v4.1-flash', contextTokens: 1000000, outputTokens: 384000,
  source: 'https://opencode.ai/data/deepseek/deepseek-v4-1-flash', checkedAt: '2026-10-12T00:00:00.000Z',
});

/**
 * MiMo V2.6 Pro (phase 11, F8; spec decisão 27): 1M de contexto e 131k de saída, conferidos na página pública do provedor em 17/10/2026. Com a capacidade
 * registrada, a janela efetiva do MiMo é a menor entre a escolhida e o 1M (as quatro opções, até 512k, cabem), e o limite de saída do pedido passa a vir
 * do registro em vez de ficar sem teto confirmado.
 */
const MIMO_V2_6_PRO = modelContextCapacitySchema.parse({
  provider: 'opencode_go', model: 'opencode/mimo-v2.6-pro', contextTokens: 1000000, outputTokens: 131072,
  source: 'https://opencode.ai/data/xiaomi/mimo-v2-6-pro', checkedAt: '2026-10-17T00:00:00.000Z',
});

/** Identidades com capacidade fundamentada. Novo modelo entra aqui com fonte pública e data de conferência; nada é deduzido por família de modelo. */
const REGISTRY: readonly ModelContextCapacity[] = [DEEPSEEK_FLASH, MIMO_V2_6_PRO];

/** Fonte pública das capacidades que a Anthropic informa por modelo (a própria listagem de modelos da API). */
const ANTHROPIC_SOURCE = 'https://platform.claude.com/docs/en/api/models/list';

/** Capacidades lidas do catálogo de cada provedor na última leitura, por id do produto. Só o provedor que informa capacidade por modelo (hoje a Anthropic) preenche. */
const fromCatalog = new Map<string, ModelContextCapacity>();

/** Um modelo do catálogo com o que o provedor informa dele; `null` é "sem dado" (nunca vira um teto inventado). */
export interface CatalogCapacity {
  /** Id do produto (`anthropic/<modelo>`). */
  model: string;
  maxInputTokens: number | null;
  maxTokens: number | null;
}

/**
 * Substitui as capacidades de UM provedor pelas da leitura atual do catálogo dele: o que a leitura não traz (modelo que saiu da lista, ou sem `max_input_tokens`) deixa de valer, e
 * o modelo sem janela informada não ganha capacidade alguma. Chamado por `ModelService` a cada leitura; é síncrono e por processo (a API e o worker leem o catálogo cada um).
 * ponytail: cache em memória por processo, preenchido na subida e a cada leitura do catálogo (60 s); um processo que ainda não leu o catálogo usa a janela escolhida sem teto. Trocar por
 * colunas em `model_profiles` se aparecer um modelo Claude com contexto menor que a janela escolhida e o estado mostrado na API divergir do que o worker aplica.
 */
export function replaceCatalogCapacities(provider: ModelProvider, entries: readonly CatalogCapacity[], checkedAt: Date): void {
  for (const key of [...fromCatalog.keys()]) if (key.startsWith(`${provider}/`)) fromCatalog.delete(key);
  for (const entry of entries) {
    if (entry.maxInputTokens === null) continue;
    const parsed = modelContextCapacitySchema.safeParse({ provider, model: entry.model, contextTokens: entry.maxInputTokens, outputTokens: entry.maxTokens, source: ANTHROPIC_SOURCE, checkedAt: checkedAt.toISOString() });
    if (parsed.success) fromCatalog.set(entry.model, parsed.data);
  }
}

/** Ausência de metadado não apaga o registro fundamentado; outro provedor/ID permanece desconhecido. Devolve uma cópia, o registro nunca é mutado por quem lê. */
export function readModelContextCapacity(model: string | null, provider = 'opencode_go'): ModelContextCapacity | null {
  const found = REGISTRY.find((entry) => entry.provider === provider && entry.model === model) ?? (model === null ? undefined : fromCatalog.get(model));
  return found ? { ...found } : null;
}
