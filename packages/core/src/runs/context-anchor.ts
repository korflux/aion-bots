// Âncora da medição de contexto (phase 9, F1, CTX-08): a ocupação do pedido parte dos tokens de entrada que o provedor informou na última chamada principal e
// soma só o que mudou desde então. É a ÚNICA conta de ocupação do PEDIDO: o gatilho da preparação, a medição gravada para o indicador e a decisão de "não
// cabe" (`CONTEXT_TOO_LARGE`) usam o mesmo número, e a medição regravada ao fim da chamada (`settleMeasurementAfterResponse`) parte do mesmo usage, sob a
// mesma regra de plausibilidade (`MIN_PLAUSIBLE_RATIO` de `token-calibration.ts`).
// Exceção intencional: o teto do CATÁLOGO de ferramentas (`fitToolCatalog` no executor; só o Chat geral tem opcional publicada, a lista do bot é fixa desde a phase 15) é uma fração fixa do orçamento (`CATALOG_SHARE`) medida pela estimativa de 1 byte
// por token (sem calibração e sem âncora) e sem histórico, e só retira opcional depois de uma compactação aplicada (phase 12; a rede de segurança que a tira de um pedido que
// não cabe de outra forma é o único outro caso). Ancorar ou calibrar esse teto o faria oscilar com o usage de cada chamada e trocaria o conjunto de schemas publicados de uma etapa
// para outra, quebrando a estabilidade do cache do provedor; o catálogo não é "ocupação do pedido", é uma reserva fixa dentro dele.
//
// Por que existe: o estimador de `context-budget.ts` conta bytes e fica ~3,5x acima do real; `token-calibration.ts` reduz essa folga com uma razão observada por
// modelo, mas continua uma estimativa conservadora do pedido INTEIRO. Depois de uma chamada, o provedor já disse o tamanho real daquele pedido (incluindo o que
// leu do cache: o contrato de `models/chat-protocols.ts` informa `inputTokens` com o cache dentro). O que falta saber é só a diferença entre aquele pedido e o atual.
//
// Pontos de extensão: `readContextAnchor` (de onde vem a âncora e quando ela vale) e `anchoredInputTokens` (a conta, pura) são independentes do executor.
import type { Queryable } from '../db/pool';
import { MIN_PLAUSIBLE_RATIO } from './token-calibration';

/**
 * Última chamada principal concluída que serve de base. `inputTokens` é o usage real do provedor (cache incluído); `estimatedTokens` é a estimativa CRUA
 * (`textTokens` de `estimateChatPayload`, sem escala nem imagens) que o executor gravou para aquele mesmo pedido, com os mesmos parâmetros do gatilho.
 */
export interface ContextAnchor { inputTokens: number; estimatedTokens: number }

/** Estimativa do pedido atual na forma crua de `estimateChatPayload` (`textTokens`, antes da escala) mais o teto fixo das imagens, que a calibração não escala. */
export interface CurrentRequestEstimate { textTokens: number; imageTokens: number }

/**
 * Âncora válida da conversa para o modelo da chamada, ou nulo (então vale a estimativa calibrada, como na primeira chamada: CTX-06 inalterada).
 * Regras, todas conferidas aqui e em nenhum outro lugar:
 *  - é a chamada principal concluída mais recente que tem entrada informada e estimativa registrada, com a mesma plausibilidade que a calibração exige
 *    (`MIN_PLAUSIBLE_RATIO`): usage parcial ou valor fixo do provedor nunca vira base, só a estimativa calibrada continua valendo;
 *  - se essa chamada foi de OUTRO modelo, não há âncora (os tokenizadores diferem; a medição do modelo novo recomeça pela estimativa);
 *  - se um resumo foi aplicado depois dela (`summary_outcome = 'applied'`), não há âncora: o pedido mudou de forma (checkpoint novo), e o que a âncora
 *    mediu já não existe. Não há tabela de checkpoint por chamada; o resumo aplicado é o marcador. `>=` porque o relógio do domínio pode ser fixo nos testes
 *    e, em produção, um resumo aplicado ANTES da chamada principal sempre termina estritamente antes dela;
 *  - se uma limpeza fria foi gravada depois dela (`context_cold_masks.masked_at`, phase 11, T7), também não há âncora, pela mesma razão e com o mesmo `>=`: a limpeza trocou
 *    resultados antigos por marcadores, o pedido é outro, e até a próxima chamada principal vale a estimativa calibrada (spec, decisão 17).
 * Chamadas com imagem não gravam estimativa (`recordUsageEstimate`) e por isso nunca são âncora; a anterior a elas serve e o acréscimo inclui a imagem.
 * ponytail: marcador de checkpoint é o resumo aplicado na tabela de uso, trocar por uma coluna de revisão do checkpoint na chamada se outra operação
 * passar a mudar o pedido sem gerar `summary` aplicado.
 */
