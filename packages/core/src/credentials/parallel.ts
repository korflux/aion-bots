// Adaptador da Parallel (pesquisa na web): UM módulo pequeno que isola o formato do serviço. Faz três coisas: validar a chave opcional com uma pesquisa
// mínima (T8, `validateKey`), pesquisar (`search`) e ler páginas (`fetchPages`) para as ferramentas `web_search` e `web_fetch` dos bots e do Chat geral
// (T9, `runs/web-tools.ts`). Quem conhece o formato do serviço é só este arquivo; os limites de tamanho e a marcação de "conteúdo não confiável" são
// de `web-tools.ts`.
//
// O QUE É CONFIRMADO E O QUE É SUPOSTO (prova do dono em 2026-10-03, spec da phase 1 "Integrações"; a prova real na VPS é da T15):
// - Confirmado: o endpoint é o MCP `https://search.parallel.ai/mcp` (configurável em `AION_PARALLEL_BASE_URL`); o pedido é um `POST` JSON-RPC 2.0
//   `tools/call` DIRETO, sem o SDK MCP e sem a troca `initialize`; a resposta vem em JSON ou em `text/event-stream` (o cliente HTTP lê as duas formas,
//   ver `upstream-http.ts`); a chave, opcional, vai em `Authorization: Bearer <chave>` e, sem ela, vale o nível anônimo; as ferramentas do endpoint
//   são `web_search` e `web_fetch`.
// - Suposto (a T15 confere contra o serviço real): os argumentos de `web_search` são `objective` e `search_queries` (lista de textos) e os de `web_fetch`
//   são `urls` e `objective`, ambos com `session_id` opcional (a documentação pública da Parallel o descreve, mas o esquema que o serviço publica
//   não o lista: se ele recusar o campo, toda chamada voltará como "indisponível" e a T15 o vê na hora); uma chave inválida volta como 401 ou 403 no
//   transporte (e não como erro dentro de um 200); o resultado de sucesso traz `result` sem `isError`, com o conteúdo estruturado em `structuredContent`
//   (ou como JSON no texto de `content`) no formato `{ results: [{ url, title, excerpts, full_content }], errors: [{ url }] }`, que é o do esquema de
//   saída publicado pela Parallel (`web_search`: `results`; `web_fetch`: `results` e `errors`).
//
// Como decide ao validar (a cada tentativa, uma única chamada):
// - 2xx com `result` e sem `isError`: a chave vale.
// - 401 ou 403: a chave é recusada (`WEB_SEARCH_KEY_INVALID`).
// - 429, 5xx, rede, prazo, redirect, corpo grande demais ou resposta fora do formato (inclusive `error` do JSON-RPC e `isError`): não dá para saber agora
//   (`WEB_SEARCH_UNAVAILABLE`); a chave não é gravada e a anterior continua valendo, para o dono não trocar uma chave boa por engano.
//
// Como decide ao pesquisar e ler (`ParallelCallError`, com o motivo; web-tools o traduz nas mensagens seguras do F7): 429 é `rate_limited`; 401 e 403 são
// `key_rejected`; rede, prazo, redirect, corpo grande demais, outros status, `error` do JSON-RPC e `isError` são `unavailable`; resposta que não segue o
// formato acima é `unexpected_format`. Não há repetição automática: uma chamada, um prazo.
//
// Privacidade e segredo: para a Parallel só saem o objetivo, as consultas, as URLs e o `session_id` (a validação envia só um objetivo e uma consulta FIXOS e
// inofensivos; nada do dono, dos bots ou das conversas). A chave só viaja no cabeçalho de autorização; nada daqui a registra, e o corpo de resposta do
// serviço nunca é logado nem repassado (só o status e o tipo do problema vão ao log).
import { z } from 'zod';
import { DomainError } from '../errors';
import {
  UpstreamUnreachable,
  classifyStatus,
  upstreamPostJson,
  type UpstreamResponse,
} from './upstream-http';
import type { UpstreamClientOptions } from './opencode-go';

/** Por que uma chamada de pesquisa ou leitura não deu resultado (a mensagem para o modelo é de `web-tools.ts`). */
export type ParallelFailureReason = 'rate_limited' | 'key_rejected' | 'unavailable' | 'unexpected_format';

/** Falha tipada de `search` e `fetchPages`: só o motivo, nunca corpo, cabeçalho nem chave da resposta do serviço. */
export class ParallelCallError extends Error {
  constructor(
    readonly reason: ParallelFailureReason,
    options?: { cause?: unknown },
  ) {
    super(`pesquisa na web: ${reason}`, options);
    this.name = 'ParallelCallError';
  }
}

/** Uma página ou resultado como a Parallel devolve, já com os campos que o Aion usa. Os textos e a URL são dado NÃO CONFIÁVEL da web. */
export interface ParallelDocument {
  url: string;
  title: string | null;
  /** Trechos relevantes (markdown), na ordem do serviço. */
  excerpts: string[];
  /** Página inteira, quando o serviço a manda (o Aion não a pede). */
  fullContent: string | null;
}

