// Calibração do orçamento de contexto pelo usage real do provedor (fonte única para execução, resumo e manutenção manual).
//
// O estimador de `context-budget.ts` conta 1 token por byte do corpo serializado: nunca subestima, mas fica ~3,5x acima do real e fazia a
// preparação reduzir e resumir (chamadas pagas, saída a US$ 1,20/M no DeepSeek) com poucos milhares de tokens reais numa janela pequena (a de 32k, que era o
// padrão na época; a menor opção hoje é 64k, mas o erro de escala da estimativa é o mesmo em qualquer janela).
// Aqui a razão observada (tokens de entrada informados ÷ estimativa local da MESMA chamada) das chamadas principais recentes do mesmo modelo
// reduz a estimativa. Usa a MAIOR razão da amostra mais folga, então continua conservador frente à variação entre pedidos.
import type { Queryable } from '../db/pool';

/** Amostra suficiente para cobrir variação de idioma/JSON entre execuções recentes sem depender de uma única chamada. */
const SAMPLE = 20;
/** Folga sobre a maior razão observada: protege contra pedido mais denso em tokens que os amostrados. */
const SAFETY = 1.2;
/**
 * Piso da escala: nenhum texto real fica abaixo de ~1 token a cada 5 bytes nos protocolos atuais. É também a hipótese MAIS OTIMISTA plausível: o executor
 * a usa para conferir um pedido sem calibração cujo piso passa do teto de 1 byte por token (se nem assim cabe, não cabe).
 */
export const MIN_SCALE = 0.2;
/**
 * Razão abaixo disto é usage implausível (provedor que informa só parte da entrada, ou valor fixo): a amostra é descartada, nunca encolhe
 * o orçamento. Texto/JSON em português, inglês, CJK ou emoji ficam entre ~0,25 e 1 token por byte.
 * É a regra ÚNICA de plausibilidade do usage de entrada (phase 9, CTX-08) e vale em três pontos, todos por esta constante: a calibração da escala
 * (`readTokenCalibration`, SQL), a âncora da ocupação (`readContextAnchor` em `context-anchor.ts`, SQL) e a medição regravada ao fim da chamada
 * (`isPlausibleUsage` abaixo, usada por `settleMeasurementAfterResponse`). Assim a amostra que calibra, a que ancora e a que o indicador exibe
 * nunca são verdades diferentes. Mudar o valor ou a comparação exige mudar os três juntos.
 */
export const MIN_PLAUSIBLE_RATIO = 0.12;

/**
 * Forma em JS da regra `MIN_PLAUSIBLE_RATIO`: o usage de entrada informado cabe como medição real quando a razão contra a estimativa textual CRUA
 * do mesmo pedido (`textTokens` de `estimateChatPayload`, a que `recordUsageEstimate` grava) é ao menos a mínima plausível. Pedido com imagem também
 * serve de referência: o usage inclui as imagens e a estimativa crua não, então só o texto basta para reprovar um valor pequeno demais.
 * Sem estimativa positiva não há referência e o usage não é aceito.
 */
export function isPlausibleUsage(inputTokens: number, estimatedTextTokens: number): boolean {
  return estimatedTextTokens > 0 && inputTokens / estimatedTextTokens >= MIN_PLAUSIBLE_RATIO;
}

/** `scale`: fator multiplicativo da estimativa textual (1 = teto por bytes). `calibrated`: existe amostra válida do modelo, mesmo que a escala fique em 1. */
export interface TokenCalibration { scale: number; calibrated: boolean }

/**
 * Calibração do modelo: o fator multiplicativo da estimativa textual e se ele vem de usage observado. Só considera chamadas principais concluídas com usage
 * informado e estimativa gravada (pedidos sem imagem, ver `recordUsageEstimate`); sem amostra, mantém o teto por bytes e `calibrated` é falso. As duas
 * informações saem da MESMA consulta: "calibrado" não é "escala menor que 1", porque uma razão observada alta (texto denso em tokens) deixa a escala em 1
 * com a amostra válida, e então o teto por bytes é a medida real, não uma suposição.
 * ponytail: razão global por modelo, trocar por razão por protocolo se o mesmo ID passar a ser servido por adaptadores diferentes.
 */
export async function readTokenCalibration(db: Queryable, model: string): Promise<TokenCalibration> {
  const found = await db.query<{ ratio: string | null }>(
    `SELECT max(input_tokens::float8 / estimated_input_tokens) AS ratio FROM (
       SELECT input_tokens, estimated_input_tokens FROM model_call_usage
       WHERE model = $1 AND purpose = 'main' AND state = 'completed' AND estimated_input_tokens IS NOT NULL AND input_tokens IS NOT NULL
         AND input_tokens::float8 / estimated_input_tokens >= $3
       ORDER BY completed_at DESC LIMIT $2) recent`,
    [model, SAMPLE, MIN_PLAUSIBLE_RATIO],
  );
  const ratio = Number(found.rows[0]?.ratio ?? NaN);
  if (!Number.isFinite(ratio) || ratio <= 0) return { scale: 1, calibrated: false };
  return { scale: Math.min(1, Math.max(MIN_SCALE, ratio * SAFETY)), calibrated: true };
}

/**
 * Grava a estimativa textual CRUA (`textTokens` de `estimateChatPayload`, sem escala) do pedido que a preparação acabou de medir, para comparar com o usage
 * informado depois. É a mesma estimativa que o gatilho e a medição usaram (mesma função, mesmo `maxTokens` de reserva de saída), e não uma segunda conta
 * sobre o pedido enviado: a razão `input_tokens ÷ estimated_input_tokens` calibra a escala (`readTokenCalibration`) e a diferença contra o pedido seguinte
 * ancora a ocupação (`context-anchor.ts`), e as duas só são coerentes se a estimativa gravada for exatamente a que será subtraída. Pedido com imagem não
 * vira amostra nem âncora (o teto visual é separado e não escala).
 */
export async function recordUsageEstimate(db: Queryable, usageId: string, estimate: { textTokens: number; images: number }): Promise<void> {
  if (estimate.images > 0 || estimate.textTokens <= 0) return;
  await db.query('UPDATE model_call_usage SET estimated_input_tokens = $2 WHERE id = $1', [usageId, estimate.textTokens]);
}
