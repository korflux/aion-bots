// Chamada HTTP de saída para os serviços externos fixos (OpenCode Go, Composio e Parallel): um único ponto que aplica
// timeout, bloqueio de redirecionamento, limite de tamanho da resposta e a classificação dos status.
//
// Por que existe: os adaptadores de cada serviço (`opencode-go.ts`, `composio.ts`) só montam a requisição e
// interpretam o corpo; tudo que é segurança da saída de rede fica aqui, então T5 e T7 reutilizam sem repetir.
// Decisões:
// - `redirect: 'error'`: um redirecionamento nunca é seguido. A chave vai em cabeçalho e seguir o redirect poderia
//   entregá-la a outro destino; o destino da API é fixo na configuração e uma resposta não o altera (anti-SSRF).
// - Corpo limitado (1 MiB por padrão; `maxBytes` dá um teto menor ou maior a quem sabe o tamanho que espera) e prazo explícito de cada chamada
//   (`timeoutMs`, que cobre também a leitura do corpo): o serviço externo não consegue prender memória nem a requisição do dono.
// - Resposta em `text/event-stream` (o MCP da Parallel responde assim, ou em JSON): o POST a entende, e o JSON devolvido é o da ÚLTIMA mensagem
//   JSON do stream (ver `readLastSseJson`). Quem aceita essa forma de resposta a pede em `accept` (padrão `application/json`) e o limite de
//   bytes (`maxBytes`) vale para as duas formas.
// - O corpo de erro do serviço NUNCA é repassado nem logado POR ESTE MÓDULO: há serviços que ecoam a chave recebida na mensagem. Quem
//   precisa do motivo de uma recusa (o adaptador do Composio, em `composio.ts`) lê só os campos estruturados que conhece e remove a chave.
// - Saldo esgotado do chat da Anthropic (`detectExhaustedCredits`, phase 17): só vira o booleano `creditsExhausted`, pelo HTTP 402 (a forma documentada, `billing_error`) ou, em 400, pelo tipo
//   `billing_error` ou pela mensagem de saldo baixo (a forma que a API real também usa); a mensagem nunca sai deste módulo, como nas demais classificações.
// - Limite de uso (429) do chat do OpenCode Go (phase 17, passo 8, A22): a resposta de erro traz `retryAfterMs` (cabeçalho `Retry-After`, em segundos ou data), e `ProviderRateLimited` marca a falha
//   como "o provedor limitou" para a execução a gravar como `RATE_LIMITED`. A espera e a nova tentativa são de quem chama (`opencode-go.ts`): este módulo continua único e sem política de repetição,
//   porque também serve ao Composio e à Parallel, onde repetir uma chamada pode repetir uma ação.
// - Recusa de CONTEXTO do chat (`detectRejectedContext`): só vira o booleano `rejectedContext`, por código conhecido ou por mensagem de uma allowlist de padrões
//   (`isContextOverflowError`); o executor reage a ele com uma compactação forçada e uma nova chamada. A mensagem nunca sai deste módulo.

import { readSse } from '../models/sse';

/** Permite trocar o `fetch` nos testes; em produção é o `fetch` global do Node. */
export type FetchLike = typeof fetch;

export const UPSTREAM_TIMEOUT_MS = 10_000;
/** Teto padrão do corpo de uma resposta; um POST pode pedir outro em `maxBytes`. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** O serviço externo não respondeu de forma utilizável: rede, DNS, TLS, timeout, redirect ou corpo grande demais. */
export class UpstreamUnreachable extends Error {
  constructor(cause: unknown) {
    super('serviço externo inacessível', { cause });
    this.name = 'UpstreamUnreachable';
  }
}

/**
 * O provedor de modelos respondeu 429 (limite de uso). Vai como `cause` do `DomainError('PROVIDER_UNAVAILABLE')` que o cliente de chat lança: o código segue o mesmo para quem já o trata (sonda
 * da chave, teste de modelo), e só a execução do motor o distingue (`failureOutcome`) para gravar `RATE_LIMITED`. `retryAfterMs` é o que o provedor pediu, ou `null` se não informou.
 */
export class ProviderRateLimited extends Error {
  constructor(readonly retryAfterMs: number | null) {
    super('provedor limitou as chamadas');
    this.name = 'ProviderRateLimited';
  }
}

