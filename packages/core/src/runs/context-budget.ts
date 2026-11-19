// Orçamento conservador do corpo efetivamente serializado, compartilhado entre preparação e ensaio offline.
//
// Fluxo de contexto que estas constantes e funções sustentam (phase 9): o pedido de cada etapa leva o histórico como foi gravado e só cresce no fim (a limpeza fria da phase 11, em `cold-maintenance.ts`, é a outra exceção); ao chegar a
// `COMPACTION_THRESHOLD` do orçamento de entrada, a compactação (`compaction.ts`) troca o histórico antigo por um checkpoint estruturado e mantém íntegro um trecho
// final de até `TAIL_SHARE`; o colapso em índice (`context-collapse.ts`) só entra como rede de segurança acima de 100%. A ocupação é medida por `context-anchor.ts`
// (usage real da última chamada mais o acréscimo estimado aqui); a estimativa por bytes é o que vale na primeira chamada e para o que entrou depois da âncora.
import { EFFORT_LEVELS } from '@aion/shared';
import { PROTOCOLS, type ChatProtocol, type ChatRequest } from '../models/chat-protocols';
import { RESERVED_RUNTIME_TOOLS } from './tool-discovery';

/** Tokens que uma imagem ocupa no pedido quando o teto visual do modelo é conhecido (`visualCostKnown`). Fonte única da estimativa do pedido e do custo das linhas (`rowTokens`, `compaction.ts`). */
export const IMAGE_TOKENS = 1024;

/**
 * O custo visual deste modelo neste protocolo é conhecido (há um teto documentado por imagem)? Só então uma imagem pode ser estimada (`IMAGE_TOKENS`) e o pedido que a
 * leva é confiável; sem isso o motor recusa o pedido com imagem (`CONTEXT_ESTIMATE_UNAVAILABLE`). Também decide se as imagens de rodadas anteriores seguem inline no histórico
 * (`historyImages` de `buildTurns`): onde o custo é desconhecido, só a imagem da rodada atual falha alto e as anteriores não travam a conversa.
 * A ficha Go liga este ID aos pesos cuja vision_config.max_image_tokens=1024; safe_resize limita cada imagem.
 * Fontes: https://opencode.ai/data/deepseek/deepseek-v4-1-flash e
 * https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/config.json (inference/image_processor.py).
 * ponytail: Go não publica digest do deployment; revalidar este teto se o gateway trocar os pesos/processamento visual.
 */
export function visualCostKnown(model: string, protocol: ChatProtocol, provider = 'opencode_go'): boolean {
  return provider === 'opencode_go' && model === 'opencode/deepseek-v4.1-flash' && protocol === 'chat_completions';
}

/**
 * Estimativa não é usage: bytes UTF-8 evitam assumir inglês, JSON simples ou caracteres ASCII. Sem calibração (`scale` 1), cada byte conta como
 * um token, teto seguro porém cerca de 3,5 vezes acima do real no DeepSeek medido em 12/10/2026 (11.275 bytes = 3.194 tokens). Esse excesso
 * disparava compactação paga com poucos milhares de tokens reais; `scale` < 1 vem de `readTokenCalibration` (usage observado do mesmo modelo).
 */
