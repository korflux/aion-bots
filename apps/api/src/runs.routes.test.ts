// Prova da conversa do bot pela borda HTTP (T6; A5, A6, A7, A9): sessão, CSRF e allowlist em todas as rotas, enfileirar e
// parar, repetir uma falha, paginação do histórico em rodadas e o SSE de ponta a ponta (API real, motor de execução real no mesmo
// processo e provedor falso), incluindo a retomada por `Last-Event-ID`. A regra de negócio está provada em @aion/core; aqui
// fica o que só a borda prova: contrato, segurança e o fluxo de bytes do SSE.
import { RunEngine, createAnthropicClient, createOpenCodeGoClient, createProviderRouter } from '@aion/core';
import { startFakeUpstreams, type FakeUpstreams } from '@aion/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedRounds } from './testing/conversation-seed';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

const PROVIDER_KEY = 'valid-provider-key-ABCD';
/** A chave da Anthropic do teste do SSE (A3): sem a palavra "key" no nome, para a regra generic-api-key do gitleaks não a tomar por segredo. */
const CLAUDE_CREDENTIAL = 'valid-anthropic-sse-WXYZ';
const CLIENT_IP = '203.0.113.91';

let upstreams: FakeUpstreams;
let api: TestApi;
let engine: RunEngine;
let baseUrl: string;
let session: { cookie: string; csrfToken: string };
/** Corpo de toda resposta e cabeçalhos: no fim se prova que a chave do provedor nunca saiu do servidor. */
const seen: string[] = [];

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  api = await createTestApi(
    { AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl, AION_ANTHROPIC_BASE_URL: upstreams.anthropicBaseUrl, AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl },
    { sse: { pollMs: 40, pingMs: 10_000, maxLifetimeMs: 30_000 } },
  );
  session = await api.login(CLIENT_IP);
  baseUrl = await api.app.listen({ port: 0, host: '127.0.0.1' });
  // O motor roda aqui no mesmo processo (em produção é o worker), sobre o mesmo banco e o mesmo provedor falso.
  engine = new RunEngine({
    pool: api.pool,
    credentials: api.credentials,
    // O roteador por provedor, como no worker: `opencode/...` vai ao OpenCode Go falso e `anthropic/...` à Anthropic falsa.
    provider: createProviderRouter({ opencode: createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, chatTimeoutMs: 15_000 }), anthropic: createAnthropicClient({ baseUrl: upstreams.anthropicBaseUrl, chatTimeoutMs: 15_000 }) }),
    models: api.models,
    logger: api.logger,
    config: { pollMs: 20, heartbeatMs: 40, flushMs: 15 },
  });
});

afterAll(async () => {
  await engine.stop();
  // O `fetch` do Node abre conexões TCP reservas que nunca recebem requisição; o servidor só as solta no timeout de 60 s.
  api.app.server.closeAllConnections();
  await api.cleanup();
  await upstreams.stop();
});

/** Chamada autenticada por padrão (cookie, Origin e token CSRF). */
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await api.app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'user-agent': CHROME_UA, ...headers },
    remoteAddress: CLIENT_IP,
  });
  seen.push(response.body, JSON.stringify(response.headers));
  return response;
}

const json = <T = Record<string, unknown>>(response: { json: () => unknown }) => response.json() as T;
const errorOf = (response: { json: () => unknown }) => response.json() as { code: string; message: string; fields?: { field: string; reason: string }[] };

interface Item {
  id: string;
  kind: string;
  role?: string;
  status: string;
  content?: string;
  card?: { type: string };
}
interface Snapshot {
  items: Item[];
  hasMore: boolean;
  runs: { id: string; status: string; input: string | null }[];
  lastEventId: string;
  model: { model: string | null; effort: string | null };
  providerConfigured: boolean;
}
const snapshotOf = async (botId: string) => json<Snapshot>(await call('GET', `/api/bots/${botId}/conversation`));

async function createBot(overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await call('POST', '/api/bots', {
    name: `Bot ${Math.random().toString(36).slice(2, 8)}`,
    color: '#60A5FA',
    instructions: '',
    model: 'opencode/glm-5.1',
    effort: null,
    stepLimit: 25,
    ...overrides,
  });
  expect(created.statusCode).toBe(201);
  return json<{ id: string }>(created).id;
}