/** `Retry-After` em milissegundos: número de segundos ou data HTTP; ausente, vazio, negativo ou fora do formato é `undefined`. */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

export interface UpstreamGetOptions {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  fetchImpl: FetchLike;
}

export interface UpstreamResponse {
  status: number;
  /** Corpo interpretado como JSON (num `text/event-stream`, o da última mensagem JSON); `undefined` se não houver JSON válido. */
  json: unknown;
}

/** Lê o corpo em pedaços e aborta se passar de `maxBytes`, para um corpo gigante não ocupar a memória do processo. */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('resposta maior que o limite');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Lê uma resposta `text/event-stream` e devolve o JSON da última mensagem que for JSON válido. No MCP sobre HTTP a resposta ao pedido (JSON-RPC)
 * é a última mensagem do stream, depois de eventuais notificações; eventos que não são JSON (keep-alive, texto) são ignorados.
 * ponytail: não confere o `id` do JSON-RPC nem junta mensagens; trocar por uma busca da mensagem com o `id` do pedido se algum serviço
 * passar a mandar outras respostas depois da nossa.
 */
async function readLastSseJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) return undefined;
  let last: unknown;
  for await (const event of readSse(response.body, maxBytes)) {
    try {
      last = JSON.parse(event.data);
    } catch {
      // evento que não é JSON: não é a resposta
    }
  }
  return last;
}

/** GET com as garantias acima. Lança `UpstreamUnreachable`; qualquer status HTTP volta como `UpstreamResponse`. */
export async function upstreamGetJson({ url, headers, timeoutMs, fetchImpl }: UpstreamGetOptions): Promise<UpstreamResponse> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await readLimitedText(response, MAX_RESPONSE_BYTES);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  } catch (error) {
    throw new UpstreamUnreachable(error);
  }
}

export interface UpstreamPostOptions {
  url: string;
  headers: Record<string, string>;
  /** Corpo JSON da requisição. */
  body: unknown;
  timeoutMs: number;
  /** Aborto externo (parada do dono ou worker encerrando); soma-se ao prazo. */
  signal?: AbortSignal;
  /** Formatos de resposta aceitos (cabeçalho `accept`). Padrão `application/json`; o MCP da Parallel pede também `text/event-stream`. */
  accept?: string;
  /** Teto do corpo da resposta, em bytes (JSON ou stream). Padrão `MAX_RESPONSE_BYTES` (1 MiB); acima dele a chamada falha como `UpstreamUnreachable`. */
  maxBytes?: number;
  fetchImpl: FetchLike;
}

/** POST com o corpo já serializado e a resposta lida como JSON (ou como stream de eventos, ver acima). Base de `upstreamPostJson` e `upstreamPostForm`. */
async function postAndReadJson(
  { url, headers, timeoutMs, signal, accept = 'application/json', maxBytes = MAX_RESPONSE_BYTES, fetchImpl }: Omit<UpstreamPostOptions, 'body'>,
  contentType: string,
  body: string,
): Promise<UpstreamResponse> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { accept, 'content-type': contentType, ...headers },
      body,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      return { status: response.status, json: await readLastSseJson(response, maxBytes) };
    }
    const text = await readLimitedText(response, maxBytes);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  } catch (error) {
    throw new UpstreamUnreachable(error);
  }
}

/** POST com resposta JSON (ex.: executar uma ação do Composio), com as mesmas garantias do GET. Lança `UpstreamUnreachable`. */
export function upstreamPostJson({ body, ...options }: UpstreamPostOptions): Promise<UpstreamResponse> {
  return postAndReadJson(options, 'application/json', JSON.stringify(body));
}

/** POST de formulário (`application/x-www-form-urlencoded`) com resposta JSON: a troca de credencial do Google (OAuth2) exige esse formato. */
export function upstreamPostForm({ body, ...options }: Omit<UpstreamPostOptions, 'body'> & { body: Record<string, string> }): Promise<UpstreamResponse> {
  return postAndReadJson(options, 'application/x-www-form-urlencoded', new URLSearchParams(body).toString());
}

/** Códigos (`code` ou `type` do erro) com que os provedores dizem "o pedido passou da janela de contexto". */
const CONTEXT_OVERFLOW_CODES: ReadonlySet<string> = new Set(['context_length_exceeded', 'context_window_exceeded', 'prompt_too_long', 'input_too_long', 'request_too_large']);