export async function readContextAnchor(db: Queryable, conversationId: string, model: string): Promise<ContextAnchor | null> {
  const found = await db.query<{ model: string; input_tokens: string; estimated_input_tokens: string; summarized_after: boolean }>(
    `SELECT u.model, u.input_tokens::text, u.estimated_input_tokens::text,
            (EXISTS(SELECT 1 FROM model_call_usage s WHERE s.conversation_id = u.conversation_id AND s.purpose = 'summary' AND s.state = 'completed'
                      AND s.summary_outcome = 'applied' AND s.completed_at >= u.completed_at)
             OR EXISTS(SELECT 1 FROM context_cold_masks k WHERE k.conversation_id = u.conversation_id AND k.masked_at >= u.completed_at)) AS summarized_after
       FROM model_call_usage u
      WHERE u.conversation_id = $1 AND u.purpose = 'main' AND u.state = 'completed'
        AND u.input_tokens IS NOT NULL AND u.estimated_input_tokens IS NOT NULL
        AND u.input_tokens::float8 / u.estimated_input_tokens >= $2
      ORDER BY u.completed_at DESC, u.created_at DESC LIMIT 1`,
    [conversationId, MIN_PLAUSIBLE_RATIO],
  );
  const row = found.rows[0];
  if (!row || row.model !== model || row.summarized_after) return null;
  return { inputTokens: Number(row.input_tokens), estimatedTokens: Number(row.estimated_input_tokens) };
}

/**
 * Ocupação do pedido atual em tokens: entrada real da âncora + a diferença entre a estimativa atual e a da âncora. Os dois lados vêm da MESMA função
 * (`estimateChatPayload`, parâmetros iguais), então só a diferença entre pedidos conta e os erros do estimador se cancelam na parte que não mudou.
 *  - Acréscimo: a diferença crua vira tokens pela escala calibrada (a MAIOR razão observada da amostra mais folga, portanto conservadora para o que é novo),
 *    nunca pelo teto de 1 byte por token.
 *  - Redução (colapso, catálogo menor): só se credita a razão observada na própria âncora, quando menor que a escala. A escala creditaria mais do
 *    que o removido pesava na média do pedido e declararia "cabe" um pedido que o provedor ainda recusaria. Essa razão é a MÉDIA do pedido inteiro da
 *    âncora, não um limite: se o trecho removido era mais denso em tokens que a média, o crédito ainda supera o que ele pesava e a ocupação sai subestimada.
 * Não há piso de `max(âncora + delta, acréscimo)`: com a âncora positiva e o pedido atual não negativo o resultado nunca é negativo (a redução máxima é a
 * razão da âncora aplicada à estimativa inteira dela, no máximo o próprio usage da âncora) e o acréscimo só soma.
 * Pedido idêntico ao da âncora devolve exatamente o usage dela, que é o que o indicador mostra logo depois da resposta.
 * `scale`: o de `readTokenCalibration` (0,2 a 1); `anchor.estimatedTokens` é sempre positivo (restrição da coluna, conferida na leitura).
 * ponytail: o crédito da redução usa a razão média da âncora e pode subestimar a ocupação quando o conteúdo removido é mais denso em tokens que a média do
 * pedido; revisar (razão por trecho ou crédito menor) se houver recusa de contexto do provedor (`rejectedContext`) com âncora ativa. A rede de segurança
 * hoje é a recarga depois da recusa, que descarta a âncora e mede pela estimativa calibrada.
 */
export function anchoredInputTokens(anchor: ContextAnchor, current: CurrentRequestEstimate, scale: number): number {
  const difference = current.textTokens - anchor.estimatedTokens;
  const observedRatio = anchor.inputTokens / anchor.estimatedTokens;
  const delta = difference >= 0 ? Math.ceil(difference * scale) : -Math.floor(-difference * Math.min(scale, observedRatio));
  return anchor.inputTokens + delta + current.imageTokens;
}