async function waitFor<T>(description: string, probe: () => Promise<T | null | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`prazo estourado esperando: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------------------------
// Leitor de SSE
// ---------------------------------------------------------------------------------------------

interface Frame {
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
  comment?: string;
  retry?: string;
}

/** Abre o SSE de verdade (fetch em streaming) e devolve os quadros como um gerador. `close()` encerra a conexão. */
async function openEvents(
  botId: string,
  { after, lastEventId }: { after?: string; lastEventId?: string } = {},
  target: { baseUrl: string; cookie: string } = { baseUrl, cookie: session.cookie },
) {
  const controller = new AbortController();
  const query = after === undefined ? '' : `?after=${after}`;
  const response = await fetch(`${target.baseUrl}/api/bots/${botId}/conversation/events${query}`, {
    headers: { cookie: target.cookie, ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }) },
    signal: controller.signal,
  });
  async function* frames(): AsyncGenerator<Frame> {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const frame: Frame = {};
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) frame.comment = line.slice(1).trim();
            else if (line.startsWith('id: ')) frame.id = line.slice(4);
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('retry: ')) frame.retry = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6)) as Record<string, unknown>;
          }
          yield frame;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }
  return { response, frames: frames(), close: () => controller.abort() };
}

/** Lê quadros até o predicado aceitar um, devolvendo todos os lidos (falha se passar do prazo). */
async function collectUntil(frames: AsyncGenerator<Frame>, done: (frame: Frame) => boolean, timeoutMs = 15_000): Promise<Frame[]> {
  const read: Frame[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const next = await Promise.race([
      frames.next(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), Math.max(1, deadline - Date.now()))),
    ]);
    if (next === 'timeout' || next.done) throw new Error(`o stream terminou antes do esperado; quadros lidos: ${JSON.stringify(read)}`);
    read.push(next.value);
    if (done(next.value)) return read;
  }
}

// ---------------------------------------------------------------------------------------------

describe('segurança e contrato', () => {
  it('toda rota exige sessão; as que alteram estado exigem também Origin e token CSRF; ids e corpos são validados na borda', async () => {
    const provider = await call('POST', '/api/credentials/provider', { key: PROVIDER_KEY });
    expect(provider.statusCode).toBe(200);
    const botId = await createBot();
    const routes: ['GET' | 'POST' | 'PATCH', string, unknown?][] = [
      ['GET', `/api/bots/${botId}/conversation`],
      ['GET', `/api/bots/${botId}/conversation/messages`],
      ['GET', `/api/bots/${botId}/conversation/events`],
      ['POST', `/api/bots/${botId}/messages`, { content: 'oi' }],
      ['PATCH', `/api/bots/${botId}/conversation`, { model: 'opencode/glm-5.1', effort: null }],
      ['POST', `/api/bots/${botId}/runs/stop`],
      ['POST', `/api/bots/${botId}/runs/1/retry`],
      ['POST', `/api/bots/${botId}/complements/cancel`, { complementId: '1' }],
      ['POST', `/api/bots/${botId}/draft/1/consume`],
    ];
    for (const [method, url, payload] of routes) {
      const anonymous = await api.app.inject({ method, url, payload: payload as object | undefined, headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
      expect([url, anonymous.statusCode, errorOf(anonymous).code]).toEqual([url, 401, 'AUTH_SESSION_EXPIRED']);
    }
    for (const [method, url, payload] of routes.filter(([method]) => method !== 'GET')) {
      const noCsrf = await call(method, url, payload, { 'x-csrf-token': '' });
      expect([url, noCsrf.statusCode, errorOf(noCsrf).code]).toEqual([url, 403, 'CSRF_TOKEN_INVALID']);
      const wrongOrigin = await call(method, url, payload, { origin: 'https://evil.example' });
      expect([url, wrongOrigin.statusCode, errorOf(wrongOrigin).code]).toEqual([url, 403, 'CSRF_ORIGIN_INVALID']);
    }

    // Allowlist e limites: campo extra, texto vazio ou em branco, caracteres de controle e tamanho acima de 32.000.
    const invalidBodies: unknown[] = [
      { content: 'oi', botId: 'outro' },
      { content: '' },
      { content: '   \n  ' },
      { content: 'ola\u0000mundo' },
      { content: 'x'.repeat(32_001) },
      { content: 42 },
      {},
    ];
    for (const body of invalidBodies) {
      const response = await call('POST', `/api/bots/${botId}/messages`, body);
      expect([JSON.stringify(body).slice(0, 40), response.statusCode, errorOf(response).code]).toEqual([JSON.stringify(body).slice(0, 40), 422, 'VALIDATION_FAILED']);
    }
    expect((await call('POST', `/api/bots/${botId}/messages`, { content: 'x'.repeat(32_000) })).statusCode).toBe(201); // no limite, passa
    expect((await call('GET', `/api/bots/nao-e-uuid/conversation`)).statusCode).toBe(422);
    expect((await call('GET', `/api/bots/${botId}/conversation/messages?before=abc`)).statusCode).toBe(422);
    // Tamanho da página em rodadas: inteiro de 1 a 50. O antigo `limit` (em itens) deixou de existir e, como todo campo extra, é recusado.
    for (const query of ['rounds=0', 'rounds=51', 'rounds=1.5', 'rounds=abc', 'rounds=', 'limit=5', 'coisa=1']) {
      expect([query, (await call('GET', `/api/bots/${botId}/conversation/messages?${query}`)).statusCode]).toEqual([query, 422]);
    }
    for (const rounds of [1, 50]) expect((await call('GET', `/api/bots/${botId}/conversation/messages?rounds=${rounds}`)).statusCode).toBe(200);
    expect((await call('POST', `/api/bots/${botId}/runs/abc/retry`)).statusCode).toBe(422);
    // Complemento e rascunho (phase 4, F5): corpo estrito só com o id, e ids na forma de inteiro.
    for (const body of [{ complementId: '1', extra: true }, { complementId: 'abc' }, {}]) {
      expect([JSON.stringify(body), (await call('POST', `/api/bots/${botId}/complements/cancel`, body)).statusCode]).toEqual([JSON.stringify(body), 422]);
    }
    expect((await call('POST', `/api/bots/${botId}/draft/abc/consume`)).statusCode).toBe(422);
    expect(errorOf(await call('GET', '/api/bots/00000000-0000-4000-8000-000000000000/conversation')).code).toBe('BOT_NOT_FOUND');
    expect(errorOf(await call('POST', '/api/bots/00000000-0000-4000-8000-000000000000/messages', { content: 'oi' })).code).toBe('BOT_NOT_FOUND');
    expect((await call('PATCH', `/api/bots/${botId}/conversation`, { model: 'opencode/glm-5.1', effort: null, extra: 1 })).statusCode).toBe(422);
    expect(errorOf(await call('PATCH', `/api/bots/${botId}/conversation`, { model: 'modelo-inexistente', effort: null })).code).toBe('MODEL_UNAVAILABLE');
  });

  it('envio HTTP valida IDs, código específico de duplicado e retorna metadados seguros na fila', async () => {
    const bot = await createBot();
    const uploaded = await call('POST', `/api/bots/${bot}/attachments`, Buffer.from('texto privado'), {
      'content-type': 'application/octet-stream', 'x-attachment-name': 'arquivo.txt',
    });
    expect(uploaded.statusCode).toBe(201);
    const id = json<{ id: string }>(uploaded).id;
    expect(errorOf(await call('POST', `/api/bots/${bot}/messages`, { content: 'olá', attachmentIds: [id, id] })).code).toBe('ATTACHMENT_NOT_FOUND');
    for (const attachmentIds of [Array(6).fill(id), ['abc'], [true]]) {
      expect(errorOf(await call('POST', `/api/bots/${bot}/messages`, { content: 'olá', attachmentIds })).code).toBe('VALIDATION_FAILED');
    }
    // Uma falha simultânea de conteúdo não é traduzida para a classificação específica dos IDs.
    expect(errorOf(await call('POST', `/api/bots/${bot}/messages`, { content: '', attachmentIds: [id, id] })).code).toBe('VALIDATION_FAILED');
    const sent = await call('POST', `/api/bots/${bot}/messages`, { content: 'olá', attachmentIds: [id] });
    expect(sent.statusCode).toBe(201);
    expect(json(sent)).toMatchObject({ attachments: [{ id, name: 'arquivo.txt', kind: 'document', sizeBytes: Buffer.byteLength('texto privado'), removed: false }] });
    expect(sent.body).not.toContain('texto privado');
    expect(errorOf(await call('POST', `/api/bots/${bot}/messages`, { content: 'de novo', attachmentIds: [id] })).code).toBe('ATTACHMENT_NOT_FOUND');
  });
});

describe('enfileirar, parar e repetir', () => {
  it('a mensagem entra na fila, a fila tem teto de 20, e parar sem execução ativa é RUN_NOT_ACTIVE', async () => {
    const botId = await createBot();
    const first = await call('POST', `/api/bots/${botId}/messages`, { content: 'primeira' });
    expect(first.statusCode).toBe(201);
    expect(json(first)).toMatchObject({ status: 'queued', input: 'primeira', toolCalls: 0, failureCode: null, startedAt: null });
    for (let index = 2; index <= 20; index += 1) expect((await call('POST', `/api/bots/${botId}/messages`, { content: `m${index}` })).statusCode).toBe(201);
    const overflow = await call('POST', `/api/bots/${botId}/messages`, { content: 'm21' });
    expect([overflow.statusCode, errorOf(overflow).code]).toEqual([429, 'QUEUE_FULL']);

    const snapshot = await snapshotOf(botId);
    expect(snapshot.items).toEqual([]); // a mensagem só entra na linha do tempo quando a execução começa
    expect(snapshot.runs).toHaveLength(20);
    expect(snapshot).toMatchObject({ providerConfigured: true, model: { model: 'opencode/glm-5.1', effort: null }, hasMore: false });

    const stop = await call('POST', `/api/bots/${botId}/runs/stop`);
    expect([stop.statusCode, errorOf(stop).code]).toEqual([409, 'RUN_NOT_ACTIVE']);
  });

  it('o SSE mostra na hora a mensagem que entrou na fila (outra aba a vê antes de a execução começar)', async () => {
    // O motor só é ligado nos testes seguintes, então a execução fica `queued` e o estado observado é esse.
    const botId = await createBot();
    const { lastEventId } = await snapshotOf(botId);
    const stream = await openEvents(botId, { after: lastEventId });
    try {
      const sent = json<{ id: string }>(await call('POST', `/api/bots/${botId}/messages`, { content: 'vai para a fila' }));
      const read = await collectUntil(stream.frames, (frame) => frame.event === 'run');
      expect(read.find((frame) => frame.event === 'run')?.data).toMatchObject({ id: sent.id, status: 'queued', input: 'vai para a fila' });
    } finally {
      stream.close();
    }
  });

  it('bot arquivado não recebe mensagem; a preferência da conversa troca o modelo sem mexer no padrão do bot', async () => {
    const botId = await createBot();
    const preference = await call('PATCH', `/api/bots/${botId}/conversation`, { model: 'opencode/glm-5.3-flash', effort: null });
    expect([preference.statusCode, json(preference)]).toEqual([200, { model: 'opencode/glm-5.3-flash', effort: null, effortLevels: [] }]);
    expect((await snapshotOf(botId)).model).toEqual({ model: 'opencode/glm-5.3-flash', effort: null, effortLevels: [] });
    expect(json<{ model: string }>(await call('GET', `/api/bots/${botId}`)).model).toBe('opencode/glm-5.1');

    expect((await call('POST', `/api/bots/${botId}/archive`)).statusCode).toBe(200);
    const archived = await call('POST', `/api/bots/${botId}/messages`, { content: 'oi' });
    expect([archived.statusCode, errorOf(archived).code]).toEqual([409, 'BOT_ARCHIVED']);
  });

  it('parar a execução ativa gera o cartão; a falha do provedor vira cartão seguro e "tentar novamente" só vale para a última que falhou', async () => {
    engine.start();
    const botId = await createBot();
    await call('POST', `/api/bots/${botId}/messages`, { content: '[demorar] continua' });
    await waitFor('execução ativa com texto', async () => {
      const snapshot = await snapshotOf(botId);
      return snapshot.runs[0]?.status === 'running' && snapshot.items.some((item) => item.role === 'assistant' && item.content?.includes('passo 2'));
    });
    const stop = await call('POST', `/api/bots/${botId}/runs/stop`);
    expect([stop.statusCode, json(stop)]).toMatchObject([200, { status: 'running' }]); // assíncrono: o worker lê o pedido logo depois
    await waitFor('execução interrompida', async () => (await snapshotOf(botId)).items.some((item) => item.card?.type === 'run_interrupted'));
    expect((await snapshotOf(botId)).runs).toEqual([]);

    // Falha do provedor: cartão com código seguro e sem nada do corpo do erro do provedor.
    const failing = json<{ id: string }>(await call('POST', `/api/bots/${botId}/messages`, { content: '[falha] provedor fora' }));
    await waitFor('execução falhou', async () => (await snapshotOf(botId)).items.some((item) => item.card?.type === 'run_failed'));
    const failed = (await snapshotOf(botId)).items.find((item) => item.card?.type === 'run_failed') as Item & { card: { code: string }; content: string };
    expect(failed.card.code).toBe('PROVIDER_ERROR');
    expect(failed.content).toBe('O provedor falhou ao responder. Tente novamente.');

    const other = await createBot();
    const crossBot = await call('POST', `/api/bots/${other}/runs/${failing.id}/retry`);
    expect([crossBot.statusCode, errorOf(crossBot).code]).toEqual([409, 'RUN_NOT_RETRYABLE']); // a execução é de outro bot

    const retried = await call('POST', `/api/bots/${botId}/runs/${failing.id}/retry`);
    expect(retried.statusCode).toBe(201);
    await waitFor('repetição concluída', async () => {
      const snapshot = await snapshotOf(botId);
      return snapshot.runs.length === 0 && snapshot.items.at(-1)?.role === 'assistant' && snapshot.items.at(-1)?.status === 'done';
    });
    const again = await call('POST', `/api/bots/${botId}/runs/${failing.id}/retry`);
    expect([again.statusCode, errorOf(again).code]).toEqual([409, 'RUN_NOT_RETRYABLE']); // já foi refeita
  });

  it('pagina o histórico em rodadas (10 por padrão, `rounds` de 1 a 50), sempre na abertura de uma rodada, com `before` sendo o id da mensagem e sem contar o descartado', async () => {
    const botId = await createBot();
    const conversationId = (await api.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [botId])).rows[0]!.id;
    // 25 rodadas com 0, 1 e 2 chamadas de ferramenta em revezamento: o tamanho em itens varia, o em rodadas não.
    const seeded = await seedRounds(api.pool, conversationId, Array.from({ length: 25 }, (_, index) => index % 3));
    const idsOf = (from: number, to: number) => seeded.slice(from, to).flatMap((round) => round.ids);
    const page = async (query: string) => json<{ items: Item[]; hasMore: boolean }>(await call('GET', `/api/bots/${botId}/conversation/messages${query}`));
    const ids = (result: { items: Item[] }) => result.items.map((item) => item.id);

    // A tela abre com as 10 últimas rodadas (o snapshot e a página sem `before` são a mesma janela).
    const opening = await snapshotOf(botId);
    expect(ids(opening)).toEqual(idsOf(15, 25));
    expect(opening.hasMore).toBe(true);
    expect(ids(await page(''))).toEqual(idsOf(15, 25));

    // `before` é o id da primeira mensagem que a tela já tem: vêm as 10 anteriores e depois as 5 que restam, sem repetir nem pular.
    const middle = await page(`?before=${opening.items[0]!.id}`);
    expect(ids(middle)).toEqual(idsOf(5, 15));
    expect(middle.hasMore).toBe(true);
    const oldest = await page(`?before=${middle.items[0]!.id}`);
    expect(ids(oldest)).toEqual(idsOf(0, 5));
    expect(oldest.hasMore).toBe(false);
    for (const result of [opening, middle, oldest]) expect(result.items[0]).toMatchObject({ kind: 'text', role: 'user' }); // toda página começa numa abertura

    // `rounds` muda o tamanho da página; 50, mais do que existe, traz tudo. O formato da resposta é o de sempre: só `items` e `hasMore`.
    expect(ids(await page('?rounds=3'))).toEqual(idsOf(22, 25));
    expect(ids(await page('?rounds=1'))).toEqual(idsOf(24, 25));
    const everything = await page('?rounds=50');
    expect(ids(everything)).toEqual(idsOf(0, 25));
    expect(everything.hasMore).toBe(false);
    expect(Object.keys(everything).sort()).toEqual(['hasMore', 'items']);

    // `before` no meio de uma rodada: a dela vem só até ali (a abertura e o que veio antes da linha), e as anteriores vêm inteiras.
    const withTools = seeded[17]!; // 17 % 3 = 2 chamadas de ferramenta
    const midRound = await page(`?before=${withTools.activities[1]}&rounds=2`);
    expect(ids(midRound)).toEqual([...seeded[16]!.ids, withTools.opener, withTools.activities[0]]);

    // Linhas descartadas (texto e chamadas abandonados por um reinício) não aparecem; a janela segue sendo de 10 rodadas.
    const discarded = [seeded[23]!.activities[0]!, seeded[23]!.reply, seeded[20]!.reply];
    await api.pool.query("UPDATE messages SET status = 'discarded' WHERE id = ANY($1::bigint[])", [discarded]);
    expect(ids(await page(''))).toEqual(idsOf(15, 25).filter((id) => !discarded.includes(id)));
  });

  it('uma página nunca passa de 300 itens: acima disso corta as mais antigas, e o `before` seguinte completa a rodada cortada sem repetir nem perder linha', async () => {
    const botId = await createBot();
    const conversationId = (await api.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [botId])).rows[0]!.id;
    // 3 rodadas; a do meio tem 350 chamadas de ferramenta (352 linhas com a pergunta e a resposta), mais do que cabe numa página.
    const seeded = await seedRounds(api.pool, conversationId, [2, 350, 2]);
    const all = seeded.flatMap((round) => round.ids); // 4 + 352 + 4 = 360 linhas
    const page = async (query: string) => json<{ items: Item[]; hasMore: boolean }>(await call('GET', `/api/bots/${botId}/conversation/messages${query}`));

    const opening = await snapshotOf(botId);
    expect(opening.items.map((item) => item.id)).toEqual(all.slice(-300));
    expect(opening.hasMore).toBe(true);
    const wide = await page('?rounds=50'); // pedir mais rodadas não passa do teto
    expect(wide.items).toHaveLength(300);
    expect(wide.hasMore).toBe(true);

    const rest = await page(`?before=${opening.items[0]!.id}`);
    expect(rest.items.map((item) => item.id)).toEqual(all.slice(0, 60)); // a rodada cortada completa (abertura e o começo dela) e a primeira rodada
    expect(rest.hasMore).toBe(false);
  });
});

describe('complemento pela borda (phase 4, F5)', () => {
  it('enviar com execução ativa responde complemento; cancelar e usar o rascunho só valem na própria conversa e uma vez', async () => {
    engine.start();
    const botId = await createBot();
    const otherBot = await createBot();
    await call('POST', `/api/bots/${botId}/messages`, { content: '[demorar] segura' });
    await waitFor('execução ativa', async () => (await snapshotOf(botId)).runs.some((run) => run.status === 'running'));

    const sent = await call('POST', `/api/bots/${botId}/messages`, { content: 'complemento pela API' });
    expect(sent.statusCode).toBe(201);
    const complement = json<{ id: string; kind: string }>(sent);
    expect(complement).toMatchObject({ kind: 'complement', content: 'complemento pela API', attachments: [] });
    expect(json<{ runs: { complements: { id: string }[] }[] }>(await call('GET', `/api/bots/${botId}/conversation`)).runs[0]?.complements).toEqual([expect.objectContaining({ id: complement.id })]);

    // Anti-IDOR: o id do complemento de outra conversa parece inexistente.
    const foreign = await call('POST', `/api/bots/${otherBot}/complements/cancel`, { complementId: complement.id });
    expect([foreign.statusCode, errorOf(foreign).code]).toEqual([404, 'COMPLEMENT_NOT_FOUND']);
    const cancelled = await call('POST', `/api/bots/${botId}/complements/cancel`, { complementId: complement.id });
    expect(cancelled.statusCode).toBe(200);
    const draft = json<{ id: string; content: string }>(cancelled);
    expect(draft.content).toBe('complemento pela API');
    expect(json<{ draft: { id: string } | null }>(await call('GET', `/api/bots/${botId}/conversation`)).draft).toMatchObject({ id: draft.id });

    const foreignDraft = await call('POST', `/api/bots/${otherBot}/draft/${draft.id}/consume`);
    expect([foreignDraft.statusCode, errorOf(foreignDraft).code]).toEqual([404, 'DRAFT_NOT_FOUND']);
    const used = await call('POST', `/api/bots/${botId}/draft/${draft.id}/consume`);
    expect([used.statusCode, json<{ content: string }>(used).content]).toEqual([200, 'complemento pela API']);
    const again = await call('POST', `/api/bots/${botId}/draft/${draft.id}/consume`);
    expect([again.statusCode, errorOf(again).code]).toEqual([404, 'DRAFT_NOT_FOUND']);

    expect((await call('POST', `/api/bots/${botId}/runs/stop`)).statusCode).toBe(200);
    await waitFor('parada', async () => (await snapshotOf(botId)).runs.length === 0);
  });
});

describe('SSE da conversa', () => {
  it('transmite a resposta aos poucos, com o estado atual da linha e o id do evento, e a retomada por Last-Event-ID é idempotente', async () => {
    engine.start();
    const botId = await createBot();
    const { lastEventId } = await snapshotOf(botId);
    const stream = await openEvents(botId, { after: lastEventId });
    try {
      // Cabeçalhos: fluxo de eventos sem cache e com os cabeçalhos de segurança de toda resposta da API.
      expect(stream.response.status).toBe(200);
      expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
      expect(stream.response.headers.get('cache-control')).toBe('no-store');
      expect(stream.response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(stream.response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(stream.response.headers.get('x-accel-buffering')).toBe('no');

      await call('POST', `/api/bots/${botId}/messages`, { content: '[lento] transmita' });
      const read = await collectUntil(
        stream.frames,
        (frame) => frame.event === 'run' && frame.data?.status === 'completed',
      );
      expect(read[0]).toEqual({ retry: '3000' });
      const events = read.filter((frame) => frame.event !== undefined);
      expect(events.every((frame) => /^\d+$/.test(frame.id ?? ''))).toBe(true);

      // A mensagem do dono entra ao começar a execução; a resposta aparece pela metade e termina inteira.
      expect(events.some((frame) => frame.event === 'message' && frame.data?.role === 'user' && frame.data.content === '[lento] transmita')).toBe(true);
      const assistant = events.filter((frame) => frame.event === 'message' && frame.data?.role === 'assistant').map((frame) => frame.data as { status: string; content: string });
      expect(assistant.some((update) => update.status === 'streaming' && update.content.length > 0 && !update.content.includes('parte8'))).toBe(true);
      expect(assistant.at(-1)).toMatchObject({ status: 'done', content: expect.stringContaining('parte8') });
      // Cada atualização traz o texto COMPLETO até ali (nunca um pedaço solto): o texto só cresce.
      const lengths = assistant.map((update) => update.content.length);
      expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
      // Queued e execução ativa aparecem como evento de execução com o estado atual.
      expect(events.filter((frame) => frame.event === 'run').map((frame) => frame.data?.status)).toContain('completed');

      // Retomada: a partir de um id do meio, só vem o que aconteceu DEPOIS e sempre com o estado atual (inclusive o final).
      const middle = events.find((frame) => frame.event === 'message' && frame.data?.role === 'assistant' && frame.data.status === 'streaming');
      const resumed = await openEvents(botId, { lastEventId: middle?.id });
      try {
        const replay = await collectUntil(resumed.frames, (frame) => frame.event === 'run' && frame.data?.status === 'completed');
        const replayEvents = replay.filter((frame) => frame.event !== undefined);
        expect(replayEvents.every((frame) => BigInt(frame.id ?? '0') > BigInt(middle?.id ?? '0'))).toBe(true);
        const finalAssistant = replayEvents.filter((frame) => frame.event === 'message' && frame.data?.role === 'assistant').at(-1);
        expect(finalAssistant?.data).toMatchObject({ status: 'done', content: expect.stringContaining('parte8') });
        // A mensagem do dono veio ANTES do ponto de retomada e não é reenviada.
        expect(replayEvents.some((frame) => frame.data?.role === 'user')).toBe(false);
      } finally {
        resumed.close();
      }

      // O cabeçalho prevalece sobre `?after=` (o navegador o envia sozinho ao reconectar); um valor inválido é ignorado.
      // O desfecho também publica contexto/usage; cursor do snapshot inclui essa invalidação legítima posterior ao evento run.
      const terminalCursor=(await snapshotOf(botId)).lastEventId;
      const header = await openEvents(botId, { after: '0', lastEventId: terminalCursor });
      try {
        await expect(collectUntil(header.frames, (frame) => frame.event !== undefined, 400)).rejects.toThrow(/terminou antes do esperado/); // nada novo
      } finally {
        header.close();
      }
      const invalid = await openEvents(botId, { after: terminalCursor, lastEventId: 'lixo' });
      try {
        expect(invalid.response.status).toBe(200);
        await expect(collectUntil(invalid.frames, (frame) => frame.event !== undefined, 400)).rejects.toThrow(/terminou antes do esperado/);
      } finally {
        invalid.close();
      }
    } finally {
      stream.close();
    }
  });

  it('sem ponto de retomada começa do que for novo; bot inexistente e sessão ausente recebem o envelope de erro, não um stream', async () => {
    engine.start();
    const botId = await createBot();
    await call('POST', `/api/bots/${botId}/messages`, { content: 'antiga' });
    await waitFor('resposta antiga', async () => (await snapshotOf(botId)).items.length === 2 && (await snapshotOf(botId)).runs.length === 0);

    const fresh = await openEvents(botId);
    try {
      await call('POST', `/api/bots/${botId}/messages`, { content: 'nova' });
      const read = await collectUntil(fresh.frames, (frame) => frame.event === 'run' && frame.data?.status === 'completed');
      const contents = read.flatMap((frame) => (typeof frame.data?.content === 'string' ? [frame.data.content] : []));
      expect(contents).toContain('nova');
      expect(contents).not.toContain('antiga'); // a conversa anterior não é reenviada
    } finally {
      fresh.close();
    }

    const missing = await fetch(`${baseUrl}/api/bots/00000000-0000-4000-8000-000000000000/conversation/events`, { headers: { cookie: session.cookie } });
    expect([missing.status, (await missing.json() as { code: string }).code]).toEqual([404, 'BOT_NOT_FOUND']);
    const anonymous = await fetch(`${baseUrl}/api/bots/${botId}/conversation/events`);
    expect([anonymous.status, (await anonymous.json() as { code: string }).code]).toEqual([401, 'AUTH_SESSION_EXPIRED']);
  });
});

describe('encerramento da API', () => {
  it('ao fechar a API os streams SSE abertos terminam na hora, em vez de segurar o encerramento até o limite de duração', async () => {
    // API própria: fechar a compartilhada quebraria os outros testes.
    const own = await createTestApi({}, { sse: { pollMs: 40, pingMs: 10_000, maxLifetimeMs: 10 * 60_000 } });
    try {
      const login = await own.login('203.0.113.92');
      const target = { baseUrl: await own.app.listen({ port: 0, host: '127.0.0.1' }), cookie: login.cookie };
      const created = await own.app.inject({
        method: 'POST',
        url: '/api/bots',
        payload: { name: 'Fechamento', color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 25 },
        headers: { origin: ORIGIN, cookie: login.cookie, 'x-csrf-token': login.csrfToken },
        remoteAddress: '203.0.113.92',
      });
      expect(created.statusCode).toBe(201);
      const stream = await openEvents(created.json<{ id: string }>().id, {}, target);
      expect((await stream.frames.next()).value).toEqual({ retry: '3000' }); // o stream está aberto e vivo

      const started = Date.now();
      await own.app.close();
      expect(Date.now() - started).toBeLessThan(3_000);
      // O cliente vê o fim do stream (não fica pendurado esperando eventos).
      expect((await stream.frames.next()).done).toBe(true);
      stream.close();
    } finally {
      own.app.server.closeAllConnections();
      await own.cleanup();
    }
  });
});

describe('o valor da chave da Anthropic nunca sai pelo SSE (phase 17, A3)', () => {
  it('uma execução feita com a chave da Anthropic, concluída e recusada por saldo, não deixa o valor da chave em nenhum quadro do stream, resposta HTTP, cabeçalho nem log', async () => {
    engine.start();
    const saved = await call('POST', '/api/credentials/anthropic', { key: CLAUDE_CREDENTIAL });
    expect(saved.statusCode).toBe(200);
    try {
      const botId = await createBot({ model: 'anthropic/claude-haiku-5-5' });
      const { lastEventId } = await snapshotOf(botId);
      const stream = await openEvents(botId, { after: lastEventId });
      try {
        const frames: Frame[] = [];
        // Uma execução que conclui (o texto chega pelo SSE) e outra que o saldo esgotado recusa (o cartão de falha chega pelo SSE).
        await call('POST', `/api/bots/${botId}/messages`, { content: 'Oi, Claude' });
        frames.push(...(await collectUntil(stream.frames, (frame) => frame.event === 'run' && frame.data?.status === 'completed')));
        await call('POST', `/api/bots/${botId}/messages`, { content: '[sem-saldo] escreva algo' });
        frames.push(...(await collectUntil(stream.frames, (frame) => frame.event === 'run' && frame.data?.status === 'failed')));
        const everything = JSON.stringify(frames);
        expect(everything).toContain('Resposta: Oi, Claude'); // o stream carregou mesmo a resposta do Claude
        expect(everything).toContain('PROVIDER_CREDITS_EXHAUSTED');
        expect(everything).not.toContain(CLAUDE_CREDENTIAL);
        expect(everything).not.toContain('x-api-key');
        // As respostas HTTP, os cabeçalhos e o log da API também não a trazem.
        const reread = JSON.stringify(await snapshotOf(botId));
        expect(reread).not.toContain(CLAUDE_CREDENTIAL);
        expect(seen.join('\n')).not.toContain(CLAUDE_CREDENTIAL);
        expect(api.logs.join('\n')).not.toContain(CLAUDE_CREDENTIAL);
      } finally {
        stream.close();
      }
    } finally {
      await call('DELETE', '/api/credentials/anthropic');
    }
  });
});

describe('o que nunca sai do servidor', () => {
  it('nenhuma resposta da conversa contém a chave do provedor nem do Composio', () => {
    for (const body of seen) {
      expect(body).not.toContain(PROVIDER_KEY);
      expect(body).not.toContain('composio');
    }
    expect(api.logs.join('\n')).not.toContain(PROVIDER_KEY);
  });
});