/**
 * Mensagens conhecidas de janela excedida, quando o provedor não manda um código (cada padrão vem de um provedor real: OpenAI e compatíveis, Anthropic, Gemini,
 * Bedrock, xAI, Mistral, Moonshot, llama.cpp/LM Studio, Ollama, Copilot, Cerebras e MiniMax). É uma allowlist: nenhum padrão genérico ("too large", "exceeds
 * the maximum") entra, porque o mesmo texto aparece em erros de SAÍDA (`max_tokens`) e de cota por minuto, e tratar esses como contexto dispararia uma
 * compactação paga à toa. O texto da mensagem só é comparado, nunca guardado nem repassado (pode ecoar dados do pedido).
 */
const CONTEXT_OVERFLOW_MESSAGES: readonly RegExp[] = [
  /maximum context length/i,
  /exceeds? (?:the )?(?:available |model'?s? )?context (?:length|window|size|limit)/i,
  /context (?:length|window) exceeded|context window exceeds limit|exceed(?:s|ed)? context limit/i,
  /prompt is too long|prompt too long|prompt token count of \d+ exceeds/i,
  /input is too long for requested model|input token count .* exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /too large for model with \d+ maximum context length/i,
  /exceeded model token limit/i,
  /context length of only \d+ tokens|context overflow|exceeded max context length/i,
  /current length is \d+ while limit is \d+/i,
];

/**
 * O corpo de erro do provedor (o objeto `error`, ou o próprio texto dele) diz que o pedido passou da janela de contexto? Só código na allowlist ou mensagem
 * numa das conhecidas; qualquer outra coisa é "não". Devolve apenas o booleano: nada do corpo sai daqui.
 */
export function isContextOverflowError(error: unknown): boolean {
  if (typeof error === 'string') return CONTEXT_OVERFLOW_MESSAGES.some((pattern) => pattern.test(error));
  if (!error || typeof error !== 'object') return false;
  const { code, type, message } = error as { code?: unknown; type?: unknown; message?: unknown };
  if ([code, type].some((value) => typeof value === 'string' && CONTEXT_OVERFLOW_CODES.has(value))) return true;
  return typeof message === 'string' && CONTEXT_OVERFLOW_MESSAGES.some((pattern) => pattern.test(message));
}

/**
 * O corpo de erro da Anthropic (o objeto `error`) diz que o saldo acabou? O tipo `billing_error` ou a mensagem "credit balance is too low" (que a API real manda em 400
 * `invalid_request_error`). Devolve só o booleano: nada do corpo sai daqui.
 */
export function isCreditsExhaustedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { type, message } = error as { type?: unknown; message?: unknown };
  return type === 'billing_error' || (typeof message === 'string' && /credit balance is too low/i.test(message));
}

export interface UpstreamStreamOptions {
  url: string;
  headers: Record<string, string>;
  /** Corpo JSON da requisição. */
  body: unknown;
  /** Prazo total (conexão e leitura do stream inteiro). */
  timeoutMs: number;
  /** Aborto externo (prazo geral de um teste, ou o usuário parando a execução). */
  signal?: AbortSignal;
  fetchImpl: FetchLike;
  /** Só o chat pode inspecionar a recusa específica deste metadado; nenhum corpo de erro sai do transporte. */
  detectRejectedStreamOptions?: boolean;
  /** Sonda de visão: devolve somente a classificação de recusa explícita de imagem. */
  detectRejectedImage?: boolean;
  /** Só códigos inequívocos de tamanho, nunca heurística sobre qualquer erro400. */
  detectRejectedContext?: boolean;
  /** Só a Anthropic: 402, ou 400 com `billing_error`/saldo baixo, vira o booleano `creditsExhausted` (nenhum texto do corpo sai). */
  detectExhaustedCredits?: boolean;
}

export interface UpstreamStream {
  status: number;
  /** SSE de sucesso; no erro o corpo é descartado após classificações opt-in limitadas. */
  body: ReadableStream<Uint8Array> | null;
  rejectedStreamOptions?: boolean;
  rejectedImage?: boolean;
  rejectedContext?: boolean;
  creditsExhausted?: boolean;
  /** `Retry-After` da resposta de erro, em milissegundos, quando o provedor o informou (usado na nova tentativa do 429). */
  retryAfterMs?: number;
}

