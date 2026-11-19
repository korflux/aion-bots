// Adaptador da Anthropic (segundo provedor de modelos, phase 17, passo 4; MODEL-02): UM módulo pequeno que isola o formato da API nativa da Anthropic, ao lado do `opencode-go.ts`.
// A listagem de modelos (`GET /v1/models`) alimenta o catálogo com nome e capacidade confirmados de cada modelo; o chat é só o protocolo `messages`, em streaming.
//
// O QUE É CONFIRMADO (documentação oficial e sonda real de 13/11/2026, `pnpm validate:anthropic`, só com o `claude-haiku-5-5`):
// - Autenticação por `x-api-key` e `anthropic-version: 2023-06-01`, e NADA mais: sem `Authorization: Bearer` (o OpenCode Go o exige, a Anthropic nativa não) e sem
//   `x-opencode-session` (cabeçalho de roteamento do OpenCode Go; a Anthropic não o conhece).
// - `GET /v1/models` pagina por cursor (`limit` de 1 a 1000, `has_more` e `last_id`, que vira `after_id` da página seguinte) e informa por modelo `display_name`, `max_input_tokens` e
//   `max_tokens`: o nome exibido e a capacidade CONFIRMADA do modelo exato, sem tabela manual nem dedução por família.
// - O effort vai em `output_config.effort`, e o pedido nunca leva `temperature`, `top_p`, `top_k` nem `tool_choice` forçado (os modelos 5.x recusam com 400); o adaptador do
//   protocolo (`chat-protocols.ts`) já monta isso e este módulo só o reaproveita.
// - Os blocos `thinking` da resposta são descartados pelo parser e, por isso, nunca voltam num pedido seguinte: a sonda mostrou que a Anthropic aceita o histórico de uma chamada de
//   ferramenta sem eles (sem 400), inclusive com `thinking` presente na resposta anterior.
// - O uso informa entrada, leitura e gravação de cache à parte (`cache_read_input_tokens`, `cache_creation_input_tokens`); a segunda chamada de uma conversa já lê o prefixo do cache.
//
// O id do produto é `anthropic/<modelo>`; o provedor só conhece o id local, então o prefixo sai aqui, o único ponto onde o pedido vira bytes.
// Erros: 401 e 403 são chave recusada; 408, 429, 5xx (inclui o 529 de sobrecarga) são indisponibilidade; os demais 4xx são recusa do pedido (`ChatRejected`). O corpo de erro nunca é
// repassado (`upstream-http.ts`). O saldo esgotado (HTTP 402 `billing_error` da documentação, ou 400 com a mensagem de saldo baixo) NÃO é recusa do pedido: vira `PROVIDER_CREDITS_EXHAUSTED`, antes de
// `ChatRejected`, para a execução, o resumo e o teste do modelo pararem sem tratá-lo como recusa do modelo nem repetir a chamada (A20).
// ponytail: a lógica do stream de chat repete a do `opencode-go.ts` (mesmos eventos, outros cabeçalhos); extrair para uma função comum se um terceiro provedor entrar.
// ponytail: `refusal` e `pause_turn` (motivos de parada que só as classificações de segurança e as ferramentas do servidor produzem) caem em "motivo desconhecido" (`ChatStreamError`);
// tratar quando um modelo da Anthropic passar a recusar pedidos legítimos do dono.
import { localModelId } from '@aion/shared';
import { z } from 'zod';
import { DomainError } from '../errors';
import { ANTHROPIC_VERSION, ChatRejected, ChatStreamError, PROTOCOLS, type ChatEvent, type ChatProtocol, type ChatRequest } from '../models/chat-protocols';
import { SseLimitError, readSse } from '../models/sse';
import type { ProviderClient, ProviderModel, UpstreamClientOptions } from './opencode-go';
import { UPSTREAM_TIMEOUT_MS, UpstreamUnreachable, classifyStatus, upstreamGetJson, upstreamPostStream } from './upstream-http';