export function estimateChatPayload(request: ChatRequest, protocol: ChatProtocol, provider = 'opencode_go', scale = 1) {
  const images = request.turns.reduce((count, turn) => count + (turn.role === 'user' ? turn.images?.length ?? 0 : 0), 0);
  const visualBoundKnown = visualCostKnown(request.model, protocol, provider);
  // Só os bytes binários saem da contagem textual, mantendo tipo, prefixo data URL e estrutura do adaptador.
  // O clone serve exclusivamente à estimativa: request, fingerprint e payload realmente enviado permanecem intactos.
  const measuredRequest: ChatRequest = images > 0 && visualBoundKnown ? { ...request, turns: request.turns.map((turn) =>
    turn.role === 'user' && turn.images?.length ? { ...turn, images: turn.images.map((image) => ({ ...image, base64: '' })) } : turn) } : request;
  // O corpo é o do protocolo real do modelo (o perfil gravado no teste, ou o palpite padrão quando o modelo nunca foi testado); a estimativa nunca sonda o modelo.
  const payloadBytes = Buffer.byteLength(JSON.stringify(PROTOCOLS[protocol].body(measuredRequest)), 'utf8');
  const framingTokens = 256 + request.turns.length * 16 + (request.tools?.length ?? 0) * 32;
  const imageTokens = visualBoundKnown ? images * IMAGE_TOKENS : 0;
  // Texto escala pela calibração; o teto visual documentado não é calibrado (o usage observado só amostra pedidos sem imagem).
  const textTokens = payloadBytes + framingTokens;
  const calibrated = scale > 0 && scale < 1;
  return { method: calibrated ? 'utf8-body-calibrated-v1' as const : 'utf8-body-upper-bound-v1' as const, payloadBytes, framingTokens, imageTokens, textTokens, estimatedInputTokens: (calibrated ? Math.ceil(textTokens * scale) : textTokens) + imageTokens, reliable: images === 0 || visualBoundKnown, images };
}

/**
 * Teto base de tokens de saída por etapa (phase 12, F1; decisão do dono em 18/10/2026): constante de código, sem configuração por ambiente nem por bot. O teto de 8.192 anterior
 * cortava respostas do `deepseek-v4.1-flash` quando o raciocínio sozinho o esgotava. É só o TETO BASE: o valor enviado ao provedor sai de `contextEnvelope`, que ainda o limita pela
 * janela efetiva (`OUTPUT_WINDOW_SHARE`) e pela capacidade de saída confirmada do modelo. Fonte única de `DEFAULT_RUN_CONFIG.maxTokens` (executor) e do estado de contexto
 * (`context-state.ts`), que precisa da mesma conta para saber qual reserva a medição gravada deveria ter.
 */
export const MAX_OUTPUT_TOKENS = 32_768;

/** Fração máxima da janela efetiva que a saída de UMA etapa pode ocupar (phase 12, F1): evita que a reserva de saída consuma a janela das janelas menores (64k reserva 16.384, não 32.768). */
export const OUTPUT_WINDOW_SHARE = 0.25;

/**
 * Envelope de uma etapa: reserva de saída, margem fixa e o orçamento de entrada que sobra da janela efetiva (CTX-04, phase 12). A reserva é o menor entre `maxTokens` (o teto base,
 * `MAX_OUTPUT_TOKENS` no motor), `OUTPUT_WINDOW_SHARE` da janela (arredondado para baixo) e a capacidade de saída confirmada do modelo, quando houver; nunca passa dela, para o provedor
 * não recusar o `max_tokens`. FONTE ÚNICA do número: o executor o usa na estimativa, no `max_tokens` do corpo enviado e no log, então a estimativa e o corpo nunca divergem. Resultado:
 * 64k reserva 16.384 (entrada 47.104), 128k reserva 32.768 (96.256), 256k (227.328) e 512k (489.472) idem, e um modelo com capacidade de saída de 4.096 reserva 4.096.
 */
export function contextEnvelope(window: number, maxTokens: number, outputCapacity: number | null = null) {
  const outputReserve = Math.min(maxTokens, Math.floor(window * OUTPUT_WINDOW_SHARE), outputCapacity ?? maxTokens);
  return { window, outputReserve, margin: 2048, inputBudget: Math.max(0, window - outputReserve - 2048) };
}

/**
 * Limiar ÚNICO da compactação automática (phase 9, CTX-07; decisão do dono em 14/10/2026, substitui os gatilhos de 70% e 85% da phase 8): fração do orçamento de
 * entrada (`inputBudget` de `contextEnvelope`) que a ocupação do pedido (a mesma conta do indicador, ancorada no usage real quando há âncora) pode atingir
 * antes de cada chamada ao modelo, no bot e no Chat geral. No limiar ou acima, o histórico antigo vira um checkpoint e só o trecho final segue íntegro
 * (`compaction.ts`); os 10% restantes absorvem o que a etapa seguinte acrescenta antes da próxima checagem. O colapso em índice (`context-collapse.ts`) não tem
 * gatilho próprio: é a rede de segurança quando o pedido passa de 100%. "Compactar agora" no painel ignora este valor (age mesmo abaixo dele).
 */
