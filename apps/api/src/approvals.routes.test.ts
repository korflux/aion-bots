import { TABLE_ACTIONS } from '@aion/core';
import { DOC_ACTIONS } from '@aion/shared';
// Prova das aprovações pela borda HTTP (T7; A8, C2 e C4; F9 e F10): sessão, CSRF e allowlist em todas as rotas, o fluxo de ponta
// a ponta (API real, motor de execução real no mesmo processo e Composio e provedor falsos) de pedir, responder e retomar, as
// regras global e do bot, os erros do contrato e a prova de que nenhuma chave sai do servidor. A regra de negócio está provada
// em @aion/core; aqui fica o que só a borda prova: contrato, segurança e os códigos de erro.
import { ConnectorAccountService, RunEngine, createComposioClient, createOpenCodeGoClient } from '@aion/core';
import { startFakeUpstreams, type FakeUpstreams } from '@aion/core/testing';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalRoutes } from './routes/approvals';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

const PROVIDER_KEY = 'valid-provider-key-ABCD';
const CONNECTOR_KEY = 'valid-connector-key-WXYZ';
const CLIENT_IP = '203.0.113.92';

let upstreams: FakeUpstreams;
let api: TestApi;
let engine: RunEngine;
let session: { cookie: string; csrfToken: string };
/** Corpo e cabeçalhos de toda resposta: no fim se prova que as chaves nunca saíram do servidor. */
const seen: string[] = [];

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
async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
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
const errorOf = (response: { json: () => unknown }) => response.json() as { code: string; message: string; fields?: unknown };