/** Um modelo do catálogo da Anthropic com o que ela informa dele; campo ausente ou fora do formato vira `null` (sem dado, nunca um valor inventado). */
export interface AnthropicModel extends ProviderModel {
  /** Nome para exibição (`display_name`), ex.: `Claude Haiku 5.5`. */
  displayName: string | null;
  /** Janela de contexto confirmada (`max_input_tokens`). */
  maxInputTokens: number | null;
  /** Limite de saída confirmado (`max_tokens`). */
  maxTokens: number | null;
}

/** Cliente da Anthropic: o `ProviderClient` comum, com a listagem enriquecida (nome e capacidade). */
export interface AnthropicClient extends ProviderClient {
  listModels(apiKey: string): Promise<AnthropicModel[]>;
}

export interface AnthropicClientOptions extends UpstreamClientOptions {
  /** Prazo de uma chamada de chat inteira (conexão e stream). */
  chatTimeoutMs?: number;
}

/** Prazo de uma chamada de chat (o mesmo do OpenCode Go; a execução passa um prazo maior). */
const CHAT_TIMEOUT_MS = 30_000;
/** Mesmo teto finito do transporte SSE do OpenCode Go. */
const MAX_CHAT_STREAM_BYTES = 16 * 1024 * 1024;
/** Itens por página de `/models` e teto de páginas lidas: 10 × 100 cobre dez vezes o catálogo atual; acima disso a lista é cortada (ponytail abaixo). */
const MODELS_PAGE_LIMIT = 100;
const MODELS_MAX_PAGES = 10;

const positiveInt = z.number().int().positive().nullish().catch(null);
const modelsPageSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(200),
    display_name: z.string().min(1).max(200).nullish().catch(null),
    max_input_tokens: positiveInt,
    max_tokens: positiveInt,
  })),
  has_more: z.boolean().catch(false),
  last_id: z.string().nullish().catch(null),
});

/** 401 e 403 são chave; 408, 429 e 5xx são indisponibilidade; o resto é recusa desta requisição (`ChatRejected`). O saldo esgotado já foi decidido antes, pela classificação do transporte. */
function chatStatusError(status: number): Error {
  if (status === 401 || status === 403) return new DomainError('PROVIDER_KEY_INVALID');
  if (status === 408 || status === 429 || status >= 500) return new DomainError('PROVIDER_UNAVAILABLE');
  return new ChatRejected(status);
}

/** Cabeçalhos da Anthropic nativa: só a chave e a versão (sem Bearer e sem sessão do OpenCode). */
const headers = (apiKey: string): Record<string, string> => ({ 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION });

export function createAnthropicClient({
  baseUrl,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  chatTimeoutMs = CHAT_TIMEOUT_MS,
  fetchImpl = fetch,
  logger,
}: AnthropicClientOptions): AnthropicClient {
  return {
    async listModels(apiKey) {
      const models: AnthropicModel[] = [];
      let afterId: string | null = null;
      for (let page = 0; page < MODELS_MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: String(MODELS_PAGE_LIMIT), ...(afterId ? { after_id: afterId } : {}) });
        let response;
        try {
          response = await upstreamGetJson({ url: `${baseUrl}/models?${query.toString()}`, headers: headers(apiKey), timeoutMs, fetchImpl });
        } catch (error) {
          if (error instanceof UpstreamUnreachable) {
            logger?.warn({ service: 'anthropic' }, 'provedor inacessível');
            throw new DomainError('PROVIDER_UNAVAILABLE', { cause: error });
          }
          throw error;
        }
        const verdict = classifyStatus(response.status);
        if (verdict === 'key-invalid') throw new DomainError('PROVIDER_KEY_INVALID');
        if (verdict === 'unavailable') {
          logger?.warn({ service: 'anthropic', status: response.status }, 'provedor respondeu com erro');
          throw new DomainError('PROVIDER_UNAVAILABLE');
        }
        const parsed = modelsPageSchema.safeParse(response.json);
        if (!parsed.success) {
          logger?.warn({ service: 'anthropic' }, 'provedor respondeu fora do formato esperado');
          throw new DomainError('PROVIDER_UNAVAILABLE');
        }
        for (const item of parsed.data.data) {
          models.push({ id: item.id, displayName: item.display_name ?? null, maxInputTokens: item.max_input_tokens ?? null, maxTokens: item.max_tokens ?? null });
        }
        // O cursor só avança com `last_id` novo: uma resposta que repete o cursor (ou não o informa) encerra a leitura em vez de girar.
        if (!parsed.data.has_more || !parsed.data.last_id || parsed.data.last_id === afterId) break;
        afterId = parsed.data.last_id;
      }
      // ponytail: acima de `MODELS_MAX_PAGES` × `MODELS_PAGE_LIMIT` (1.000) modelos a lista é cortada; subir o teto se o catálogo da Anthropic chegar perto disso.
      return models;
    },

    async *streamChat(apiKey, protocol: ChatProtocol, request: ChatRequest, signal) {
      // A Anthropic nativa só fala `messages`. Qualquer outro protocolo é "este provedor não serve este formato": o teste de modelo segue para o próximo, como no OpenCode Go.
      if (protocol !== 'messages') throw new ChatRejected(404);
      const adapter = PROTOCOLS.messages;
      let stream;
      try {
        stream = await upstreamPostStream({
          url: `${baseUrl}${adapter.path}`,
          headers: headers(apiKey),
          body: adapter.body({ ...request, model: localModelId(request.model) }),
          timeoutMs: chatTimeoutMs,
          signal,
          fetchImpl,
          detectRejectedContext: true,
          detectExhaustedCredits: true,
          detectRejectedImage: request.turns.some((turn) => turn.role === 'user' && (turn.images?.length ?? 0) > 0),
        });
      } catch (error) {
        if (error instanceof UpstreamUnreachable) {
          logger?.warn({ service: 'anthropic', protocol }, 'provedor inacessível no chat');
          throw new DomainError('PROVIDER_UNAVAILABLE', { cause: error });
        }
        throw error;
      }
      if (stream.body === null) {
        if (stream.creditsExhausted) {
          logger?.warn({ service: 'anthropic', protocol, status: stream.status }, 'saldo da Anthropic esgotado');
          throw new DomainError('PROVIDER_CREDITS_EXHAUSTED');
        }
        const failure = chatStatusError(stream.status);
        if (failure instanceof ChatRejected && stream.rejectedContext) throw new ChatRejected(stream.status, false, true);
        if (failure instanceof ChatRejected && stream.rejectedImage) throw new ChatRejected(stream.status, true);
        if (failure instanceof DomainError) logger?.warn({ service: 'anthropic', protocol, status: stream.status }, 'chat recusado pelo provedor');
        throw failure;
      }

      const parse = adapter.parser();
      let finished = false;
      try {
        for await (const event of readSse(stream.body, MAX_CHAT_STREAM_BYTES)) {
          for (const normalized of parse(event)) {
            if (normalized.type === 'done') finished = true;
            yield normalized as ChatEvent;
            if (finished) return; // O terminal comprovado encerra a resposta; eventos posteriores não pertencem a esta etapa.
          }
        }
      } catch (error) {
        if (error instanceof ChatStreamError) throw error;
        if (error instanceof SseLimitError) throw new ChatStreamError('stream maior que o limite');
        // Queda de rede ou prazo estourado no meio do stream.
        logger?.warn({ service: 'anthropic', protocol }, 'stream do chat interrompido');
        throw new DomainError('PROVIDER_UNAVAILABLE', { cause: error });
      }
      // Sem o marcador final o stream foi cortado: uma resposta pela metade não pode passar por completa.
      if (!finished) throw new ChatStreamError('stream encerrado sem o evento final');
    },
  };
}
