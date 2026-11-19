// Nomes, preço e seções do seletor de modelo (phase 17, passo 11; UI-05; A23, A25 a A28), em funções puras: o que o seletor, os gatilhos (composer e campo de modelo) e a curadoria em Conexões mostram de um
// modelo, e como a lista se divide em Favoritos, Recentes e um grupo por provedor. Sem React nem DOM, para provar as regras sem tela (`model-selector.test.tsx`).
//
// O id do produto é `provedor/modelo` (`anthropic/claude-haiku-5-5`). A tela o mostra de dois jeitos (A28):
// - NOME, sem o prefixo, nas linhas dos grupos e da busca: o `display_name` do provedor (Anthropic: "Claude Haiku 5.5") ou o id local (OpenCode Go: "glm-5.1");
// - NOME COMPLETO, com o prefixo, onde o modelo aparece fora do grupo do provedor (Favoritos, Recentes) e nos gatilhos: "anthropic/Claude Haiku 5.5", "opencode/glm-5.1".
import { MODEL_PROVIDERS, MODEL_RECENTS_LIMIT, localModelId, parseModelId, providerOfModel, type ModelEntry, type ModelProvider } from '@aion/shared';

/** Nome do provedor como o dono o conhece (chips, grupos e a etiqueta dos resultados da busca). */
export const PROVIDER_LABELS: Record<ModelProvider, string> = { opencode: 'OpenCode Go', anthropic: 'Anthropic' };

/** Nome acessível da lista de cada grupo ("Modelos do OpenCode Go", "Modelos da Anthropic"): é por ele que o teclado e os testes encontram a lista. */
export const GROUP_LIST_NAMES: Record<ModelProvider, string> = { opencode: 'Modelos do OpenCode Go', anthropic: 'Modelos da Anthropic' };

/** Nome do provedor do id (`OpenCode Go` quando o prefixo não é conhecido: é o provedor de antes da phase 17). */
export const providerLabelOf = (id: string): string => PROVIDER_LABELS[providerOfModel(id) ?? 'opencode'];

/** Nome sem prefixo: o `display_name` do provedor quando existe, ou o id local. */
export const modelName = (entry: Pick<ModelEntry, 'id' | 'displayName'>): string => entry.displayName ?? localModelId(entry.id);

/**
 * Nome completo `provedor/nome`: o `display_name` da entrada quando ela é conhecida e o tem, ou o id local. Um id sem prefixo conhecido volta como veio (nada é inventado). Sem a entrada (a lista
 * ainda não chegou, ou o servidor ainda não leu o catálogo do provedor) o nome é o id local depois do prefixo, e passa a "anthropic/Claude Haiku 5.5" quando a entrada chega.
 */
export function modelFullName(id: string, entry?: Pick<ModelEntry, 'displayName'> | null): string {
  const parsed = parseModelId(id);
  return parsed === null ? id : `${parsed.provider}/${entry?.displayName ?? parsed.local}`;
}

const priceNumber = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 });

/** Selo de preço (A23): entrada/saída em US$ por milhão de tokens, ou "preço desconhecido" quando o modelo não tem linha na tabela. */
export function priceLabel(price: ModelEntry['price']): string {
  return price ? `US$ ${priceNumber.format(price.input)}/${priceNumber.format(price.output)}` : 'preço desconhecido';
}

/** Motivo do modelo indisponível (A21), dito UMA vez por seletor (no cabeçalho do grupo ou sob "Resultados") e ligado a cada linha indisponível por `aria-describedby`. */
export const UNAVAILABLE_REASON = 'Indisponível: os créditos da Anthropic acabaram.';

/** Explicação do selo de preço, para o `title` e o leitor de tela. */
export const PRICE_HINT = 'US$ por milhão de tokens: entrada/saída';

/** O modelo aceita imagens? Só com a visão comprovada (`acceptsImages` verdadeiro); sem resultado conclusivo não há selo. */
export const hasVision = (entry: Pick<ModelEntry, 'acceptsImages'>): boolean => entry.acceptsImages === true;