export const COMPACTION_THRESHOLD = 0.9;

/**
 * Teto do trecho final que a compactação mantém íntegro, como fração do orçamento de entrada (spec Decisão 3). É um teto, não uma meta: o corte é por unidades
 * inteiras e o trecho sempre inclui a etapa mais recente e as mensagens do dono da rodada atual, mesmo que isso passe do teto.
 */
export const TAIL_SHARE = 0.25;

/**
 * Ocupação (fração do orçamento) a que a compactação e o colapso procuram devolver o pedido. Duas funções, uma só razão: (a) limita o trecho final quando o piso
 * (sistema, objetivo, catálogo) é grande, para que o pedido recém-compactado não fique de novo acima do limiar e pague um resumo a cada etapa; (b) é a meta folgada
 * do colapso, para o corte avançar só depois de o histórico crescer de novo (histerese do cache).
 */
export const COMPACTION_SETTLE = 0.7;

/**
 * Limite de saída da chamada de RESUMO, em tokens do provedor (fonte única: executor e testes). O limite do provedor conta o raciocínio do modelo junto
 * com o texto, e o resumo em si ocupa poucas centenas de tokens (teto de texto: 16.000 caracteres, conferido à parte). Com 2.048 no total, o deepseek-v4.1-flash
 * gastava tudo pensando e devolvia `finish_reason=length` sem nenhum texto: todo resumo, manual ou automático, virava CONTEXT_COMPACTION_FAILED (sonda real
 * em 13/10/2026, entrada de 33 a 108 KB: raciocínio de 2,3 a 4,1 mil tokens sem effort, 1,3 a 2,8 mil com effort baixo, 4,7 mil com effort máximo).
 * 6.144 = 2.048 do texto + 4.096 de folga para o raciocínio, abaixo da reserva de saída das chamadas principais em toda janela de 64k ou mais (16.384 na menor, ver
 * `contextEnvelope`), então entrada do resumo mais saída sempre cabe na janela que o orçamento de entrada já protege. A reserva maior da phase 12 não muda este teto: o resumo
 * segue com o limite próprio, e `compactContext` o reduz à reserva quando a capacidade de saída confirmada do modelo é menor que ele.
 */
export const SUMMARY_MAX_OUTPUT_TOKENS = 6144;

/**
 * Effort da chamada de resumo: o mais baixo que o modelo aceita, ou nenhum se ele não aceita nível algum. Resumir é compressão, não raciocínio: o effort do
 * bot (às vezes alto, escolhido para as tarefas dele) só aumentava o gasto com raciocínio e o risco de estourar o limite de saída antes do texto.
 * ponytail: modelo que raciocina sem aceitar nenhum nível de effort fica no raciocínio padrão dele (coberto só pela folga de `SUMMARY_MAX_OUTPUT_TOKENS`),
 * trocar por um teto próprio se algum desses modelos passar a estourar o limite.
 */
export function lowestEffort(levels: readonly string[]): string | undefined {
  // O vocabulário público já vem do mais baixo ao mais alto.
  return EFFORT_LEVELS.find((level) => levels.includes(level));
}

