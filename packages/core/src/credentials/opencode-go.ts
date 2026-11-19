// Adaptador do OpenCode Go (provedor de IA): UM módulo pequeno que isola o formato da API do serviço.
// A listagem de modelos (T3) alimenta o catálogo; a validação da chave é a sonda de chat de `key-probe.ts` (R8). T5 (teste de
// modelo) e T6 (execução) usam o chat em streaming.
//
// O QUE É CONFIRMADO E O QUE É SUPOSTO (documentação pública do OpenCode, consultada ao implementar T3 e T5):
// - Confirmado: base `https://opencode.ai/zen/go/v1`, autenticação por `Authorization: Bearer <chave>`, listagem em
//   `GET /models` (`{ "data": [{ "id": "..." }] }`, só o id, sem capacidades) e três protocolos de chat por modelo
//   (detalhes e suposições em `models/chat-protocols.ts`).
// - Observado ao implementar T5 (consulta sem chave): `GET /models` responde 200 SEM autenticação, então a listagem
//   não prova que a chave é válida. Por isso a chave é validada por uma sonda de chat (`key-probe.ts`, R8).
// - Confirmado com a chave real (2026-09-30): chave inventada recebe 401 nas três rotas de chat (`/chat/completions`,
//   `/responses` e `/messages`); a sonda depende disso. O mapeamento 401/403 (chave) e 408/429/5xx (indisponível) está em
//   `chatStatusError` e em `classifyStatus`.
// - 429 no chat (phase 17, passo 8, A22): o limite de uso do provedor chega como resposta HTTP, ANTES de qualquer evento do stream, então repetir a chamada não duplica texto, ferramenta nem custo.
//   Só a execução do motor liga a repetição (`ChatRequest.retryOnRateLimit`): até `RATE_LIMIT_BACKOFF_MS.length` novas tentativas, esperando o `Retry-After` do provedor (ou a espera crescente
//   quando ele não vem), e sem esperar nada acima de `RATE_LIMIT_MAX_WAIT_MS` (um pedido de espera maior que isso é do provedor, e o dono vê a falha em vez de uma execução parada). A parada do dono
//   interrompe a espera. Esgotadas as tentativas, a falha é a de sempre (`PROVIDER_UNAVAILABLE`), com a marca `ProviderRateLimited` na causa. O Composio e a Parallel não passam por aqui.
//   ponytail: a Anthropic (`anthropic.ts`) não repete o 429; fazer o mesmo lá se ele aparecer nos logs do worker.
import { localModelId } from '@aion/shared';
import { z } from 'zod';
import { DomainError } from '../errors';
import type { Logger } from '../logging';
import {
  ChatRejected,
  ChatStreamError,
  PROTOCOLS,
  type ChatEvent,
  type ChatProtocol,
  type ChatRequest,
} from '../models/chat-protocols';
import { SseLimitError, readSse } from '../models/sse';
import {
  UPSTREAM_TIMEOUT_MS,
  ProviderRateLimited,
  UpstreamUnreachable,
  classifyStatus,
  upstreamGetJson,
  upstreamPostStream,
  type FetchLike,
} from './upstream-http';

export interface ProviderModel {
  /** Identificador do modelo no provedor, ex.: `glm-5.1`. */
  id: string;
}

