// Prova da matriz de silenciar pela borda HTTP (T13; A13; F14 passo 4): sessão, Origin e CSRF em toda rota, o formato da matriz (bots ativos
// e o Chat geral), a alteração de UM tipo por vez com o estado final no corpo (idempotente), as validações de entrada (allowlist dos
// tipos, bot em formato de uuid, campos extras recusados) e o bot inexistente. A regra (quem entra na matriz, auditoria) está provada em
// @aion/core, e o efeito no ENVIO (o worker não manda o tipo silenciado), em `push-preferences.test.ts` do core.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

const CLIENT_IP = '203.0.113.99';
const GHOST = '00000000-0000-4000-8000-000000000000';

let api: TestApi;
let session: { cookie: string; csrfToken: string };

beforeAll(async () => {
  api = await createTestApi();
  session = await api.login(CLIENT_IP);
});

afterAll(async () => {
  await api.cleanup();
});

type Method = 'GET' | 'PUT' | 'POST';

/** Chamada autenticada por padrão (cookie, Origin e token CSRF). */
async function call(method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return api.app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'user-agent': CHROME_UA, ...headers },
    remoteAddress: CLIENT_IP,
  });
}

const json = <T = Record<string, unknown>>(response: { json: () => unknown }) => response.json() as T;
const errorOf = (response: { json: () => unknown }) => response.json() as { code: string; message: string; fields?: { field: string; reason: string }[] };

interface Target {
  botId: string | null;
  name: string;
  muted: string[];
}

async function createBot(name: string): Promise<{ id: string; name: string }> {
  const created = await call('POST', '/api/bots', { name, color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 25 });
  expect(created.statusCode).toBe(201);
  return json<{ id: string; name: string }>(created);
}

const matrix = async () => json<{ targets: Target[] }>(await call('GET', '/api/push/preferences')).targets;

describe('segurança da borda', () => {
  it('as duas rotas exigem sessão válida e a alteração exige também Origin e token CSRF', async () => {
    const body = { botId: null, kind: 'run_completed', muted: true };
    for (const [method, payload] of [['GET', undefined], ['PUT', body]] as const) {
      const anonymous = await api.app.inject({ method, url: '/api/push/preferences', payload, headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
      expect(anonymous.statusCode, `${method} sem sessão`).toBe(401);
      expect(errorOf(anonymous).code).toBe('AUTH_SESSION_EXPIRED');
    }
    expect(errorOf(await call('PUT', '/api/push/preferences', body, { origin: 'https://outro.exemplo' })).code).toBe('CSRF_ORIGIN_INVALID');
    expect(errorOf(await call('PUT', '/api/push/preferences', body, { 'x-csrf-token': 'invalido' })).code).toBe('CSRF_TOKEN_INVALID');
    expect((await matrix()).find((target) => target.botId === null)?.muted).toEqual([]); // nenhuma das recusadas gravou
  });
});

describe('a matriz', () => {
  it('lista o bot e o Chat geral, silencia um tipo por vez, repetir é idempotente e voltar a receber desfaz', async () => {
    const bot = await createBot('Bot da matriz');
    const fresh = await matrix();
    expect(fresh.find((target) => target.botId === bot.id)).toEqual({ botId: bot.id, name: 'Bot da matriz', muted: [] });
    expect(fresh.at(-1)).toEqual({ botId: null, name: 'Chat geral', muted: [] });

    const silenced = await call('PUT', '/api/push/preferences', { botId: bot.id, kind: 'approval_pending', muted: true });
    expect(silenced.statusCode).toBe(200);
    expect(json(silenced)).toEqual({ botId: bot.id, name: 'Bot da matriz', muted: ['approval_pending'] });
    expect(json(await call('PUT', '/api/push/preferences', { botId: bot.id, kind: 'approval_pending', muted: true }))).toMatchObject({ muted: ['approval_pending'] });
    expect(json(await call('PUT', '/api/push/preferences', { botId: bot.id, kind: 'run_failed', muted: true }))).toMatchObject({ muted: ['run_failed', 'approval_pending'] });
    expect(json(await call('PUT', '/api/push/preferences', { botId: null, kind: 'run_completed', muted: true }))).toEqual({ botId: null, name: 'Chat geral', muted: ['run_completed'] });

    const afterSilencing = await matrix();
    expect(afterSilencing.find((target) => target.botId === bot.id)?.muted).toEqual(['run_failed', 'approval_pending']);
    expect(afterSilencing.at(-1)?.muted).toEqual(['run_completed']);

    await call('PUT', '/api/push/preferences', { botId: bot.id, kind: 'approval_pending', muted: false });
    await call('PUT', '/api/push/preferences', { botId: bot.id, kind: 'run_failed', muted: false });
    await call('PUT', '/api/push/preferences', { botId: null, kind: 'run_completed', muted: false });
    const restored = await matrix();
    expect(restored.find((target) => target.botId === bot.id)?.muted).toEqual([]);
    expect(restored.at(-1)?.muted).toEqual([]);
  });

  it('um bot arquivado sai da matriz', async () => {
    const bot = await createBot('Bot que sai');
    expect((await matrix()).some((target) => target.botId === bot.id)).toBe(true);
    expect((await call('POST', `/api/bots/${bot.id}/archive`)).statusCode).toBe(200);
    expect((await matrix()).some((target) => target.botId === bot.id)).toBe(false);
  });

  it('recusa tipo fora da allowlist, bot fora do formato, estado que não é booleano, campos faltando ou extras', async () => {
    const bad: unknown[] = [
      {},
      { botId: null, kind: 'run_completed' },
      { kind: 'run_completed', muted: true },
      { botId: null, kind: 'qualquer_coisa', muted: true },
      { botId: 'nao-e-uuid', kind: 'run_completed', muted: true },
      { botId: null, kind: 'run_completed', muted: 'sim' },
      { botId: null, kind: 'run_completed', muted: true, extra: 1 },
    ];
    for (const payload of bad) {
      const response = await call('PUT', '/api/push/preferences', payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
      expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    }
    const missing = await call('PUT', '/api/push/preferences', { botId: GHOST, kind: 'run_completed', muted: true });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('BOT_NOT_FOUND');
  });
});
