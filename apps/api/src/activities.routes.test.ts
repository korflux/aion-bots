// Prova da tela Atividades pela borda HTTP (T11; A14; F15 e F7): sessão exigida, cursor validado na borda (formato e campos extras
// recusados), o contrato de resposta com uma pendência de aprovação e execuções reais (API real, motor real no mesmo processo e o
// provedor e o Composio falsos), a paginação por cursor e a parada com `runId` (a trava que impede parar a execução errada). A montagem
// da visão e a regra da trava estão provadas em @aion/core; aqui fica o que só a borda prova: sessão, validação e contrato.
import { ConnectorAccountService, RunEngine, createComposioClient, createOpenCodeGoClient } from '@aion/core';
import { startFakeUpstreams, type FakeUpstreams } from '@aion/core/testing';
import type { ActivitiesPage } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

const PROVIDER_KEY = 'valid-provider-key-ABCD';
const CONNECTOR_KEY = 'valid-connector-key-WXYZ';
const CLIENT_IP = '203.0.113.95';

let upstreams: FakeUpstreams;
let api: TestApi;
let engine: RunEngine;
let session: { cookie: string; csrfToken: string };

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  api = await createTestApi({ AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl, AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl });
  session = await api.login(CLIENT_IP);
  // O motor roda aqui no mesmo processo (em produção é o worker), sobre o mesmo banco e os mesmos servidores falsos.
  engine = new RunEngine({
    pool: api.pool,
    credentials: api.credentials,
    provider: createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, chatTimeoutMs: 15_000 }),
    models: api.models,
    connector: createComposioClient({ baseUrl: upstreams.composioBaseUrl }),
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
async function call(method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) {
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

async function createBot(): Promise<{ id: string; name: string }> {
  const created = await call('POST', '/api/bots', {
    name: `Bot ${Math.random().toString(36).slice(2, 8)}`,
    color: '#60A5FA',
    instructions: '',
    model: 'opencode/glm-5.1',
    effort: null,
    stepLimit: 25,
  });
  expect(created.statusCode).toBe(201);
  return json<{ id: string; name: string }>(created);
}

const activities = async (query = '') => json<ActivitiesPage>(await call('GET', `/api/activities${query}`));

/**
 * Libera ao bot a conta que ele usava antes de as contas serem liberadas por bot (a primeira ativa de cada app do Composio falso) pelo serviço de contas sobre o banco do teste, porque
 * o bot novo nasce sem nenhuma conta (A15, A16). Exige a chave do Composio já gravada.
 */
async function releaseConnectorAccounts(botId: string): Promise<void> {
  const accounts = new ConnectorAccountService({ pool: api.pool, source: api.credentials });
  for (const id of ['ca_1', 'ca_3']) {
    const view = await accounts.get(id);
    if (view.botIds.includes(botId)) continue;
    await accounts.release(id, { botIds: [...view.botIds, botId], expectedVersion: view.version }, { ip: CLIENT_IP, userAgent: CHROME_UA });
  }
}

/** Envia uma mensagem e devolve o id da execução criada. */
async function send(botId: string, content: string): Promise<string> {
  const sent = await call('POST', `/api/bots/${botId}/messages`, { content });
  expect(sent.statusCode).toBe(201);
  return json<{ id: string }>(sent).id;
}

const statusOf = async (botId: string, runId: string): Promise<string | undefined> => {
  const found = (await activities()).items.find((item) => item.bot?.id === botId && item.runId === runId);
  return found?.status;
};

describe('sessão e validação do cursor', () => {
  it('exige sessão e recusa cursor mal formado e campos extras na borda, sem tocar no banco', async () => {
    const anonymous = await api.app.inject({ method: 'GET', url: '/api/activities', headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
    expect([anonymous.statusCode, errorOf(anonymous).code]).toEqual([401, 'AUTH_SESSION_EXPIRED']);

    for (const query of ['?cursor=abc', '?cursor=-1', '?cursor=1.5', '?cursor=', `?cursor=${'9'.repeat(19)}`, '?cursor=1&cursor=2', '?limit=5', '?cursor=1&extra=1']) {
      const bad = await call('GET', `/api/activities${query}`);
      expect([query, bad.statusCode, errorOf(bad).code]).toEqual([query, 422, 'VALIDATION_FAILED']);
    }
    // Vazio (nenhuma execução ainda) é uma resposta válida, e o cursor bem formado aceita qualquer id.
    expect(await activities()).toEqual({ pending: [], items: [], nextCursor: null });
    expect(await activities('?cursor=999999999999999999')).toEqual({ pending: [], items: [], nextCursor: null });
  });
});

describe('contrato com execuções e uma pendência reais', () => {
  it('devolve a pendência e as execuções, e a parada com runId só atinge a execução que o dono viu', async () => {
    expect((await call('POST', '/api/credentials/provider', { key: PROVIDER_KEY })).statusCode).toBe(200);
    expect((await call('POST', '/api/credentials/connector', { key: CONNECTOR_KEY })).statusCode).toBe(200);
    const done = await createBot();
    const approving = await createBot();
    const doneRun = await send(done.id, 'oi');
    await waitFor('execução concluída', async () => (await statusOf(done.id, doneRun)) === 'completed');
    await releaseConnectorAccounts(approving.id);
    const waitingRun = await send(approving.id, '[gmail] envie o relatório');
    await waitFor('execução aguardando aprovação', async () => (await statusOf(approving.id, waitingRun)) === 'waiting_approval');

    const page = await activities();
    expect(page.items.map((item) => [item.runId, item.status, item.bot?.name])).toEqual([
      [waitingRun, 'waiting_approval', approving.name],
      [doneRun, 'completed', done.name],
    ]);
    expect(page.pending).toHaveLength(1);
    expect(page.pending[0]).toMatchObject({ runId: waitingRun, bot: { id: approving.id, archived: false }, actionLabel: 'Send Email · Gmail' });
    expect(page.pending[0]?.messageId).toMatch(/^\d+$/);
    expect(page.items[0]?.messageId).toBe(page.pending[0]?.messageId); // o clique da execução e o da pendência levam ao mesmo cartão
    expect(page.nextCursor).toBeNull();
    // Com cursor só vêm execuções: a pendência não se repete.
    expect((await activities(`?cursor=${waitingRun}`)).pending).toEqual([]);

    // Parar: runId malformado é recusado na borda; o de outra execução é RUN_NOT_ACTIVE e a execução em espera segue intocada.
    const malformed = await call('POST', `/api/bots/${approving.id}/runs/stop?runId=abc`);
    expect([malformed.statusCode, errorOf(malformed).code]).toEqual([422, 'VALIDATION_FAILED']);
    const extra = await call('POST', `/api/bots/${approving.id}/runs/stop?runId=${waitingRun}&x=1`);
    expect([extra.statusCode, errorOf(extra).code]).toEqual([422, 'VALIDATION_FAILED']);
    const stale = await call('POST', `/api/bots/${approving.id}/runs/stop?runId=${doneRun}`);
    expect([stale.statusCode, errorOf(stale).code]).toEqual([409, 'RUN_NOT_ACTIVE']);
    expect(await statusOf(approving.id, waitingRun)).toBe('waiting_approval');
    const noCsrf = await call('POST', `/api/bots/${approving.id}/runs/stop?runId=${waitingRun}`, undefined, { 'x-csrf-token': '' });
    expect([noCsrf.statusCode, errorOf(noCsrf).code]).toEqual([403, 'CSRF_TOKEN_INVALID']);

    const stopped = await call('POST', `/api/bots/${approving.id}/runs/stop?runId=${waitingRun}`);
    expect(stopped.statusCode).toBe(200);
    await waitFor('execução interrompida', async () => (await statusOf(approving.id, waitingRun)) === 'interrupted');
    expect((await activities()).pending).toEqual([]); // a aprovação foi cancelada junto com a execução
  });
});

describe('paginação pela borda', () => {
  it('50 por página e o nextCursor leva à página seguinte, sem repetir execuções', async () => {
    const bot = await createBot();
    const conversation = (await api.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
    await api.pool.query(
      `INSERT INTO runs (conversation_id, bot_id, status, input, created_at) SELECT $1, $2, 'completed', 'x', now() FROM generate_series(1, 60)`,
      [conversation, bot.id],
    );
    const first = await activities();
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBe(first.items.at(-1)?.runId);
    const second = await activities(`?cursor=${first.nextCursor}`);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((item) => item.runId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(62); // 60 do teste + as 2 execuções do teste anterior
  });
});