/** Porta do provedor usada por T3 (validar chave), T5 (listar e testar modelos) e T6 (executar). Erros vêm como `DomainError`. */
export interface ProviderClient {
  /**
   * Lista os modelos com a chave dada. Lança `PROVIDER_KEY_INVALID` (chave recusada) ou `PROVIDER_UNAVAILABLE`
   * (rede, timeout, erro do serviço ou resposta fora do formato esperado).
   */
  listModels(apiKey: string): Promise<ProviderModel[]>;
  /**
   * Uma chamada de chat em streaming no protocolo dado, normalizada em eventos (texto, chamada de ferramenta, fim).
   * Lança `PROVIDER_KEY_INVALID` (401/403), `PROVIDER_UNAVAILABLE` (rede, prazo, 408/429/5xx), `ChatRejected` (4xx: o
   * provedor não aceita esta combinação de modelo, protocolo e parâmetros) e `ChatStreamError` (stream fora do formato
   * ou sem o evento final). Parar de consumir o iterador cancela a conexão.
   */
  streamChat(apiKey: string, protocol: ChatProtocol, request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent>;
}

export interface UpstreamClientOptions {
  /** Base fixa vinda da configuração do servidor (nunca de entrada do usuário). */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  logger?: Logger;
}

export interface OpenCodeGoClientOptions extends UpstreamClientOptions {
  /** Prazo de uma chamada de chat inteira (conexão e stream). */
  chatTimeoutMs?: number;
  /** Espera entre as tentativas do 429 sem `Retry-After` (uma por tentativa extra), o teto de espera aceito e a espera em si; os testes encurtam os três. */
  rateLimitRetry?: { backoffMs?: readonly number[]; maxWaitMs?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> };
}

/** Esperas crescentes quando o provedor limita sem dizer quando voltar: duas novas tentativas, em 2 s e 5 s. */
const RATE_LIMIT_BACKOFF_MS: readonly number[] = [2_000, 5_000];
/** Maior espera aceita antes de uma nova tentativa (do `Retry-After` ou da tabela); acima disso a falha vale já. */
const RATE_LIMIT_MAX_WAIT_MS = 15_000;

/** Espera `ms` e termina antes se `signal` abortar (a parada do dono): o aborto vira `UpstreamUnreachable`, que o cliente traduz como `PROVIDER_UNAVAILABLE`. */
const sleepUnlessAborted = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new UpstreamUnreachable(signal.reason));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new UpstreamUnreachable(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Prazo de uma chamada de chat. ponytail: serve ao teste de modelo; a T6 passa um prazo maior para as execuções. */
const CHAT_TIMEOUT_MS = 30_000;
/** Teto finito do transporte SSE: envelopes por token podem superar 1MiB com poucos KiB de conteúdo.
 * Não altera maxTokens, prazo, validação do protocolo nem o teto de argumentos de ferramentas no executor. */
const MAX_CHAT_STREAM_BYTES = 16 * 1024 * 1024;

const modelsResponseSchema = z.object({ data: z.array(z.object({ id: z.string().min(1).max(200) })) });

/** 401 e 403 são chave; 408, 429 e 5xx são indisponibilidade; o resto é recusa desta requisição (`ChatRejected`). */
function chatStatusError(status: number, retryAfterMs?: number): Error {
  if (status === 401 || status === 403) return new DomainError('PROVIDER_KEY_INVALID');
  // O 429 leva a marca de "limite do provedor" (`cause`), para a execução gravá-lo como `RATE_LIMITED`; o código segue `PROVIDER_UNAVAILABLE` para quem já o trata (sonda, teste de modelo).
  if (status === 429) return new DomainError('PROVIDER_UNAVAILABLE', { cause: new ProviderRateLimited(retryAfterMs ?? null) });
  if (status === 408 || status >= 500) return new DomainError('PROVIDER_UNAVAILABLE');
  return new ChatRejected(status);
}

export function createOpenCodeGoClient({
  baseUrl,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  chatTimeoutMs = CHAT_TIMEOUT_MS,
  fetchImpl = fetch,
  logger,
  rateLimitRetry = {},
}: OpenCodeGoClientOptions): ProviderClient {
  const { backoffMs = RATE_LIMIT_BACKOFF_MS, maxWaitMs = RATE_LIMIT_MAX_WAIT_MS, sleep = sleepUnlessAborted } = rateLimitRetry;
  // ponytail: a recusa precisa identificar stream_options; ampliar os formatos reconhecidos se um gateway devolver outro envelope.
  // Compatibilidade por modelo nesta instância, sem persistir capacidade especulativa. Só lembramos após sucesso sem o parâmetro.
  const withoutStreamOptions = new Set<string>();
  return {
    async listModels(apiKey) {
      let response;
      try {
        response = await upstreamGetJson({
          url: `${baseUrl}/models`,
          headers: { authorization: `Bearer ${apiKey}` },
          timeoutMs,
          fetchImpl,
        });
      } catch (error) {
        if (error instanceof UpstreamUnreachable) {
          logger?.warn({ service: 'opencode-go' }, 'provedor inacessível');
          throw new DomainError('PROVIDER_UNAVAILABLE', { cause: error });
        }
        throw error;
      }

      const verdict = classifyStatus(response.status);
      if (verdict === 'key-invalid') throw new DomainError('PROVIDER_KEY_INVALID');
      if (verdict === 'unavailable') {
        logger?.warn({ service: 'opencode-go', status: response.status }, 'provedor respondeu com erro');
        throw new DomainError('PROVIDER_UNAVAILABLE');
      }

      const parsed = modelsResponseSchema.safeParse(response.json);
      if (!parsed.success) {
        logger?.warn({ service: 'opencode-go' }, 'provedor respondeu fora do formato esperado');
        throw new DomainError('PROVIDER_UNAVAILABLE');
      }
      return parsed.data.data.map(({ id }) => ({ id }));
    },

    async *streamChat(apiKey, protocol, request, signal) {
      const adapter = PROTOCOLS[protocol];
      let stream;
      try {
        const includeUsage = protocol === 'chat_completions' && request.includeUsage !== false && !withoutStreamOptions.has(request.model);
        /** Uma recusa HTTP acontece antes de qualquer evento; nunca repetimos stream parcial nem ação de ferramenta. */
        const send = (usage: boolean) => upstreamPostStream({
          url: `${baseUrl}${adapter.path}`,
          // `x-opencode-session` é exigido pelo provedor (ver `ChatRequest.sessionId`).
          headers: { ...adapter.authHeaders(apiKey), 'x-opencode-session': request.sessionId },
          // O id do produto é `provedor/modelo` (`opencode/glm-5.1`); o OpenCode Go só conhece o id local, então o prefixo sai aqui, o único ponto onde o pedido vira bytes (A30).
          body: adapter.body({ ...request, model: localModelId(request.model), includeUsage: usage }),
          timeoutMs: chatTimeoutMs,
          signal,
          fetchImpl,
          detectRejectedStreamOptions: usage,
          detectRejectedContext: true,
          detectRejectedImage: request.turns.some((turn) => turn.role === 'user' && (turn.images?.length ?? 0) > 0),
        });
        /** Um 429 (só antes de qualquer evento) é repetido, se o chamador pediu (`retryOnRateLimit`), dentro do prazo (ver o cabeçalho). */
        const sendRetrying = async (usage: boolean) => {
          for (let attempt = 0; ; attempt += 1) {
            const sent = await send(usage);
            if (sent.status !== 429 || sent.body !== null || request.retryOnRateLimit !== true || attempt >= backoffMs.length) return sent;
            const waitMs = sent.retryAfterMs ?? backoffMs[attempt]!;
            if (waitMs > maxWaitMs) return sent;
            logger?.warn({ service: 'opencode-go', protocol, attempt: attempt + 1, waitMs }, 'provedor limitou as chamadas; nova tentativa');
            await sleep(waitMs, signal);
          }
        };
        stream = await sendRetrying(includeUsage);
        if (includeUsage && stream.rejectedStreamOptions) {
          stream = await sendRetrying(false);
          if (stream.body !== null) withoutStreamOptions.add(request.model);
        }
      } catch (error) {
        if (error instanceof UpstreamUnreachable) {
          logger?.warn({ service: 'opencode-go', protocol }, 'provedor inacessível no chat');
          throw new DomainError('PROVIDER_UNAVAILABLE', { cause: error });
        }
        throw error;
      }
      if (stream.body === null) {
        const failure = chatStatusError(stream.status, stream.retryAfterMs);
        if (failure instanceof ChatRejected && stream.rejectedContext) throw new ChatRejected(stream.status, false, true);
        if (failure instanceof ChatRejected && stream.rejectedImage) throw new ChatRejected(stream.status, true);
        if (failure instanceof DomainError) logger?.warn({ service: 'opencode-go', protocol, status: stream.status }, 'chat recusado pelo provedor');
        throw failure;
      }

      const parse = adapter.parser();
      let finished = false;
      try {
        for await (const event of readSse(stream.body, MAX_CHAT_STREAM_BYTES)) {
          for (const normalized of parse(event)) {
            if (normalized.type === 'done') finished = true;
            yield normalized;
            if (finished) return; // O terminal comprovado encerra a resposta; eventos posteriores não pertencem a esta etapa.
          }
        }
      } catch (error) {
        if (error instanceof ChatStreamError) throw error;
        if (error instanceof SseLimitError) throw new ChatStreamError('stream maior que o limite');
        // Queda de rede ou prazo estourado no meio do stream.
        logger?.warn({ service: 'opencode-go', protocol }, 'stream do chat interrompido');
        throw new DomainError('PROVIDER_UNAVAILABLE', { cause: error });
      }
      // Sem o marcador final o stream foi cortado: uma resposta pela metade não pode passar por completa.
      if (!finished) throw new ChatStreamError('stream encerrado sem o evento final');
    },
  };
}