async function waitFor<T>(description: string, probe: () => Promise<T | null | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`prazo estourado esperando: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface Card {
  id: string;
  kind: string;
  card?: { type: string; approvalId?: string; status?: string; decision?: string | null; action?: string; actionLabel?: string; appName?: string; params?: unknown[] };
}
interface Snapshot {
  items: Card[];
  runs: { id: string; status: string }[];
}
const snapshotOf = async (botId: string) => json<Snapshot>(await call('GET', `/api/bots/${botId}/conversation`));
const pendingCount = async () => json<{ count: number }>(await call('GET', '/api/approvals/pending-count')).count;

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

/**
 * Libera ao bot a conta que ele usava antes de as contas serem liberadas por bot (a primeira ativa de cada app do Composio falso) pelo serviço de contas sobre o banco do teste, porque
 * o bot novo nasce sem nenhuma conta (A15, A16). Idempotente; exige a chave do Composio já gravada.
 */
async function releaseConnectorAccounts(botId: string): Promise<void> {
  const accounts = new ConnectorAccountService({ pool: api.pool, source: api.credentials });
  for (const id of ['ca_1', 'ca_3']) {
    const view = await accounts.get(id);
    if (view.botIds.includes(botId)) continue;
    await accounts.release(id, { botIds: [...view.botIds, botId], expectedVersion: view.version }, { ip: CLIENT_IP, userAgent: CHROME_UA });
  }
}

/** Envia a mensagem e espera o cartão de aprovação pendente aparecer na conversa. */
async function askAndWaitForCard(botId: string, text: string) {
  await releaseConnectorAccounts(botId);
  const sent = await call('POST', `/api/bots/${botId}/messages`, { content: text });
  expect(sent.statusCode).toBe(201);
  const runId = json<{ id: string }>(sent).id;
  const card = await waitFor('cartão de aprovação pendente', async () => {
    const found = (await snapshotOf(botId)).items.find((item) => item.card?.type === 'approval');
    return found?.card?.status === 'pending' ? found : null;
  });
  return { runId, card: card.card as NonNullable<Card['card']> };
}

describe('segurança e contrato', () => {
  it('toda rota exige sessão; as que alteram estado exigem Origin e token CSRF; ids, valores e campos extras são recusados na borda', async () => {
    expect((await call('POST', '/api/credentials/provider', { key: PROVIDER_KEY })).statusCode).toBe(200);
    expect((await call('POST', '/api/credentials/connector', { key: CONNECTOR_KEY })).statusCode).toBe(200);
    const botId = await createBot();
    const routes: ['GET' | 'POST' | 'PUT' | 'DELETE', string, unknown?][] = [
      ['GET', '/api/approvals/pending-count'],
      ['POST', '/api/approvals/1/respond', { decision: 'allow_once' }],
      ['GET', '/api/approval-rules'],
      ['PUT', '/api/approval-rules/GMAIL_SEND_EMAIL', { value: 'allow' }],
      ['GET', `/api/bots/${botId}/approval-rules`],
      ['PUT', `/api/bots/${botId}/approval-rules/GMAIL_SEND_EMAIL`, { value: 'allow' }],
      ['DELETE', `/api/bots/${botId}/approval-rules/GMAIL_SEND_EMAIL`],
      // Lotes "tudo" (F12): as mesmas garantias das rotas de uma ação.
      ['PUT', '/api/approval-rules', { value: 'allow' }],
      ['PUT', `/api/bots/${botId}/approval-rules`, { value: 'allow' }],
      ['DELETE', `/api/bots/${botId}/approval-rules`],
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

    // Validação na borda: id da aprovação só com dígitos, decisão e valores só os permitidos, nada além do declarado.
    for (const [method, url, payload] of [
      ['POST', '/api/approvals/abc/respond', { decision: 'allow_once' }],
      ['POST', '/api/approvals/1/respond', { decision: 'sempre' }],
      ['POST', '/api/approvals/1/respond', { decision: 'allow_once', extra: true }],
      ['POST', '/api/approvals/1/respond', {}],
      ['PUT', '/api/approval-rules/GMAIL_SEND_EMAIL', { value: 'permitir' }],
      ['PUT', '/api/approval-rules/GMAIL_SEND_EMAIL', { value: 'allow', extra: 1 }],
      ['PUT', '/api/approval-rules/a%20b', { value: 'allow' }],
      ['PUT', `/api/approval-rules/${'A'.repeat(129)}`, { value: 'allow' }],
      ['PUT', `/api/bots/${botId}/approval-rules/GMAIL_SEND_EMAIL`, { value: 'neutral' }], // o bot não tem "neutro": remover é o que devolve ao global
      ['PUT', '/api/bots/nao-e-uuid/approval-rules/GMAIL_SEND_EMAIL', { value: 'allow' }],
      ['DELETE', `/api/bots/${botId}/approval-rules/a%20b`],
      ['PUT', '/api/approval-rules', { value: 'permitir' }],
      ['PUT', '/api/approval-rules', {}],
      ['PUT', '/api/approval-rules', { value: 'allow', extra: 1 }],
      ['PUT', `/api/bots/${botId}/approval-rules`, { value: 'neutral' }], // "Neutro tudo" do bot é o DELETE
      ['PUT', '/api/bots/nao-e-uuid/approval-rules', { value: 'allow' }],
      ['DELETE', '/api/bots/nao-e-uuid/approval-rules'],
    ] as const) {
      const bad = await call(method, url, payload);
      expect([method, url, bad.statusCode, errorOf(bad).code]).toEqual([method, url, 422, 'VALIDATION_FAILED']);
    }

    // Recursos que não existem: aprovação, ação nunca vista e bot.
    expect(errorOf(await call('POST', '/api/approvals/987654321/respond', { decision: 'allow_once' })).code).toBe('NOT_FOUND');
    expect(errorOf(await call('PUT', '/api/approval-rules/NUNCA_VISTA', { value: 'allow' })).code).toBe('NOT_FOUND');
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect(errorOf(await call('GET', `/api/bots/${ghost}/approval-rules`)).code).toBe('BOT_NOT_FOUND');
    expect(errorOf(await call('PUT', `/api/bots/${ghost}/approval-rules/GMAIL_SEND_EMAIL`, { value: 'allow' })).code).toBe('BOT_NOT_FOUND');
    expect(errorOf(await call('PUT', `/api/bots/${ghost}/approval-rules`, { value: 'allow' })).code).toBe('BOT_NOT_FOUND');
    expect(errorOf(await call('DELETE', `/api/bots/${ghost}/approval-rules`)).code).toBe('BOT_NOT_FOUND');
    expect(await pendingCount()).toBe(0);
    // Nenhuma ação foi usada, mas a tela já lista as do catálogo dos apps conectados (T25): são três no Composio falso, mais as quatro de tabelas e a exclusão de doc (phase 14), que são locais.
    expect(json<{ actions: unknown[] }>(await call('GET', '/api/approval-rules')).actions).toHaveLength(8);
  });
});

describe('a tela Aprovações lista o catálogo antes do primeiro uso (T25)', () => {
  type Listed = { actions: { action: string; label: string; appName: string; globalRule: string; botRules: unknown[] }[] };

  it('as ações dos apps conectados aparecem com a regra neutra e a regra já pode ser definida antes de qualquer uso', async () => {
    const listed = json<Listed>(await call('GET', '/api/approval-rules'));
    expect(listed.actions.map((action) => [action.appName, action.action, action.globalRule])).toEqual([
      // A exclusão de doc (phase 14, A14) é do catálogo local, como as de tabela: a regra dela pode ser definida antes do primeiro uso. "Docs do Aion" abre a lista (ordem por app).
      ...Object.values(DOC_ACTIONS).map((action) => [action.appName, action.slug, 'neutral']),
      ['GitHub', 'GITHUB_CREATE_ISSUE', 'neutral'],
      ['Gmail', 'GMAIL_FETCH_EMAILS', 'neutral'],
      ['Gmail', 'GMAIL_SEND_EMAIL', 'neutral'],
      ...Object.values(TABLE_ACTIONS).sort((a,b) => a.label.localeCompare(b.label)).map((action) => [action.appName, action.slug, 'neutral']),
    ]);
    expect(listed.actions[3]).toMatchObject({ label: 'Send Email · Gmail', botRules: [] });
    expect(await pendingCount()).toBe(0); // nenhum bot usou nada: o catálogo vem do Composio, não de um uso

    // Definir a regra antes do primeiro uso funciona, e abrir a tela de novo (novo registro do catálogo) não a desfaz.
    const denied = await call('PUT', '/api/approval-rules/GITHUB_CREATE_ISSUE', { value: 'deny' });
    expect(denied.statusCode).toBe(200);
    expect(json<Listed>(denied).actions.find((action) => action.action === 'GITHUB_CREATE_ISSUE')?.globalRule).toBe('deny');
    const reopened = json<Listed>(await call('GET', '/api/approval-rules'));
    expect(reopened.actions.find((action) => action.action === 'GITHUB_CREATE_ISSUE')?.globalRule).toBe('deny');
    await call('PUT', '/api/approval-rules/GITHUB_CREATE_ISSUE', { value: 'neutral' }); // os testes seguintes partem do neutro
  });

  it('o catálogo que falha não derruba a tela: ela lista o que já está registrado e o erro vai ao log', async () => {
    const lines: string[] = [];
    const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => void lines.push(line) } } });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const registered = { actions: [{ action: 'GMAIL_SEND_EMAIL', label: 'Send Email · Gmail', appSlug: 'gmail', appName: 'Gmail', globalRule: 'allow', botRules: [] }] };
    await app.register(approvalRoutes, {
      approvals: { listRules: async () => registered, registerCatalog: async () => undefined } as never,
      toolCatalog: async () => {
        throw new Error('composio fora do ar');
      },
    });
    const response = await app.inject({ method: 'GET', url: '/approval-rules' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(registered);
    expect(lines.join('')).toContain('catálogo de ações indisponível');
    await app.close();
  });
});

describe('o fluxo de aprovação de ponta a ponta', () => {
  it('o cartão chega pendente com o badge, permitir uma vez retoma a execução, repetir é inofensivo e a regra global passa a valer', async () => {
    const botId = await createBot();
    const before = upstreams.requests.filter((request) => request.path.includes('/tools/execute/')).length;
    const { runId, card } = await askAndWaitForCard(botId, '[gmail] envie o relatório');
    expect(card).toMatchObject({
      type: 'approval',
      status: 'pending',
      decision: null,
      action: 'GMAIL_SEND_EMAIL',
      actionLabel: 'Send Email · Gmail',
      appName: 'Gmail',
      params: [
        { name: 'to', value: 'dono@example.com' },
        { name: 'subject', value: 'Relatório' },
        { name: 'body', value: 'Olá, segue o relatório.' },
      ],
      omitted: { count: 0, names: [] }, // o contrato HTTP leva o aviso dos parâmetros omitidos (R2)
    });
    expect(await pendingCount()).toBe(1); // o número do badge
    expect((await snapshotOf(botId)).runs).toMatchObject([{ id: runId, status: 'waiting_approval' }]);

    const answered = await call('POST', `/api/approvals/${card.approvalId}/respond`, { decision: 'allow_once' });
    expect(answered.statusCode).toBe(200);
    expect(json(answered)).toEqual({ id: card.approvalId, status: 'approved', decision: 'allow_once' });
    // Idempotente: a mesma decisão repetida responde 200 com o mesmo resultado, agora marcado como já aplicada antes deste pedido (a tela ignora o campo).
    expect(json(await call('POST', `/api/approvals/${card.approvalId}/respond`, { decision: 'allow_once' }))).toEqual({ ...json(answered), alreadyApplied: true });
    const conflicting = await call('POST', `/api/approvals/${card.approvalId}/respond`, { decision: 'deny' });
    expect([conflicting.statusCode, errorOf(conflicting).code]).toEqual([409, 'APPROVAL_NOT_PENDING']);
    expect(errorOf(conflicting).message).toBe('Esta aprovação já foi respondida.');

    // A execução retoma e o cartão da conversa mostra a decisão; a ação executou uma única vez, na conta do Gmail.
    await waitFor('execução concluída', async () => ((await snapshotOf(botId)).runs.length === 0 ? true : null));
    const done = (await snapshotOf(botId)).items.find((item) => item.card?.type === 'approval');
    expect(done?.card).toMatchObject({ status: 'approved', decision: 'allow_once' });
    const executions = upstreams.requests.filter((request) => request.path.includes('/tools/execute/')).slice(before);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.body).toMatchObject({ connected_account_id: 'ca_1' });
    expect(await pendingCount()).toBe(0);

    // Tela Aprovações: a ação passou a constar como vista, com a regra global neutra; alterá-la vale na próxima chamada.
    const listed = json<{ actions: { action: string; globalRule: string; label: string; appName: string; botRules: unknown[] }[] }>(await call('GET', '/api/approval-rules'));
    expect(listed.actions.find((action) => action.action === 'GMAIL_SEND_EMAIL')).toMatchObject({ globalRule: 'neutral', label: 'Send Email · Gmail', appName: 'Gmail', botRules: [] });
    const allowed = await call('PUT', '/api/approval-rules/GMAIL_SEND_EMAIL', { value: 'allow' });
    expect(allowed.statusCode).toBe(200);
    expect(json<typeof listed>(allowed).actions.find((action) => action.action === 'GMAIL_SEND_EMAIL')?.globalRule).toBe('allow');
    await call('POST', `/api/bots/${botId}/messages`, { content: '[gmail] de novo' });
    await waitFor('segunda execução concluída sem perguntar', async () => {
      const state = await snapshotOf(botId);
      return state.runs.length === 0 && state.items.filter((item) => item.kind === 'text').length >= 4 ? true : null;
    });
    expect(await pendingCount()).toBe(0);
    expect(upstreams.requests.filter((request) => request.path.includes('/tools/execute/')).slice(before)).toHaveLength(2);
  });

  it('sempre permitir e negar sempre gravam a regra no bot; a seção do editor lista, altera e remove; o global volta a valer ao remover', async () => {
    await call('PUT', '/api/approval-rules/GMAIL_SEND_EMAIL', { value: 'neutral' });
    const botId = await createBot();
    const { card } = await askAndWaitForCard(botId, '[gmail] sempre');
    const answered = await call('POST', `/api/approvals/${card.approvalId}/respond`, { decision: 'allow_always' });
    expect(json(answered)).toEqual({ id: card.approvalId, status: 'approved', decision: 'allow_always' });
    await waitFor('execução concluída', async () => ((await snapshotOf(botId)).runs.length === 0 ? true : null));

    const rules = await call('GET', `/api/bots/${botId}/approval-rules`);
    expect(json(rules)).toEqual({ rules: [{ action: 'GMAIL_SEND_EMAIL', label: 'Send Email · Gmail', appName: 'Gmail', value: 'allow' }] });
    const changed = await call('PUT', `/api/bots/${botId}/approval-rules/GMAIL_SEND_EMAIL`, { value: 'ask' });
    expect(json(changed)).toMatchObject({ rules: [{ action: 'GMAIL_SEND_EMAIL', value: 'ask' }] });
    // A tela Aprovações indica os bots com regra própria.
    const global = json<{ actions: { action: string; botRules: { botId: string; value: string }[] }[] }>(await call('GET', '/api/approval-rules'));
    expect(global.actions.find((action) => action.action === 'GMAIL_SEND_EMAIL')?.botRules).toMatchObject([{ botId, value: 'ask' }]);
    expect(json(await call('DELETE', `/api/bots/${botId}/approval-rules/GMAIL_SEND_EMAIL`))).toEqual({ rules: [] });
    expect(json(await call('DELETE', `/api/bots/${botId}/approval-rules/GMAIL_SEND_EMAIL`))).toEqual({ rules: [] }); // idempotente
    // O serviço auditou as alterações de regra (quem, o quê, quando e de onde), sem segredos.
    const audit = await api.pool.query<{ action: string; actor: string; ip: string | null; details: Record<string, unknown> }>(
      "SELECT action, actor, ip, details FROM audit_log WHERE action = 'approval.rule' ORDER BY id",
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(4);
    expect(audit.rows.every((row) => row.actor === 'owner' && row.ip === CLIENT_IP)).toBe(true);
    expect(audit.rows.map((row) => row.details.value)).toEqual(expect.arrayContaining(['allow', 'ask', 'removed', 'neutral']));
  });

  it('"tudo" (F12): a regra vale para todas as ações conhecidas (o catálogo é registrado antes), "Neutro tudo" remove só as regras do bot, e cada lote fica auditado', async () => {
    const botId = await createBot();
    const otherId = await createBot();
    type Listed = { actions: { action: string; globalRule: string; botRules: { botId: string; value: string }[] }[] };
    await call('GET', '/api/approval-rules'); // garante o catálogo registrado antes de apagar uma ação dele
    expect((await call('PUT', `/api/bots/${otherId}/approval-rules/GMAIL_SEND_EMAIL`, { value: 'deny' })).statusCode).toBe(200);
    // Uma ação do catálogo que nenhuma tela chegou a listar: o lote precisa cobri-la mesmo assim.
    await api.pool.query("DELETE FROM approval_actions WHERE slug = 'GMAIL_FETCH_EMAILS'");

    // Lote do bot: a lista dele estava vazia, e agora traz TODAS as ações (inclusive a que foi registrada na hora).
    const asked = await call('PUT', `/api/bots/${botId}/approval-rules`, { value: 'ask' });
    expect(asked.statusCode).toBe(200);
    expect(json<{ rules: { action: string; value: string }[] }>(asked).rules.map((rule) => `${rule.action}:${rule.value}`).sort()).toEqual([
      'GITHUB_CREATE_ISSUE:ask',
      'GMAIL_FETCH_EMAILS:ask',
      'GMAIL_SEND_EMAIL:ask',
      ...[...Object.values(DOC_ACTIONS), ...Object.values(TABLE_ACTIONS)].map((action) => action.slug + ':ask').sort(),
    ]);

    // Lote global: todas as ações com a mesma regra; a tela mostra os bots com regra própria (nome e cor desenham o avatar, sem personagem).
    const denied = json<Listed>(await call('PUT', '/api/approval-rules', { value: 'deny' }));
    expect(denied.actions.map((action) => action.globalRule)).toEqual(Array(8).fill('deny'));
    const byBot = <T extends { botId: string }>(rules: T[]) => [...rules].sort((a, b) => a.botId.localeCompare(b.botId)); // a tela ordena pelo nome do bot, que o teste sorteia
    expect(byBot(denied.actions.find((action) => action.action === 'GMAIL_SEND_EMAIL')?.botRules ?? [])).toMatchObject(
      byBot([
        { botId, value: 'ask' },
        { botId: otherId, value: 'deny' },
      ]),
    );

    // "Neutro tudo" do bot: remove as regras dele (e só as dele) e devolve a lista vazia; repetir é inofensivo.
    expect(json(await call('DELETE', `/api/bots/${botId}/approval-rules`))).toEqual({ rules: [] });
    expect(json(await call('DELETE', `/api/bots/${botId}/approval-rules`))).toEqual({ rules: [] });
    expect(json<{ rules: unknown[] }>(await call('GET', `/api/bots/${otherId}/approval-rules`)).rules).toHaveLength(1);
    await call('DELETE', `/api/bots/${otherId}/approval-rules/GMAIL_SEND_EMAIL`);
    expect((await call('PUT', '/api/approval-rules', { value: 'neutral' })).statusCode).toBe(200); // os testes seguintes partem do neutro

    // Cada lote deixou UMA auditoria com o escopo, o valor e a contagem (sem segredo), do dono e do IP da chamada; o repetido não audita.
    const audit = await api.pool.query<{ actor: string; ip: string | null; details: Record<string, unknown> }>(
      "SELECT actor, ip, details FROM audit_log WHERE action = 'approval.rule' AND target = 'all' ORDER BY id",
    );
    expect(audit.rows.map((row) => row.details)).toEqual([
      { scope: 'bot', value: 'ask', bot: botId, count: 8 },
      { scope: 'global', value: 'deny', count: 8 },
      { scope: 'bot', value: 'removed', bot: botId, count: 8 },
      { scope: 'global', value: 'neutral', count: 8 },
    ]);
    expect(audit.rows.every((row) => row.actor === 'owner' && row.ip === CLIENT_IP)).toBe(true);
  });

  it('depois das 24 horas a resposta é recusada com APPROVAL_EXPIRED e a execução fica expirada', async () => {
    const botId = await createBot();
    const { runId, card } = await askAndWaitForCard(botId, '[gmail] vai expirar');
    await api.pool.query("UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE id = $1", [card.approvalId]);
    const late = await call('POST', `/api/approvals/${card.approvalId}/respond`, { decision: 'allow_once' });
    expect([late.statusCode, errorOf(late).code, errorOf(late).message]).toEqual([410, 'APPROVAL_EXPIRED', 'Esta aprovação expirou.']);
    const run = await api.pool.query<{ status: string }>('SELECT status FROM runs WHERE id = $1', [runId]);
    expect(run.rows[0]?.status).toBe('expired');
    expect(await pendingCount()).toBe(0);
  });
});

// Resposta pela notificação (phase 16, passo 6; SEC-07; A6, A7, A8, A9 na parte da borda): o service worker chama a MESMA rota da tela com o cookie, a Origin e o CSRF de
// GET /api/auth/session, e `source: 'notification'` (allowlist) vai à auditoria. Da notificação só valem `allow_once` e `deny`; sem sessão ou sem CSRF nada é gravado.
describe('resposta pela notificação (phase 16)', () => {
  const auditOf = async (approvalId: string) =>
    (await api.pool.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'approval.respond' AND details->>'approval' = $1 ORDER BY id", [approvalId])).rows.map((row) => row.details);
  const statusOf = async (approvalId: string) => (await api.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [approvalId])).rows[0]!.status;
  const idle = (botId: string) => waitFor('execução concluída', async () => ((await snapshotOf(botId)).runs.length === 0 ? true : null));

  it('A6: permitir uma vez e negar pela notificação retomam a execução como na tela, e a auditoria leva `source: notification`', async () => {
    const botId = await createBot();
    const { card } = await askAndWaitForCard(botId, '[gmail] pela notificação');
    const answered = await call('POST', `/api/approvals/${card.approvalId}/respond`, { decision: 'allow_once', source: 'notification' });
    expect(answered.statusCode).toBe(200);
    expect(json(answered)).toEqual({ id: card.approvalId, status: 'approved', decision: 'allow_once' });
    await idle(botId);
    expect(await auditOf(card.approvalId as string)).toEqual([{ decision: 'allow_once', approval: card.approvalId, bot: botId, source: 'notification' }]);

    const secondBot = await createBot(); // o cartão é achado pelo primeiro da conversa, então cada pedido usa um bot novo
    const second = await askAndWaitForCard(secondBot, '[gmail] recusada pela notificação');
    const denied = await call('POST', `/api/approvals/${second.card.approvalId}/respond`, { decision: 'deny', source: 'notification' });
    expect(json(denied)).toEqual({ id: second.card.approvalId, status: 'denied', decision: 'deny' });
    expect((await auditOf(second.card.approvalId as string))[0]).toMatchObject({ decision: 'deny', source: 'notification' });
    await idle(secondBot);

    // Sem `source` a origem é a tela.
    const thirdBot = await createBot();
    const third = await askAndWaitForCard(thirdBot, '[gmail] pela tela');
    await call('POST', `/api/approvals/${third.card.approvalId}/respond`, { decision: 'deny' });
    expect((await auditOf(third.card.approvalId as string))[0]).toMatchObject({ source: 'screen' });
    await idle(thirdBot);
  });

  it('A9: `source` fora da allowlist e decisão permanente vinda da notificação são recusadas (422) e a aprovação segue pendente, sem regra gravada', async () => {
    const botId = await createBot();
    const { card } = await askAndWaitForCard(botId, '[gmail] recusas da borda');
    const rulesBefore = (await api.pool.query('SELECT count(*)::int AS n FROM bot_approval_rules')).rows[0].n;
    for (const body of [
      { decision: 'allow_once', source: 'email' },
      { decision: 'allow_once', source: '' },
      { decision: 'allow_once', source: null },
      { decision: 'allow_always', source: 'notification' },
      { decision: 'deny_always', source: 'notification' },
    ]) {
      const bad = await call('POST', `/api/approvals/${card.approvalId}/respond`, body);
      expect([JSON.stringify(body), bad.statusCode, errorOf(bad).code]).toEqual([JSON.stringify(body), 422, 'VALIDATION_FAILED']);
    }
    expect(await statusOf(card.approvalId as string)).toBe('pending');
    expect((await api.pool.query('SELECT count(*)::int AS n FROM bot_approval_rules')).rows[0].n).toBe(rulesBefore);
    expect(await auditOf(card.approvalId as string)).toEqual([]);
    // Sem sessão ou sem o token CSRF, nada é gravado (o service worker só chama com os dois).
    const anonymous = await api.app.inject({ method: 'POST', url: `/api/approvals/${card.approvalId}/respond`, payload: { decision: 'allow_once', source: 'notification' }, headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
    expect([anonymous.statusCode, errorOf(anonymous).code]).toEqual([401, 'AUTH_SESSION_EXPIRED']);
    const noCsrf = await call('POST', `/api/approvals/${card.approvalId}/respond`, { decision: 'allow_once', source: 'notification' }, { 'x-csrf-token': '' });
    expect([noCsrf.statusCode, errorOf(noCsrf).code]).toEqual([403, 'CSRF_TOKEN_INVALID']);
    expect(await statusOf(card.approvalId as string)).toBe('pending');
    expect(await auditOf(card.approvalId as string)).toEqual([]);
    // Fecha o pedido para não deixar execução pendurada.
    await call('POST', `/api/approvals/${card.approvalId}/respond`, { decision: 'deny' });
    await idle(botId);
  });

  it('A7: aprovação já decidida ou vencida devolve o código estável (que o service worker traduz em aviso) e nada é gravado', async () => {
    const botId = await createBot();
    const done = await askAndWaitForCard(botId, '[gmail] já decidida');
    await call('POST', `/api/approvals/${done.card.approvalId}/respond`, { decision: 'deny' });
    await idle(botId);
    const late = await call('POST', `/api/approvals/${done.card.approvalId}/respond`, { decision: 'allow_once', source: 'notification' });
    expect([late.statusCode, errorOf(late).code]).toEqual([409, 'APPROVAL_NOT_PENDING']);
    expect(await auditOf(done.card.approvalId as string)).toHaveLength(1);
    // A MESMA decisão repetida pela notificação segue idempotente (200), mas avisa que já estava aplicada, para o aparelho explicar em vez de fechar calado; nada novo é gravado.
    const same = await call('POST', `/api/approvals/${done.card.approvalId}/respond`, { decision: 'deny', source: 'notification' });
    expect([same.statusCode, json(same)]).toEqual([200, { id: done.card.approvalId, status: 'denied', decision: 'deny', alreadyApplied: true }]);
    expect(await auditOf(done.card.approvalId as string)).toHaveLength(1);

    const staleBot = await createBot();
    const stale = await askAndWaitForCard(staleBot, '[gmail] vai vencer');
    await api.pool.query("UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE id = $1", [stale.card.approvalId]);
    const expired = await call('POST', `/api/approvals/${stale.card.approvalId}/respond`, { decision: 'allow_once', source: 'notification' });
    expect(errorOf(expired).code).toBe('APPROVAL_EXPIRED');
    expect(await auditOf(stale.card.approvalId as string)).toEqual([]);
    expect(await statusOf(stale.card.approvalId as string)).not.toBe('approved');
    await idle(staleBot);
  });

  it('A8: duas respostas iguais ao mesmo tempo pela borda têm um efeito só (uma execução da ação, uma linha de auditoria); duas opostas, uma 200 e uma 409', async () => {
    const botId = await createBot();
    const executions = () => upstreams.requests.filter((request) => request.path.includes('/tools/execute/')).length;
    const before = executions();
    const same = await askAndWaitForCard(botId, '[gmail] duas iguais');
    const body = { decision: 'allow_once', source: 'notification' };
    const both = await Promise.all([call('POST', `/api/approvals/${same.card.approvalId}/respond`, body), call('POST', `/api/approvals/${same.card.approvalId}/respond`, body)]);
    expect(both.map((response) => response.statusCode)).toEqual([200, 200]);
    // Uma das duas aplicou a decisão; a outra encontrou a decisão já aplicada (mesmo resultado, marcado `alreadyApplied`).
    const bodies = both.map((response) => json<{ id: string; status: string; decision: string; alreadyApplied?: boolean }>(response));
    expect(bodies.filter((body) => body.alreadyApplied === true)).toHaveLength(1);
    for (const body of bodies) expect({ id: body.id, status: body.status, decision: body.decision }).toEqual({ id: same.card.approvalId, status: 'approved', decision: 'allow_once' });
    await idle(botId);
    expect(executions() - before).toBe(1);
    expect(await auditOf(same.card.approvalId as string)).toHaveLength(1);

    const oppositeBot = await createBot();
    const opposite = await askAndWaitForCard(oppositeBot, '[gmail] duas opostas');
    const race = await Promise.all([
      call('POST', `/api/approvals/${opposite.card.approvalId}/respond`, { decision: 'allow_once', source: 'notification' }),
      call('POST', `/api/approvals/${opposite.card.approvalId}/respond`, { decision: 'deny', source: 'notification' }),
    ]);
    expect(race.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await auditOf(opposite.card.approvalId as string)).toHaveLength(1);
    await idle(oppositeBot);
  });
});

describe('segredos', () => {
  it('nenhuma resposta da API (corpo ou cabeçalho) contém as chaves do provedor e do Composio', () => {
    const all = seen.join('\n');
    expect(all).not.toContain(PROVIDER_KEY);
    expect(all).not.toContain(CONNECTOR_KEY);
    expect(all).not.toContain('valid-key-1111');
  });
});
