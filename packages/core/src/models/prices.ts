// Tabela de preços dos modelos, por id do produto (`provedor/modelo`): fonte única do selo de preço do seletor (`ModelService`, A23) e do relatório de custo (`usage/cost-report.ts`, A24).
// Chaveada por `provedor/modelo` para o mesmo Claude ter um preço por provedor (o OpenCode Go e a Anthropic cobram diferente) e o relatório separá-lo.
//
// Os preços são em US$ por milhão de tokens. Nenhum provedor publica preço por API, então a tabela é manual: modelo sem linha aqui não tem selo ("preço desconhecido") e o relatório o mostra só em tokens.

/**
 * Preço de um modelo em US$ por milhão de tokens. `cached` é a leitura de cache; `input` é a entrada sem cache. `cacheWrite` é o preço da GRAVAÇÃO de cache, só para o modelo
 * que o cobra à parte (protocolo `messages`, cache explícito); ausente = o modelo não declara gravação à parte, e qualquer token gravado que o ledger registre é cobrado
 * pelo preço de `input` (o relatório nunca deixa token de entrada sem preço).
 */
export interface ModelPrice {
  input: number;
  cached: number;
  output: number;
  cacheWrite?: number;
}

/**
 * OpenCode Go: copiados da tabela do OpenCode Go (opencode.ai/docs/go, 16/10/2026). O Claude Haiku 5.5 tem preço por faixa e aqui vale a de até 100K tokens de entrada (acima, tudo custa 5 vezes mais).
 * Gravação de cache do Haiku 5.5: 1,25 vez a entrada (0,125 US$/M), o multiplicador da escrita de cache de 5 minutos (`cache_control` `ephemeral`, o que o Aion envia) da documentação oficial de prompt
 * caching da Anthropic (docs.anthropic.com, Prompt caching, seção de preços, que também fixa a leitura em 0,1 vez a entrada). DeepSeek e MiMo não declaram `cacheWrite`: o cache deles é automático e sem
 * gravação cobrada à parte.
 *
 * Anthropic direta (phase 17, A23): entrada e saída conferidas na skill claude-api (Haiku 5.5 a 0,10/0,50, Sonnet 5.5 a 2/10 e Opus 5.5 a 4/20 por milhão de tokens). A gravação do cache de 5 minutos é 1,25 vez a
 * entrada em todos; a LEITURA é 0,1 vez no Haiku 5.5 (US$ 0,01) e 0,05 vez no Sonnet 5.5 (US$ 0,10) e no Opus 5.5 (US$ 0,20), conforme a seção de economia do prompt caching da skill. Os ids saem de `GET /v1/models`;
 * modelo que a Anthropic lista e não está aqui fica sem selo até a tabela ganhar a linha dele.
 *
 * ponytail: tabela manual e sem faixa de contexto (acima de 100K tokens de entrada o preço real é maior), trocar por leitura de catálogo de preços se o Aion passar a usar vários modelos com frequência.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'opencode/deepseek-v4.1-flash': { input: 0.3, cached: 0.006, output: 1.2 },
  'opencode/mimo-v2.6-pro': { input: 0.435, cached: 0.003625, output: 0.87 },
  'opencode/claude-haiku-5-5': { input: 0.1, cached: 0.01, output: 0.5, cacheWrite: 0.125 },
  'anthropic/claude-haiku-5-5': { input: 0.1, cached: 0.01, output: 0.5, cacheWrite: 0.125 },
  'anthropic/claude-sonnet-5-5': { input: 2, cached: 0.1, output: 10, cacheWrite: 2.5 },
  'anthropic/claude-opus-5-5': { input: 4, cached: 0.2, output: 20, cacheWrite: 5 },
};

/** Entrada e saída por milhão de tokens, o que o selo do seletor mostra; `null` = preço desconhecido (sem linha na tabela). */
export function listPrice(model: string): { input: number; output: number } | null {
  // `hasOwn`: um id como `constructor` não pode herdar uma "linha" do protótipo do objeto.
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
  return price === undefined ? null : { input: price.input, output: price.output };
}
