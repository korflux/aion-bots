// Prova do ponto único de saída HTTP para serviços externos (`upstream-http.ts`), que a T9 estendeu com `accept` e `maxBytes` sem mudar quem já o usa:
// o teto padrão de 1 MiB continua valendo, o `accept` padrão continua `application/json`, e os dois ganham parâmetros. Também cobre o que o módulo
// sempre garantiu e agora serve às ferramentas de pesquisa: redirecionamento nunca seguido, prazo, aborto externo, corpo que não é JSON e o stream de
// eventos (a resposta é a última mensagem JSON), com o mesmo teto de bytes. Servidor HTTP local de verdade, sem a internet.
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_RESPONSE_BYTES, UpstreamUnreachable, classifyStatus, isContextOverflowError, parseRetryAfter, upstreamGetJson, upstreamPostForm, upstreamPostJson, upstreamPostStream } from './upstream-http';

let server: Server;
let origin: string;
/** O que o servidor recebeu por último (cabeçalhos e corpo), para conferir `accept` e o corpo enviado. */
let lastRequest: { headers: IncomingHttpHeaders; body: string } = { headers: {}, body: '' };

/** Um stream de eventos com os pedaços dados, cada um como um evento `data:`. */
const sse = (response: ServerResponse, chunks: string[]): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) response.write(`data: ${chunk}\n\n`);
  response.end();
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      lastRequest = { headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
      const url = new URL(request.url ?? '/', 'http://local');
      const size = Number(url.searchParams.get('size') ?? 0);
      switch (url.pathname) {
        case '/json':
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
          break;
        case '/status-429':
          response.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'limite' }));
          break;
        case '/big':
          response.writeHead(200, { 'content-type': 'application/json' }).end(`{"padding":"${'x'.repeat(size)}"}`);
          break;
        case '/text':
          response.writeHead(200, { 'content-type': 'text/html' }).end('<html>não é JSON</html>');
          break;
        case '/redirect':
          response.writeHead(302, { location: '/json' }).end();
          break;
        case '/slow':
          break; // nunca responde
        case '/sse':
          sse(response, ['{"jsonrpc":"2.0","method":"notifications/message"}', 'isto não é JSON', '{"jsonrpc":"2.0","id":1,"result":{"final":true}}', ': keep-alive']);
          break;
        case '/sse-big':
          sse(response, [`{"padding":"${'x'.repeat(size)}"}`]);
          break;
        default:
          response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const base = { headers: {}, timeoutMs: 3_000, fetchImpl: fetch };
const post = (path: string, extra: Partial<Parameters<typeof upstreamPostJson>[0]> = {}) => upstreamPostJson({ ...base, url: `${origin}${path}`, body: { a: 1 }, ...extra });
const unreachable = (promise: Promise<unknown>): Promise<boolean> => promise.then(() => false, (error: unknown) => error instanceof UpstreamUnreachable);

describe('parseRetryAfter (Retry-After do 429)', () => {
  it('lê segundos (inclusive 0 e fração) e data HTTP; ausente, vazio, negativo ou ilegível é undefined', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('2', now)).toBe(2_000);
    expect(parseRetryAfter('1.5', now)).toBe(1_500);
    expect(parseRetryAfter('Sat, 14 Nov 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Sat, 14 Nov 2026 11:00:00 GMT', now)).toBe(0); // data passada: já pode repetir
    for (const value of [null, '', '  ', '-3', 'logo', 'NaN']) expect(parseRetryAfter(value, now), String(value)).toBeUndefined();
  });

  it('o transporte devolve o Retry-After do 429 em milissegundos, sem ler nem repassar o corpo', async () => {
    const limited = (async () => new Response('{"error":{"message":"segredo do corpo"}}', { status: 429, headers: { 'retry-after': '4' } })) as unknown as typeof fetch;
    const stream = await upstreamPostStream({ url: 'http://x.local/chat', headers: {}, body: {}, timeoutMs: 1_000, fetchImpl: limited });
    expect(stream).toEqual({ status: 429, body: null, retryAfterMs: 4_000 });
    const without = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    expect(await upstreamPostStream({ url: 'http://x.local/chat', headers: {}, body: {}, timeoutMs: 1_000, fetchImpl: without })).toEqual({ status: 429, body: null });
  });
});

