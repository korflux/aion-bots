// Prova da memória pela borda HTTP (T8; A11, MEM-01, MEM-02; F11): sessão, CSRF e allowlist em todas as rotas, o contrato dos erros
// (limite, conflito, versão inexistente), o fluxo do dono (salvar, histórico, restaurar) e o fluxo do bot de ponta a ponta (API real,
// motor real no mesmo processo e provedor falso): a edição do bot chega como cartão na conversa e o desfazer pelo cartão restaura.
// A regra de negócio está provada em @aion/core; aqui fica o que só a borda prova: contrato, segurança e códigos de erro.
import { RunEngine, createOpenCodeGoClient } from '@aion/core';
import { startFakeUpstreams, type FakeUpstreams } from '@aion/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

const PROVIDER_KEY = 'valid-provider-key-ABCD';
const CLIENT_IP = '203.0.113.93';
const GHOST = '00000000-0000-4000-8000-000000000000';

let upstreams: FakeUpstreams;
let api: TestApi;
let engine: RunEngine;
let session: { cookie: string; csrfToken: string };

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  api = await createTestApi({ AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl, AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl });
  session = await api.login(CLIENT_IP);
  // Criar um bot com modelo confere o modelo na lista do provedor, e o motor precisa da chave para executar.
  const provider = await api.app.inject({
    method: 'POST',
    url: '/api/credentials/provider',
    payload: { key: PROVIDER_KEY },
    headers: { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'user-agent': CHROME_UA },
    remoteAddress: CLIENT_IP,
  });
  if (provider.statusCode !== 200) throw new Error(`falha ao configurar o provedor falso: ${provider.statusCode}`);
  // O motor roda aqui no mesmo processo (em produção é o worker), sobre o mesmo banco e o provedor falso.
  engine = new RunEngine({
    pool: api.pool,
    credentials: api.credentials,
    provider: createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, chatTimeoutMs: 15_000 }),
    models: api.models,
    logger: api.logger,
    config: { pollMs: 20, heartbeatMs: 40, flushMs: 15 },
  });
  engine.start();
});

afterAll(async () => {
  await engine.stop();
  api.app.server.closeAllConnections();
  await api.cleanup();
  await upstreams.stop();
});

/** Chamada autenticada por padrão (cookie, Origin e token CSRF). */
async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return api.app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'user-agent': CHROME_UA, ...headers },
    remoteAddress: CLIENT_IP,
  });
}

const json = <T = Record<string, unknown>>(response: { json: () => unknown }) => response.json() as T;
const errorOf = (response: { json: () => unknown }) => response.json() as { code: string; message: string };