/** Como se autentica e se interrompe uma chamada: `apiKey` nulo é o nível anônimo; `signal` é o da execução (parar o dono aborta a chamada em curso). */
export interface ParallelCallOptions {
  apiKey: string | null;
  signal: AbortSignal;
}

/** Resultado de `fetchPages`: as páginas lidas e as URLs que o serviço declarou como falhas. */
export interface ParallelFetchResult {
  documents: ParallelDocument[];
  failedUrls: string[];
}

/** Porta da Parallel usada ao salvar a chave (T8) e pelas ferramentas de pesquisa (T9). `validateKey` lança `DomainError`; `search` e `fetchPages`, `ParallelCallError`. */
export interface ParallelClient {
  /**
   * Prova a chave com uma pesquisa mínima (objetivo e consulta fixos). Lança `WEB_SEARCH_KEY_INVALID` (401/403) ou `WEB_SEARCH_UNAVAILABLE`
   * (qualquer outra falha, inclusive resposta fora do formato). Sem a chave não há o que validar: o nível anônimo não passa por aqui.
   */
  validateKey(apiKey: string): Promise<void>;
  /** Pesquisa na web (`web_search`): os resultados em ordem de relevância. Só `objective`, `queries` e `sessionId` saem para a Parallel. */
  search(input: { objective: string; queries: readonly string[]; sessionId: string }, options: ParallelCallOptions): Promise<ParallelDocument[]>;
  /** Lê páginas (`web_fetch`). As URLs são buscadas PELA Parallel, nunca por este servidor. Só `urls`, `objective` e `sessionId` saem. */
  fetchPages(input: { urls: readonly string[]; objective?: string; sessionId: string }, options: ParallelCallOptions): Promise<ParallelFetchResult>;
}

/** Prazo da pesquisa de validação: uma busca real leva mais que uma listagem, e quem espera é o dono diante do botão "Salvar". */
export const PARALLEL_VALIDATION_TIMEOUT_MS = 20_000;
/** Prazo de UMA chamada de pesquisa ou leitura de páginas (F7: 60 s, sem repetição automática). */
export const PARALLEL_CALL_TIMEOUT_MS = 60_000;
/**
 * Teto do corpo da resposta de uma chamada de pesquisa ou leitura. A Parallel já limita o conteúdo (cerca de 25.000 caracteres por chamada) e o Aion
 * repassa ao modelo bem menos que isso; 512 KiB cobrem o JSON com folga e impedem que um serviço (ou um impostor no caminho) encha a memória do worker.
 */
const PARALLEL_CALL_MAX_BYTES = 512 * 1024;

/** Objetivo e consulta da sonda: texto fixo, em inglês e sem relação com o dono (é tudo o que a validação envia à Parallel). */
const PROBE_OBJECTIVE = 'Find the official homepage of the Mozilla project.';
const PROBE_QUERY = 'Mozilla official website';

/** Como o MCP sobre HTTP exige: o cliente aceita as duas formas de resposta (JSON ou stream de eventos). */
const MCP_ACCEPT = 'application/json, text/event-stream';

/**
 * Resposta de um `tools/call` (JSON-RPC 2.0): `result` (com `isError` quando a ferramenta falhou, e o conteúdo, que o MCP entrega como `structuredContent`
 * e como texto em `content`) ou `error` do protocolo. A validação da chave só olha se deu certo; a pesquisa e a leitura leem também o conteúdo
 * (`payloadSchema`).
 */
const callResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  result: z
    .object({
      isError: z.boolean().nullish(),
      structuredContent: z.unknown().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().nullish() })).nullish(),
    })
    .nullish(),
  error: z.unknown().optional(),
});

/**
 * O conteúdo de um resultado, no formato do esquema de saída publicado pela Parallel (ver o cabeçalho): campos extras são ignorados, os de texto
 * podem vir nulos, e a URL é obrigatória em cada resultado.
 */
const payloadSchema = z.object({
  results: z.array(
    z.object({ url: z.string(), title: z.string().nullish(), excerpts: z.array(z.string()).nullish(), full_content: z.string().nullish() }),
  ),
  errors: z.array(z.object({ url: z.string() })).nullish(),
});
type Payload = z.infer<typeof payloadSchema>;

/** O conteúdo do resultado: o `structuredContent` se ele segue o formato; senão o JSON que vem como texto em `content`. Nulo se nenhum serve. */
function payloadOf(result: { structuredContent?: unknown; content?: { type: string; text?: string | null }[] | null }): Payload | null {
  const structured = payloadSchema.safeParse(result.structuredContent);
  if (structured.success) return structured.data;
  const text = (result.content ?? []).flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('');
  try {
    const fromText = payloadSchema.safeParse(JSON.parse(text));
    return fromText.success ? fromText.data : null;
  } catch {
    return null;
  }
}

/** O resultado da Parallel como o Aion o usa (nomes em camelCase, trechos sempre em lista). */
const toDocument = (item: Payload['results'][number]): ParallelDocument => ({
  url: item.url,
  title: item.title ?? null,
  excerpts: item.excerpts ?? [],
  fullContent: item.full_content ?? null,
});

