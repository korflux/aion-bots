// Sonda de validação da chave do OpenCode Go (R8 da review do Marco 1; aceite A3; fluxo F3 passo 1; decisão do dono de 2026-10-01).
//
// POR QUE EXISTE: `GET /models` do provedor é público (responde 200 sem chave nenhuma, confirmado com a chave real), então
// listar os modelos nunca prova que a chave é válida. As rotas de chat, ao contrário, exigem a chave (chave falsa dá 401). A
// sonda faz UMA chamada de chat mínima e olha só o início da resposta: 2xx prova a chave, 401/403 a recusa.
//
// COMO DECIDE (a cada tentativa, com o protocolo `chat_completions`, o primeiro que a decisão do dono nomeia):
// - 2xx e o stream começou: chave válida (`verified`). A conexão é fechada logo em seguida, então o custo é de cerca de 1 token
//   (o teto pedido é 16, o mínimo que os três protocolos aceitam; o provedor para de gerar quando a conexão fecha).
// - 401 ou 403: a chave é recusada (`PROVIDER_KEY_INVALID`, vindo do cliente).
// - 408, 429, 5xx, rede ou prazo: não dá para saber agora (`PROVIDER_UNAVAILABLE`, vindo do cliente); a chave não é gravada e a
//   anterior continua valendo, como já era com a listagem.
// - 4xx de recusa da requisição (`ChatRejected`) ou stream fora do formato (`ChatStreamError`): é motivo do MODELO (modelo que
//   este protocolo não serve, plano sem acesso), não da chave. A sonda tenta o próximo modelo da lista, até `PROBE_MAX_MODELS`.
//   Se nenhum modelo der resposta que decida, a chave NÃO é recusada (`unverified`): foi a decisão do dono, e recusar uma chave
//   boa por causa de um modelo seria pior que aceitar sem provar.
//
// O catálogo do provedor só traz o id do modelo (sem protocolo), então "o primeiro modelo de chat_completions" é, na prática, o
// primeiro modelo da lista que o `chat_completions` aceita; os que ele recusa contam como motivo do modelo e a sonda segue.
// ponytail: sem modelo que decida a sonda devolve `unverified` e a chave é aceita sem prova; se isso acontecer no uso real,
// tentar também os protocolos `messages` e `responses` antes de desistir.
import { randomUUID } from 'node:crypto';
import { DomainError } from '../errors';
import { ChatRejected, ChatStreamError } from '../models/chat-protocols';
import type { ProviderClient } from './opencode-go';

/** Quantos modelos, no máximo, a sonda tenta antes de desistir (limita custo e tempo de um salvamento de chave). */
export const PROBE_MAX_MODELS = 3;
/** Teto de tokens de saída da sonda: o menor valor que chat/completions, responses e messages aceitam. */
export const PROBE_MAX_TOKENS = 16;
/** Prazo da sonda inteira (todas as tentativas). Estourado, a chamada em curso falha como `PROVIDER_UNAVAILABLE`. */
export const PROBE_DEADLINE_MS = 20_000;

/** `verified`: o provedor aceitou a chave num chat real. `unverified`: nenhuma tentativa decidiu (só motivos do modelo). */
export type KeyProbeResult = 'verified' | 'unverified';

export interface ProbeProviderKeyOptions {
  provider: ProviderClient;
  apiKey: string;
  /** Ids da lista do provedor, na ordem em que ele os devolveu. */
  models: readonly string[];
  /** Prazo geral da sonda; o chamador cria com `PROBE_DEADLINE_MS`. */
  signal?: AbortSignal;
}

/**
 * Prova a chave com uma chamada de chat mínima. Lança `PROVIDER_KEY_INVALID` (401/403) ou `PROVIDER_UNAVAILABLE`; qualquer
 * outro resultado é `verified` ou `unverified` (ver o cabeçalho do arquivo).
 */
export async function probeProviderKey({ provider, apiKey, models, signal }: ProbeProviderKeyOptions): Promise<KeyProbeResult> {
  for (const model of models.slice(0, PROBE_MAX_MODELS)) {
    const stream = provider.streamChat(
      apiKey,
      'chat_completions',
      // O provedor real exige o cabeçalho `x-opencode-session` (o cliente o monta a partir deste id): um id novo por sonda.
      { model, sessionId: randomUUID(), turns: [{ role: 'user', text: 'ok' }], maxTokens: PROBE_MAX_TOKENS },
      signal,
    );
    try {
      // Basta o stream começar (2xx e o primeiro evento): o status já decidiu sobre a chave.
      await stream.next();
      return 'verified';
    } catch (error) {
      if (error instanceof ChatRejected || error instanceof ChatStreamError) continue;
      throw error;
    } finally {
      await stream.return(undefined);
    }
  }
  return 'unverified';
}

/** Modelo da sonda da chave da Anthropic: o mais barato da família (restrição do dono para toda chamada real à Anthropic), pedido com o id do produto (`anthropic/<modelo>`). */
export const ANTHROPIC_PROBE_MODEL = 'anthropic/claude-haiku-5-5';

export interface ProbeAnthropicKeyOptions {
  provider: ProviderClient;
  apiKey: string;
  /** Prazo geral da sonda; o chamador cria com `PROBE_DEADLINE_MS`. */
  signal?: AbortSignal;
}

/**
 * Prova a chave da Anthropic com UMA chamada mínima ao `claude-haiku-5-5` pelo protocolo `messages` (16 tokens de saída). Diferente do OpenCode Go (`probeProviderKey`), a
 * prova é obrigatória: a chave só é aceita se o chat responde. Lança `PROVIDER_KEY_INVALID` (401/403, e também a recusa 4xx do pedido, porque uma chave que não consegue
 * chamar o modelo da prova não pode ser aceita) ou `PROVIDER_UNAVAILABLE` (408, 429, 5xx, rede, prazo, ou stream fora do formato); a chave anterior segue intacta em todas.
 * Saldo esgotado (HTTP 402 `billing_error`, ou 400 com a mensagem de saldo baixo) NÃO é chave recusada nem aceita sem prova: o cliente lança `PROVIDER_CREDITS_EXHAUSTED`, que sobe daqui sem ser
 * trocado, a chave não é gravada e a anterior segue intacta (A2). Fica de fora do `ChatRejected` justamente para não cair em "chave recusada" e confundir o dono, que precisa recarregar os créditos.
 * ponytail: qualquer outra recusa 4xx do pedido vira "chave recusada" aqui; separar por motivo se a Anthropic passar a recusar a chamada mínima por outra razão que não a chave.
 */
export async function probeAnthropicKey({ provider, apiKey, signal }: ProbeAnthropicKeyOptions): Promise<void> {
  const stream = provider.streamChat(apiKey, 'messages', { model: ANTHROPIC_PROBE_MODEL, sessionId: randomUUID(), turns: [{ role: 'user', text: 'ok' }], maxTokens: PROBE_MAX_TOKENS }, signal);
  try {
    // Basta o stream responder (2xx e o primeiro evento normalizado): o status já decidiu sobre a chave.
    await stream.next();
  } catch (error) {
    if (error instanceof ChatRejected) throw new DomainError('PROVIDER_KEY_INVALID');
    if (error instanceof ChatStreamError) throw new DomainError('PROVIDER_UNAVAILABLE');
    throw error;
  } finally {
    await stream.return(undefined);
  }
}