/**
 * CHAT GERAL (o bot não tem opcional publicada desde a phase 15, passo 11: a lista dele é fixa, portas e mais usadas, e este teto não o alcança). Fatia máxima do orçamento de entrada para sistema + objetivo + catálogo publicado; o resto (no mínimo 35%) é do histórico. O teto não depende do
 * tamanho do histórico: antes os schemas saíam um a um conforme o histórico crescia (a cada etapa de uma rodada longa, derrubando o cache do prefixo e
 * a capacidade do modelo) e, quando o histórico sozinho não cabia, saíam TODOS sem que isso adiantasse. Quem encolhe o histórico é a compactação
 * (`compaction.ts`) e, em último caso, o colapso (`context-collapse.ts`), nunca o catálogo.
 * O teto disputa só as ferramentas OPCIONAIS (selecionadas por `discover_tools`, a web): as core e as portas ficam fora dele (decisão do dono
 * em 13/10/2026: função antes de custo). O teto efetivo é, portanto, max(65%, sistema + objetivo + core + portas): quando esse piso sozinho passa dos
 * 65%, nenhuma opcional cabe e o histórico fica com o que sobra, compactado pela compactação e, em último caso, pelo colapso. Sem código extra para o max: o piso é o que `fitToolCatalog` não consegue retirar.
 * Phase 12 (F2, TOOL-01 substituída parcialmente): o teto só vale DEPOIS de uma compactação aplicada e só para as opcionais que ela deixou para trás (`selectCatalog`, `selectedBeforeCut`); antes
 * disso o catálogo só cresce, porque cada ferramenta que sai ou muda de lugar relê o prefixo sem cache. Se o catálogo crescer antes da compactação, vale a compactação a 90% de sempre; só se nem ela nem o colapso fizerem o pedido caber, o executor tira as opcionais daquele pedido antes de recusar.
 */
export const CATALOG_SHARE = 0.65;

/**
 * Retira schemas das ferramentas opcionais até o pedido caber em `inputBudget`, mantendo as duas portas e TODAS as ferramentas core (`core`, os nomes que o
 * motor lista em `core`, a lista fixa do bot ou as core do Chat geral): nenhuma ferramenta publicada fixa sai por pressão de contexto; se o piso não couber, quem
 * cede é o histórico (ver `CATALOG_SHARE`). Catálogo é exposição, não permissão. A ordem de saída é a de `request.tools` (a primeira opcional sai primeiro): quem chama decide, e o motor passa a
 * seleção mais antiga primeiro (`CatalogPlan.droppable`). Não há ordem por uso recente nem escala de calibração de propósito (phase 12, decisão 9): ambas mudam de uma etapa para a outra, e o
 * conjunto publicado tem de ser função só do que está gravado (a estimativa é a de 1 byte por token, o teto conservador, sempre a mesma). O executor mede o catálogo só com sistema e objetivo
 * (ver `CATALOG_SHARE`), nunca com o histórico.
 */
export function fitToolCatalog(request: ChatRequest, protocol: ChatProtocol, inputBudget: number, core: readonly string[] = []): { request: ChatRequest; omitted: string[] } {
  const removable = (request.tools ?? []).filter((tool) => !RESERVED_RUNTIME_TOOLS.has(tool.name) && !core.includes(tool.name));
  let tools = request.tools;
  const omitted: string[] = [];
  for (const tool of removable) {
    if (estimateChatPayload({ ...request, tools, turns: withCatalogOmissions(request.turns, omitted) }, protocol).estimatedInputTokens <= inputBudget) break;
    tools = tools?.filter((item) => item.name !== tool.name);
    omitted.push(tool.name);
  }
  return { request: { ...request, tools, turns: withCatalogOmissions(request.turns, omitted) }, omitted };
}

/**
 * Estado transitório separado do pedido do dono; IDs/args das chamadas históricas continuam intactos. O aviso é função SÓ da lista de omitidas (na ordem de saída, que é determinística) e, por
 * isso, idêntico enquanto o conjunto publicado não muda (phase 12, decisão 11): ele só aparece quando uma compactação deixou opcionais para trás e só muda no mesmo ponto em que o campo `tools`
 * muda, então não reescreve o começo do histórico (índice 1 do pedido) entre etapas.
 */
export function withCatalogOmissions(turns: ChatRequest['turns'], omitted: readonly string[]): ChatRequest['turns'] {
  if (!omitted.length) return turns;
  return [turns[0]!, { role: 'user', text: `# Catálogo publicado nesta etapa (estado do runtime, não pedido novo)\nSchemas descarregados por espaço: ${omitted.join(', ')}. O acesso e as chamadas gravadas não mudaram. Use discover_tools para selecionar novamente as ferramentas necessárias.` }, ...turns.slice(1)];
}