export interface ParallelClientOptions extends UpstreamClientOptions {
  /** Prazo de uma chamada de pesquisa ou leitura (`PARALLEL_CALL_TIMEOUT_MS`); os testes o encurtam para provar o prazo sem esperar. */
  callTimeoutMs?: number;
}

export function createParallelClient({
  baseUrl,
  timeoutMs = PARALLEL_VALIDATION_TIMEOUT_MS,
  callTimeoutMs = PARALLEL_CALL_TIMEOUT_MS,
  fetchImpl = fetch,
  logger,
}: ParallelClientOptions): ParallelClient {
  /**
   * Uma chamada `tools/call` à Parallel e a leitura do conteúdo. O `signal` é o da execução, então "Parar" aborta a chamada em curso; o prazo
   * (`callTimeoutMs`) soma-se a ele. Lança `ParallelCallError` com o motivo; nada da resposta de erro (corpo, cabeçalhos) é repassado ou logado.
   */
  async function callTool(tool: 'web_search' | 'web_fetch', args: Record<string, unknown>, { apiKey, signal }: ParallelCallOptions): Promise<Payload> {
    let response: UpstreamResponse;
    try {
      response = await upstreamPostJson({
        url: baseUrl,
        headers: apiKey === null ? {} : { authorization: `Bearer ${apiKey}` },
        accept: MCP_ACCEPT,
        maxBytes: PARALLEL_CALL_MAX_BYTES,
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } },
        timeoutMs: callTimeoutMs,
        signal,
        fetchImpl,
      });
    } catch (error) {
      if (error instanceof UpstreamUnreachable) {
        logger?.warn({ service: 'parallel', tool }, 'pesquisa na web inacessível');
        throw new ParallelCallError('unavailable', { cause: error });
      }
      throw error;
    }

    if (response.status === 429) {
      logger?.warn({ service: 'parallel', tool, status: 429 }, 'pesquisa na web com limite do provedor');
      throw new ParallelCallError('rate_limited');
    }
    const verdict = classifyStatus(response.status);
    if (verdict === 'key-invalid') throw new ParallelCallError('key_rejected');
    if (verdict === 'unavailable') {
      logger?.warn({ service: 'parallel', tool, status: response.status }, 'pesquisa na web respondeu com erro');
      throw new ParallelCallError('unavailable');
    }

    const envelope = callResponseSchema.safeParse(response.json);
    if (!envelope.success) {
      logger?.warn({ service: 'parallel', tool }, 'pesquisa na web respondeu fora do formato esperado');
      throw new ParallelCallError('unexpected_format');
    }
    const { result, error } = envelope.data;
    if (error !== undefined || result?.isError === true) {
      logger?.warn({ service: 'parallel', tool }, 'pesquisa na web respondeu com falha do serviço');
      throw new ParallelCallError('unavailable');
    }
    const payload = result ? payloadOf(result) : null;
    if (!payload) {
      logger?.warn({ service: 'parallel', tool }, 'pesquisa na web respondeu com conteúdo fora do formato esperado');
      throw new ParallelCallError('unexpected_format');
    }
    return payload;
  }

  return {
    async search({ objective, queries, sessionId }, options) {
      const payload = await callTool('web_search', { objective, search_queries: [...queries], session_id: sessionId }, options);
      return payload.results.map(toDocument);
    },

    async fetchPages({ urls, objective, sessionId }, options) {
      const payload = await callTool('web_fetch', { urls: [...urls], ...(objective === undefined ? {} : { objective }), session_id: sessionId }, options);
      return { documents: payload.results.map(toDocument), failedUrls: (payload.errors ?? []).map((item) => item.url) };
    },

    async validateKey(apiKey) {
      let response: UpstreamResponse;
      try {
        response = await upstreamPostJson({
          url: baseUrl,
          headers: { authorization: `Bearer ${apiKey}` },
          accept: MCP_ACCEPT,
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'web_search', arguments: { objective: PROBE_OBJECTIVE, search_queries: [PROBE_QUERY] } },
          },
          timeoutMs,
          fetchImpl,
        });
      } catch (error) {
        if (error instanceof UpstreamUnreachable) {
          logger?.warn({ service: 'parallel' }, 'pesquisa na web inacessível');
          throw new DomainError('WEB_SEARCH_UNAVAILABLE', { cause: error });
        }
        throw error;
      }

      const verdict = classifyStatus(response.status);
      if (verdict === 'key-invalid') throw new DomainError('WEB_SEARCH_KEY_INVALID');
      if (verdict === 'unavailable') {
        logger?.warn({ service: 'parallel', status: response.status }, 'pesquisa na web respondeu com erro');
        throw new DomainError('WEB_SEARCH_UNAVAILABLE');
      }

      const parsed = callResponseSchema.safeParse(response.json);
      const succeeded = parsed.success && parsed.data.error === undefined && parsed.data.result != null && parsed.data.result.isError !== true;
      if (!succeeded) {
        logger?.warn({ service: 'parallel' }, 'pesquisa na web respondeu fora do formato esperado');
        throw new DomainError('WEB_SEARCH_UNAVAILABLE');
      }
    },
  };
}