async function waitFor<T>(description: string, probe: () => Promise<T | null | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`prazo estourado esperando: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface MemoryBody {
  content: string;
  version: number;
  limit: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

async function createBot(): Promise<string> {
  const created = await call('POST', '/api/bots', {
    name: `Bot ${Math.random().toString(36).slice(2, 8)}`,
    color: '#60A5FA',
    instructions: '',
    model: 'opencode/glm-5.1',
    effort: null,
    stepLimit: 25,
  });
  expect(created.statusCode).toBe(201);
  return json<{ id: string }>(created).id;
}

describe('segurança e contrato', () => {
  it('toda rota exige sessão; as que alteram estado exigem Origin e token CSRF; ids, versões e campos extras são recusados na borda', async () => {
    const botId = await createBot();
    const routes: ['GET' | 'POST' | 'PUT', string, unknown?][] = [
      ['GET', '/api/memory/global'],
      ['PUT', '/api/memory/global', { content: 'x', expectedVersion: 0 }],
      ['GET', '/api/memory/global/versions'],
      ['GET', '/api/memory/global/versions/1'],
      ['POST', '/api/memory/global/restore', { version: 1, expectedVersion: 0 }],
      ['GET', `/api/bots/${botId}/memory`],
      ['PUT', `/api/bots/${botId}/memory`, { content: 'x', expectedVersion: 0 }],
      ['GET', `/api/bots/${botId}/memory/versions`],
      ['GET', `/api/bots/${botId}/memory/versions/1`],
      ['POST', `/api/bots/${botId}/memory/restore`, { version: 1, expectedVersion: 0 }],
      ['POST', `/api/bots/${botId}/memory/undo`, { cardId: '1' }],
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

    // Validação na borda: versão inteira não negativa, texto sem caracteres de controle, nada além do declarado (nem `scope`, nem
    // `botId`: o dono escolhe a memória pela URL, e o bot não tem rota nenhuma).
    for (const [method, url, payload] of [
      ['PUT', '/api/memory/global', { content: 'x', expectedVersion: -1 }],
      ['PUT', '/api/memory/global', { content: 'x', expectedVersion: 1.5 }],
      ['PUT', '/api/memory/global', { content: 'x', expectedVersion: '0' }],
      ['PUT', '/api/memory/global', { content: 'x' }],
      ['PUT', '/api/memory/global', { content: 'com nulo\u0000', expectedVersion: 0 }],
      ['PUT', '/api/memory/global', { content: 'x'.repeat(100_001), expectedVersion: 0 }],
      ['PUT', '/api/memory/global', { content: 'x', expectedVersion: 0, scope: 'global' }],
      ['PUT', `/api/bots/${botId}/memory`, { content: 'x', expectedVersion: 0, botId }],
      ['PUT', '/api/bots/nao-e-uuid/memory', { content: 'x', expectedVersion: 0 }],
      ['POST', '/api/memory/global/restore', { version: 0, expectedVersion: 0 }],
      ['POST', `/api/bots/${botId}/memory/restore`, { version: 1 }],
      ['POST', `/api/bots/${botId}/memory/undo`, { cardId: 'abc' }],
      ['POST', `/api/bots/${botId}/memory/undo`, { cardId: '1', extra: true }],
      ['GET', '/api/memory/global/versions/abc'],
      ['GET', '/api/memory/global/versions/0'],
      ['GET', `/api/bots/${botId}/memory/versions/99999999999`],
    ] as const) {
      const bad = await call(method, url, payload);
      expect([method, url, bad.statusCode, errorOf(bad).code]).toEqual([method, url, 422, 'VALIDATION_FAILED']);
    }

    // Recursos que não existem.
    expect(errorOf(await call('GET', `/api/bots/${GHOST}/memory`)).code).toBe('BOT_NOT_FOUND');
    expect(errorOf(await call('PUT', `/api/bots/${GHOST}/memory`, { content: 'x', expectedVersion: 0 })).code).toBe('BOT_NOT_FOUND');
    expect(errorOf(await call('GET', `/api/bots/${GHOST}/memory/versions`)).code).toBe('BOT_NOT_FOUND');
    expect(errorOf(await call('POST', `/api/bots/${botId}/memory/undo`, { cardId: '987654321' })).code).toBe('NOT_FOUND');
    // Nada disso alterou a memória.
    expect(json<MemoryBody>(await call('GET', `/api/bots/${botId}/memory`))).toMatchObject({ content: '', version: 0 });
    expect(json<MemoryBody>(await call('GET', '/api/memory/global'))).toMatchObject({ content: '', version: 0, limit: 8000 });
  });
});

describe('o dono salva, vê o histórico e restaura', () => {
  it('salvar cria versão, o limite e o conflito têm código e mensagem do contrato, e restaurar cria uma versão nova', async () => {
    const botId = await createBot();
    const base = `/api/bots/${botId}/memory`;

    const saved = await call('PUT', base, { content: 'Preferência: respostas curtas.', expectedVersion: 0 });
    expect(saved.statusCode).toBe(200);
    expect(json<MemoryBody>(saved)).toMatchObject({ content: 'Preferência: respostas curtas.', version: 1, limit: 8000, updatedBy: 'owner' });
    expect(json<MemoryBody>(await call('PUT', base, { content: 'Preferência: respostas longas.', expectedVersion: 1 })).version).toBe(2);

    // Conflito: versão esperada velha (409), com a mensagem do contrato; a memória não muda.
    const conflict = await call('PUT', base, { content: 'de quem estava desatualizado', expectedVersion: 1 });
    expect([conflict.statusCode, errorOf(conflict).code]).toEqual([409, 'MEMORY_CONFLICT']);
    expect(errorOf(conflict).message).toBe('A memória mudou enquanto você editava. Recarregue para ver a versão atual.');
    // Limite: 8.001 caracteres são recusados (422) com a mensagem do contrato; 8.000 passam.
    const tooLarge = await call('PUT', base, { content: 'x'.repeat(8001), expectedVersion: 2 });
    expect([tooLarge.statusCode, errorOf(tooLarge).code]).toEqual([422, 'MEMORY_TOO_LARGE']);
    expect(errorOf(tooLarge).message).toBe('A memória passou de 8.000 caracteres.');
    expect(json<MemoryBody>(await call('GET', base))).toMatchObject({ content: 'Preferência: respostas longas.', version: 2 });
    expect((await call('PUT', base, { content: 'x'.repeat(8000), expectedVersion: 2 })).statusCode).toBe(200);

    // Histórico e detalhe com diff.
    const history = json<{ versions: { version: number; author: string; added: number; removed: number; restoredFrom: number | null }[] }>(await call('GET', `${base}/versions`));
    expect(history.versions.map((item) => [item.version, item.author])).toEqual([[3, 'owner'], [2, 'owner'], [1, 'owner']]);
    const detail = json<{ version: number; content: string; diff: { kind: string; text: string }[] }>(await call('GET', `${base}/versions/2`));
    expect(detail).toMatchObject({ version: 2, content: 'Preferência: respostas longas.' });
    expect(detail.diff).toEqual([
      { kind: 'remove', text: 'Preferência: respostas curtas.' },
      { kind: 'add', text: 'Preferência: respostas longas.' },
    ]);
    const missing = await call('GET', `${base}/versions/50`);
    expect([missing.statusCode, errorOf(missing).code]).toEqual([404, 'MEMORY_VERSION_NOT_FOUND']);

    // Restaurar a versão 1 cria a versão 4; versão esperada velha é conflito; versão inexistente é 404.
    const restored = await call('POST', `${base}/restore`, { version: 1, expectedVersion: 3 });
    expect(json<MemoryBody>(restored)).toMatchObject({ content: 'Preferência: respostas curtas.', version: 4 });
    expect(errorOf(await call('POST', `${base}/restore`, { version: 1, expectedVersion: 3 })).code).toBe('MEMORY_CONFLICT');
    expect(errorOf(await call('POST', `${base}/restore`, { version: 40, expectedVersion: 4 })).code).toBe('MEMORY_VERSION_NOT_FOUND');
  });

  it('a memória global tem as mesmas rotas e não se mistura com a dos bots', async () => {
    const saved = await call('PUT', '/api/memory/global', { content: 'Fuso: Brasília.', expectedVersion: 0 });
    expect(json<MemoryBody>(saved)).toMatchObject({ content: 'Fuso: Brasília.', version: 1 });
    expect(errorOf(await call('PUT', '/api/memory/global', { content: 'outra', expectedVersion: 0 })).code).toBe('MEMORY_CONFLICT');
    expect(json<{ versions: unknown[] }>(await call('GET', '/api/memory/global/versions')).versions).toHaveLength(1);
    expect(json<{ content: string }>(await call('GET', `/api/bots/${await createBot()}/memory`)).content).toBe('');
  });
});

describe('o bot edita a própria memória e o dono desfaz pelo cartão', () => {
  it('a edição chega como cartão na conversa com o diff, o desfazer restaura como versão do dono e o cartão de outro bot é recusado', async () => {
    const botId = await createBot();
    const otherId = await createBot();
    await call('PUT', `/api/bots/${botId}/memory`, { content: 'Linha antiga.', expectedVersion: 0 });

    const sent = await call('POST', `/api/bots/${botId}/messages`, { content: '[memoria:Linha nova do bot.] anote' });
    expect(sent.statusCode).toBe(201);
    interface Item {
      id: string;
      kind: string;
      card?: { type: string; version?: number; previousVersion?: number; status?: string; added?: number; preview?: { kind: string; text: string }[] };
    }
    const card = await waitFor('cartão Memória atualizada', async () => {
      const snapshot = json<{ items: Item[] }>(await call('GET', `/api/bots/${botId}/conversation`));
      return snapshot.items.find((item) => item.card?.type === 'memory_updated') ?? null;
    });
    expect(card.card).toMatchObject({ version: 2, previousVersion: 1, status: 'applied', added: 1, preview: [{ kind: 'add', text: 'Linha nova do bot.' }] });
    expect(json<MemoryBody>(await call('GET', `/api/bots/${botId}/memory`))).toMatchObject({ content: 'Linha antiga.\nLinha nova do bot.', version: 2, updatedBy: 'bot' });

    // IDOR: o cartão de um bot não desfaz nada em outro.
    expect(errorOf(await call('POST', `/api/bots/${otherId}/memory/undo`, { cardId: card.id })).code).toBe('NOT_FOUND');
    expect(json<MemoryBody>(await call('GET', `/api/bots/${otherId}/memory`))).toMatchObject({ content: '', version: 0 });

    const undone = await call('POST', `/api/bots/${botId}/memory/undo`, { cardId: card.id });
    expect(json<MemoryBody>(undone)).toMatchObject({ content: 'Linha antiga.', version: 3, updatedBy: 'owner' });
    const after = json<{ items: Item[] }>(await call('GET', `/api/bots/${botId}/conversation`));
    expect(after.items.find((item) => item.card?.type === 'memory_updated')?.card?.status).toBe('undone');
    // Memória mudada depois: o cartão antigo não desfaz mais (409 MEMORY_CONFLICT) e nada é apagado.
    await call('PUT', `/api/bots/${botId}/memory`, { content: 'Editada de novo.', expectedVersion: 3 });
    await call('POST', `/api/bots/${botId}/messages`, { content: '[memoria:Outra nota.] anote' });
    const second = await waitFor('segundo cartão', async () => {
      const snapshot = json<{ items: Item[] }>(await call('GET', `/api/bots/${botId}/conversation`));
      return snapshot.items.filter((item) => item.card?.type === 'memory_updated')[1] ?? null;
    });
    await call('PUT', `/api/bots/${botId}/memory`, { content: 'Mudou depois do bot.', expectedVersion: 5 });
    const stale = await call('POST', `/api/bots/${botId}/memory/undo`, { cardId: second.id });
    expect([stale.statusCode, errorOf(stale).code]).toEqual([409, 'MEMORY_CONFLICT']);
    expect(json<MemoryBody>(await call('GET', `/api/bots/${botId}/memory`)).content).toBe('Mudou depois do bot.');
  });
});