/**
 * POST em streaming (chat), com as mesmas garantias do GET: sem redirect, prazo que cobre a leitura inteira e o corpo
 * de erro nunca repassado; as sondas opt-in leem até 4096 bytes em 400/422 e devolvem somente booleanos
 * de recusa de stream_options ou imagem. O corpo de sucesso é entregue como stream (o limite de bytes é de quem
 * o lê, em `readSse`). Lança `UpstreamUnreachable` (rede, DNS, TLS, prazo, redirect); qualquer status volta como resposta.
 */
export async function upstreamPostStream({ url, headers, body, timeoutMs, signal, fetchImpl, detectRejectedStreamOptions = false, detectRejectedImage = false, detectRejectedContext = false, detectExhaustedCredits = false }: UpstreamStreamOptions): Promise<UpstreamStream> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) {
      // 402 é a forma documentada do saldo esgotado e dispensa ler o corpo.
      if (detectExhaustedCredits && response.status === 402) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status, body: null, creditsExhausted: true };
      }
      if ((detectRejectedStreamOptions || detectRejectedImage || detectRejectedContext || detectExhaustedCredits) && (response.status === 400 || response.status === 422)) {
        // Teto pequeno, mesmo prazo do fetch e retorno só booleano. Não logar nem propagar mensagem que possa ecoar a chave.
        let rejectedStreamOptions = false;
        let rejectedImage = false;
        let rejectedContext = false;
        let creditsExhausted = false;
        try {
          const raw: unknown = JSON.parse(await readLimitedText(response, 4096));
          const error = raw && typeof raw === 'object' && 'error' in raw ? raw.error : undefined;
          // O erro pode vir como texto solto (`{"error":"..."}`): só a recusa de contexto o lê assim; as demais classificações exigem o objeto.
          rejectedContext = detectRejectedContext && isContextOverflowError(error);
          creditsExhausted = detectExhaustedCredits && response.status === 400 && isCreditsExhaustedError(error);
          if (error && typeof error === 'object') {
            const param = 'param' in error ? error.param : undefined;
            const message = 'message' in error ? error.message : undefined;
            rejectedImage = response.status === 400 && detectRejectedImage && typeof message === 'string' &&
              /(?:image|vision|multimodal)/i.test(message) && /(?:unsupported|not support|not accept|not allow|cannot|does not)/i.test(message);
            rejectedStreamOptions = param === 'stream_options' || param === 'stream_options.include_usage' ||
              (typeof message === 'string' && /(?:unknown|unsupported|unrecognized|not supported|not allowed|not permitted)/i.test(message) && /\bstream_options\b/.test(message));
          }
        } catch { /* Recusa sem formato conhecido segue o erro HTTP original. */ }
        return { status: response.status, body: null, rejectedStreamOptions, rejectedImage, ...(rejectedContext ? { rejectedContext: true } : {}), ...(creditsExhausted ? { creditsExhausted: true } : {}) };
      }
      await response.body?.cancel().catch(() => undefined);
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      // ponytail: todo 413 vira recusa de contexto, sem ler o corpo: o 413 do provedor ("payload too large") é quase sempre o pedido grande demais, mas um proxy do
      // caminho também o devolve para corpo grande por outro limite (bytes, não tokens). O custo do falso positivo é limitado: a recusa dispara UMA compactação
      // forçada e uma única nova chamada, e a segunda recusa encerra com CONTEXT_TOO_LARGE (`modelStep`). Distinguir pelo corpo se um proxy próprio passar a
      // devolver 413 por limite de bytes e esse caminho aparecer nos logs.
      return { status: response.status, body: null, ...(detectRejectedContext && response.status === 413 ? { rejectedContext: true } : {}), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
    }
    return { status: response.status, body: response.body };
  } catch (error) {
    throw new UpstreamUnreachable(error);
  }
}

export type UpstreamVerdict = 'ok' | 'key-invalid' | 'unavailable';

/**
 * Como os dois serviços tratam o status: 2xx aceita a chave; 401 e 403 a recusam; o resto (429, 5xx, 404 por URL
 * mal configurada...) é indisponibilidade, e não culpa da chave, para o dono não trocar uma chave boa por engano.
 */
export function classifyStatus(status: number): UpstreamVerdict {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'key-invalid';
  return 'unavailable';
}