describe('upstreamPostJson: o que não mudou para quem já o usa', () => {
  it('pede application/json por padrão, envia o corpo em JSON e devolve o status e o JSON da resposta (qualquer status volta como resposta)', async () => {
    expect(await post('/json')).toEqual({ status: 200, json: { ok: true } });
    expect(lastRequest.headers.accept).toBe('application/json');
    expect(lastRequest.headers['content-type']).toBe('application/json');
    expect(JSON.parse(lastRequest.body)).toEqual({ a: 1 });
    expect(await post('/status-429')).toEqual({ status: 429, json: { error: 'limite' } });
  });

  it('o teto padrão do corpo é 1 MiB: um corpo maior falha como inacessível, um que cabe passa', async () => {
    expect(MAX_RESPONSE_BYTES).toBe(1024 * 1024);
    expect(await unreachable(post('/big?size=1200000'))).toBe(true);
    expect((await post('/big?size=900000')).status).toBe(200);
  });

  it('o stream de eventos devolve o JSON da última mensagem JSON, ignorando notificações de texto e comentários', async () => {
    expect(await post('/sse', { accept: 'application/json, text/event-stream' })).toEqual({ status: 200, json: { jsonrpc: '2.0', id: 1, result: { final: true } } });
  });

  it('um corpo que não é JSON volta com o status e sem JSON; redirecionamento nunca é seguido; um serviço que não responde cai no prazo', async () => {
    expect(await post('/text')).toEqual({ status: 200, json: undefined });
    expect(await unreachable(post('/redirect'))).toBe(true);
    const started = Date.now();
    expect(await unreachable(post('/slow', { timeoutMs: 250 }))).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('um aborto externo (o dono parou) interrompe a chamada em curso', async () => {
    const controller = new AbortController();
    const pending = unreachable(post('/slow', { signal: controller.signal, timeoutMs: 30_000 }));
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    expect(await pending).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('o POST de formulário e o GET seguem com o mesmo teto e o mesmo padrão', async () => {
    const form = await upstreamPostForm({ ...base, url: `${origin}/json`, body: { grant: 'x y' } });
    expect(form.status).toBe(200);
    expect(lastRequest.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(lastRequest.body).toBe('grant=x+y');
    expect(lastRequest.headers.accept).toBe('application/json');
    expect(await unreachable(upstreamGetJson({ ...base, url: `${origin}/big?size=1200000` }))).toBe(true);
    expect((await upstreamGetJson({ ...base, url: `${origin}/json` })).json).toEqual({ ok: true });
  });
});

describe('upstreamPostJson: `accept` e `maxBytes` (T9)', () => {
  it('`accept` troca o cabeçalho de formatos aceitos; um `accept` em `headers` ainda vence', async () => {
    await post('/json', { accept: 'application/json, text/event-stream' });
    expect(lastRequest.headers.accept).toBe('application/json, text/event-stream');
    await post('/json', { accept: 'text/event-stream', headers: { accept: 'application/json' } });
    expect(lastRequest.headers.accept).toBe('application/json');
  });

  it('`maxBytes` baixa o teto (um corpo de 2 KiB já não cabe em 1 KiB) ou o sobe (2 MiB cabem em 3 MiB)', async () => {
    expect(await unreachable(post('/big?size=2000', { maxBytes: 1_024 }))).toBe(true);
    expect((await post('/big?size=500', { maxBytes: 1_024 })).status).toBe(200);
    expect((await post(`/big?size=${2 * 1024 * 1024}`, { maxBytes: 3 * 1024 * 1024 })).status).toBe(200);
  });

  it('o teto vale também para o stream de eventos (resposta em `text/event-stream`)', async () => {
    expect(await unreachable(post('/sse-big?size=5000', { accept: 'text/event-stream', maxBytes: 1_024 }))).toBe(true);
    expect(await unreachable(post(`/sse-big?size=${1200000}`, { accept: 'text/event-stream' }))).toBe(true); // o padrão de 1 MiB
    expect((await post('/sse-big?size=500', { accept: 'text/event-stream', maxBytes: 1_024 })).status).toBe(200);
  });
});

describe('classifyStatus', () => {
  it('2xx aceita, 401 e 403 são chave recusada e o resto (429, 5xx, 404) é indisponibilidade, nunca culpa da chave', () => {
    expect([200, 204, 299].map(classifyStatus)).toEqual(['ok', 'ok', 'ok']);
    expect([401, 403].map(classifyStatus)).toEqual(['key-invalid', 'key-invalid']);
    expect([404, 408, 429, 500, 502, 503].map(classifyStatus)).toEqual(Array(6).fill('unavailable'));
  });
});

// Recusa de contexto é um sinal limitado (phase 9, F4): código conhecido ou mensagem de uma allowlist de padrões, só em 400/422 (e 413); nenhum outro 400 vira
// compactação forçada, e nada do corpo externo sai do transporte.
const PRIVATE = 'segredo-que-nao-pode-sair';
it.each([
  { name: 'código conhecido', status: 400, body: { error: { code: 'context_length_exceeded', message: PRIVATE } }, rejected: true },
  { name: 'outro código', status: 400, body: { error: { code: 'invalid_parameter', message: PRIVATE } }, rejected: false },
  { name: '413 sem corpo', status: 413, body: {}, rejected: true },
  { name: 'tipo do erro conhecido (Anthropic)', status: 413, body: { error: { type: 'request_too_large', message: PRIVATE } }, rejected: true },
  { name: 'mensagem conhecida, sem código (OpenAI/DeepSeek)', status: 400, body: { error: { message: `This model's maximum context length is 65536 tokens. However, you requested 70000 tokens. ${PRIVATE}` } }, rejected: true },
  { name: 'mensagem conhecida (Anthropic)', status: 400, body: { error: { type: 'invalid_request_error', message: `prompt is too long: 213462 tokens > 200000 maximum ${PRIVATE}` } }, rejected: true },
  { name: 'mensagem conhecida em 422', status: 422, body: { error: { message: `Please reduce the length of the messages or completion. ${PRIVATE}` } }, rejected: true },
  { name: 'erro como texto solto', status: 400, body: { error: `Your input exceeds the context window of this model. ${PRIVATE}` }, rejected: true },
  { name: 'erro de SAÍDA não é contexto', status: 400, body: { error: { message: `max_tokens is too large: 100000. This model supports at most 8192 completion tokens. ${PRIVATE}` } }, rejected: false },
  { name: 'cota por minuto não é contexto', status: 400, body: { error: { message: `Request too large for model on tokens per minute (TPM): Limit 6000, Requested 9000 ${PRIVATE}` } }, rejected: false },
  { name: 'só 400, 422 e 413 são lidos', status: 500, body: { error: { code: 'context_length_exceeded', message: PRIVATE } }, rejected: false },
])('classifica recusa de contexto sem usar qualquer 400 nem expor o corpo: $name', async ({ status, body, rejected }) => {
  const result = await upstreamPostStream({ url: 'http://fixture.invalid/chat', headers: {}, body: {}, timeoutMs: 1000, detectRejectedContext: true, fetchImpl: async () => new Response(JSON.stringify(body), { status }) });
  expect(result.rejectedContext === true).toBe(rejected);
  expect(result.body).toBeNull();
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
});

it('sem pedir a detecção, nenhuma recusa vira "contexto", mesmo com código e mensagem conhecidos', async () => {
  const result = await upstreamPostStream({ url: 'http://fixture.invalid/chat', headers: {}, body: {}, timeoutMs: 1000, fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 }) });
  expect(result.rejectedContext).toBeUndefined();
});

describe('isContextOverflowError', () => {
  it('reconhece as formas de cada provedor e ignora texto parecido de outros erros', () => {
    for (const message of [
      'This endpoint\'s maximum context length is 131072 tokens. However, you requested about 200000 tokens',
      'Your input exceeds the context window of this model. Please adjust your input and try again.',
      'input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000',
      'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575).',
      'This model\'s maximum prompt length is 131072 but the request contains 537812 tokens.',
      'Prompt contains 40000 tokens ... too large for model with 32768 maximum context length',
      'Your request exceeded model token limit: 262144 (requested: 300000)',
      'the request exceeds the available context size, try increasing it',
      'prompt token count of 140000 exceeds the limit of 128000',
      'Current length is 70000 while limit is 65536',
      'context window exceeds limit (2013)',
    ]) expect(isContextOverflowError({ message }), message).toBe(true);
    for (const message of ['Invalid API key', 'max_tokens must be at most 8192', 'Rate limit reached for requests', 'The model does not support images', '']) expect(isContextOverflowError({ message }), message).toBe(false);
    expect([undefined, null, 42, [], {}, { code: 7 }].map(isContextOverflowError)).toEqual(Array(6).fill(false));
  });
});