/** O modelo expõe o controle de effort? Só quando o teste mostrou ao menos um nível aceito. */
export const hasEffort = (entry: Pick<ModelEntry, 'test'>): boolean => (entry.test?.effortLevels.length ?? 0) > 0;

export interface ProviderGroup {
  provider: ModelProvider;
  /** As entradas do grupo (já sem as ocultas, exceto a escolha atual). */
  entries: ModelEntry[];
}

export interface SelectorSections {
  favorites: ModelEntry[];
  recents: ModelEntry[];
  /** Um grupo por provedor que tem modelo para mostrar, na ordem de `MODEL_PROVIDERS`. */
  groups: ProviderGroup[];
  /** Com busca: a lista única de resultados, de todos os provedores (cada linha mostra o provedor). Sem busca, `null`. */
  results: ModelEntry[] | null;
}

export interface SectionOptions {
  /** Texto da busca; vazio mostra as seções. */
  query: string;
  /** Chip escolhido: só os modelos desse provedor. Nulo é "Todos". */
  provider: ModelProvider | null;
  /** Ids dos modelos usados mais recentemente (do mais novo ao mais antigo), como o servidor os devolve. */
  recents: readonly string[];
  /** Modelo atualmente escolhido: continua aparecendo mesmo oculto (com o selo "oculto"), para o dono ver o que está em uso. */
  current: string | null;
  /** Quantos recentes a seção mostra; o padrão é `MODEL_RECENTS_LIMIT` (A26), o mesmo número com que o servidor corta a lista. */
  recentLimit?: number;
}

/**
 * Divide a lista do servidor nas seções do seletor (A25 a A27). Regras:
 * - Modelo oculto sai das escolhas novas (A7) e fica só quando é a escolha atual (A9); indisponível por saldo esgotado continua na lista (com o selo), porque o dono precisa ver por que não pode escolhê-lo (A21);
 * - o chip filtra tudo por provedor; sem busca vêm Favoritos (do mais antigo ao mais novo, como no servidor), Recentes (até `recentLimit`) e os grupos; com busca vem uma lista só, de todos os provedores (A27),
 *   que casa com o nome, o id, o id local e o nome do provedor, sem diferença de caixa.
 */
export function buildSections(models: readonly ModelEntry[], { query, provider, recents, current, recentLimit = MODEL_RECENTS_LIMIT }: SectionOptions): SelectorSections {
  const eligible = models.filter((entry) => (entry.hidden !== true || entry.id === current) && (provider === null || providerOfModel(entry.id) === provider));
  const needle = query.trim().toLowerCase();
  if (needle !== '') {
    const results = eligible.filter((entry) => `${modelName(entry)} ${entry.id} ${providerLabelOf(entry.id)}`.toLowerCase().includes(needle));
    return { favorites: [], recents: [], groups: [], results };
  }
  const favorites = eligible.filter((entry) => entry.favorite).sort((a, b) => (a.favoritedAt ?? '').localeCompare(b.favoritedAt ?? '') || a.id.localeCompare(b.id));
  const byId = new Map(eligible.map((entry) => [entry.id, entry]));
  const recent = recents.flatMap((id) => byId.get(id) ?? []).slice(0, recentLimit);
  const groups = MODEL_PROVIDERS.flatMap((name) => {
    const entries = eligible.filter((entry) => providerOfModel(entry.id) === name);
    return entries.length > 0 ? [{ provider: name, entries }] : [];
  });
  return { favorites, recents: recent, groups, results: null };
}

/** Provedores que têm ao menos um modelo na lista, na ordem dos chips (A25: Anthropic antes do OpenCode Go). Os chips só aparecem com mais de um. */
export function chipProviders(models: readonly ModelEntry[]): ModelProvider[] {
  const present = new Set(models.map((entry) => providerOfModel(entry.id)));
  return (['anthropic', 'opencode'] as const).filter((name) => present.has(name));
}
