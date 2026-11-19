// Prova de A11 e A19 pela borda HTTP (phase 13, passo 6; CONN-02): a lista das contas conectadas do Composio, o nome de cada conta (tabela de A11), a liberação por bot e a
// leitura das contas liberadas a um bot (a seção só leitura do editor, A13, que com o Composio sem chave recebe 200 `configured: false` em vez de erro). O que a borda decide aqui: sessão, Origin e CSRF (A19), corpo estrito (campo fora do permitido), versão
// esperada, bot inexistente e a ausência da chave do Composio em toda resposta, na auditoria e no log. A regra de nome, a liberação e a auditoria em si são do serviço
// (`credentials/accounts.test.ts`); aqui se prova que a rota as entrega e que, recusada, NADA é gravado.
// O Composio é o servidor HTTP falso local (`startFakeUpstreams`): seis contas conectadas, entre elas dois Gmail ativos (`ca_1` e `ca_6`) e um GitHub ativo (`ca_3`).
import { randomUUID } from 'node:crypto';
import { startFakeUpstreams, type FakeUpstreams } from '@aion/core/testing';
import { CONNECTOR_ACCOUNT_NAME_MAX, type BotConnectorAccounts, type ConnectorAccountView } from '@aion/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHROME_UA, createTestApi, ORIGIN, type TestApi } from './testing/harness';

const CONNECTOR_KEY = 'valid-connector-key-6001';
/** Os dois Gmail ativos e o GitHub ativo do Composio falso (`FAKE_CONNECTED_ACCOUNTS`). */
const GMAIL_A = 'ca_1';
const GMAIL_B = 'ca_6';
const GITHUB = 'ca_3';

let upstreams: FakeUpstreams;
let api: TestApi;
let session: { cookie: string; csrfToken: string };
/** Corpo e cabeçalhos de TODA resposta recebida: o último teste confere que nenhuma traz a chave do Composio. */
const seen: string[] = [];

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  api = await createTestApi({ AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl, AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl, AION_PARALLEL_BASE_URL: upstreams.parallelBaseUrl });
  session = await api.login();
  const saved = await api.app.inject({ method: 'POST', url: '/api/credentials/connector', headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrfToken }, payload: { key: CONNECTOR_KEY } });
  expect(saved.statusCode).toBe(200);
});

afterAll(async () => {
  await api?.cleanup();
  await upstreams?.stop();
});

/** Cada teste parte das contas conhecidas vazias (a primeira leitura as grava de novo, na versão 0); os bots criados ficam, com nome próprio por teste. */
beforeEach(async () => {
  await api.pool.query('TRUNCATE connector_accounts, audit_log CASCADE');
});

type Headers = Record<string, string | undefined>;

/** Dono pela sessão real; os `headers` trocam (ou, com `undefined`, retiram) cabeçalhos para exercitar as recusas dos hooks centrais. */
async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Headers = {}) {
  const merged: Headers = { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrfToken, 'user-agent': CHROME_UA, ...headers };
  const sent = Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const response = await api.app.inject({ method, url, payload: payload as object | undefined, headers: sent });
  seen.push(response.body, JSON.stringify(response.headers));
  return response;
}

const listed = async () => (await call('GET', '/api/connector/accounts')).json<{ accounts: ConnectorAccountView[] }>().accounts;
const accountOf = async (id: string) => (await listed()).find((account) => account.id === id)!;
const rename = (id: string, name: unknown, expectedVersion: number, headers?: Headers) => call('PATCH', `/api/connector/accounts/${id}`, { name, expectedVersion }, headers);
const release = (id: string, botIds: string[], expectedVersion: number, headers?: Headers) => call('PUT', `/api/connector/accounts/${id}/access`, { botIds, expectedVersion }, headers);
let botCount = 0;
const createBot = async (label: string) => (await call('POST', '/api/bots', { name: `${label} ${(botCount += 1)}`, color: '#60A5FA' })).json<{ id: string }>().id;
const storedOf = async (id: string) => (await api.pool.query<{ name: string | null; version: number }>('SELECT name, version FROM connector_accounts WHERE id = $1', [id])).rows[0];
const releasedTo = async (id: string) => (await api.pool.query<{ bot_id: string }>('SELECT bot_id FROM connector_account_bots WHERE account_id = $1 ORDER BY bot_id', [id])).rows.map((row) => row.bot_id);
const audits = async (action: string) =>
  (await api.pool.query<{ outcome: string; actor: string; ip: string | null; user_agent: string | null; target: string | null; details: unknown }>(
    'SELECT outcome, actor, ip, user_agent, target, details FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;

/** Retrato do que a rota poderia gravar (nomes, versões, liberações e auditoria das contas): igual antes e depois de uma recusa, nada foi gravado. */
const snapshot = async () =>
  JSON.stringify([
    (await api.pool.query('SELECT id, name, version FROM connector_accounts ORDER BY id')).rows,
    (await api.pool.query('SELECT account_id, bot_id FROM connector_account_bots ORDER BY account_id, bot_id')).rows,
    (await api.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'connector_account.%'")).rows,
  ]);

/** Envia a requisição e confere o status e o código estável do envelope de erro. */
async function expectRefused(label: string, response: Promise<{ statusCode: number; json<T>(): T }>, status: number, code: string) {
  const answered = await response;
  expect([answered.statusCode, answered.json<{ code: string }>().code], label).toEqual([status, code]);
}

describe('lista das contas (A12, A13)', () => {
  it('traz uma linha por conta, com nome ou rótulo, estado, bots liberados e versão, sem campo extra', async () => {
    const response = await call('GET', '/api/connector/accounts');
    expect(response.statusCode).toBe(200);
    const row = (id: string, appSlug: string, appName: string, status: string) => ({ id, appSlug, appName, name: null, label: `${appName} · ca_…${id.slice(3)}`, status, botIds: [], version: 0 });
    // Ordem do servidor: app e depois rótulo. O estado vem do Composio (INITIATED = pendente, EXPIRED = requer atenção).
    expect(response.json()).toEqual({
      accounts: [
        row('ca_2', 'github', 'Github', 'pending'),
        row('ca_3', 'github', 'Github', 'active'),
        row('ca_1', 'gmail', 'Gmail', 'active'),
        row('ca_6', 'gmail', 'Gmail', 'active'),
        row('ca_4', 'google_calendar', 'Google Calendar', 'pending'),
        row('ca_5', 'slack', 'Slack', 'attention'),
      ],
    });
  });

  it('a conta que o Composio não lista mais aparece como desconectada, com o nome e as liberações mantidos (A17)', async () => {
    const bot = await createBot('Dona da conta removida');
    await api.pool.query("INSERT INTO connector_accounts (id, app_slug, app_name, name, name_key) VALUES ('ca_removida', 'gmail', 'Gmail', 'Antiga', 'antiga')");
    await api.pool.query("INSERT INTO connector_account_bots (account_id, bot_id) VALUES ('ca_removida', $1)", [bot]);
    expect(await accountOf('ca_removida')).toEqual({ id: 'ca_removida', appSlug: 'gmail', appName: 'Gmail', name: 'Antiga', label: 'Antiga', status: 'disconnected', botIds: [bot], version: 0 });
  });

  it('as contas liberadas a um bot saem só para leitura: sem os bots nem a versão, e só as dele', async () => {
    const [x, y] = [await createBot('Leitor X'), await createBot('Leitor Y')];
    await accountOf(GMAIL_A);
    await release(GMAIL_A, [x, y], 0);
    await release(GITHUB, [x], 0);
    await api.pool.query("INSERT INTO connector_accounts (id, app_slug, app_name, name, name_key) VALUES ('ca_removida', 'gmail', 'Gmail', 'Antiga', 'antiga')");
    await api.pool.query("INSERT INTO connector_account_bots (account_id, bot_id) VALUES ('ca_removida', $1)", [x]);

    const forX = await call('GET', `/api/bots/${x}/connector-accounts`);
    expect(forX.statusCode).toBe(200);
    expect(forX.json<BotConnectorAccounts>()).toEqual({
      configured: true,
      accounts: [
        { id: GITHUB, appSlug: 'github', appName: 'Github', name: null, label: 'Github · ca_…3', status: 'active' },
        { id: 'ca_removida', appSlug: 'gmail', appName: 'Gmail', name: 'Antiga', label: 'Antiga', status: 'disconnected' },
        { id: GMAIL_A, appSlug: 'gmail', appName: 'Gmail', name: null, label: 'Gmail · ca_…1', status: 'active' },
      ],
    });
    expect((await call('GET', `/api/bots/${y}/connector-accounts`)).json()).toEqual({ configured: true, accounts: [{ id: GMAIL_A, appSlug: 'gmail', appName: 'Gmail', name: null, label: 'Gmail · ca_…1', status: 'active' }] });
    const none = await createBot('Sem conta');
    expect((await call('GET', `/api/bots/${none}/connector-accounts`)).json()).toEqual({ configured: true, accounts: [] });
  });
});

describe('nome da conta (A11)', () => {
  it('segue a tabela da spec: grava, aceita 40 caracteres, recusa 41, recusa nome em uso no app, aceita o de outro app e volta ao rótulo com null', async () => {
    await accountOf(GMAIL_A);
    const forty = 'N'.repeat(CONNECTOR_ACCOUNT_NAME_MAX);

    // nome novo
    const first = await rename(GMAIL_A, 'Pessoal', 0);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ id: GMAIL_A, appSlug: 'gmail', appName: 'Gmail', name: 'Pessoal', label: 'Pessoal', status: 'active', botIds: [], version: 1 });

    // 40 caracteres gravado; 41 recusado com VALIDATION_FAILED e o anterior fica
    const max = await rename(GMAIL_B, forty, 0);
    expect(max.statusCode).toBe(200);
    expect((await storedOf(GMAIL_B))?.name).toHaveLength(CONNECTOR_ACCOUNT_NAME_MAX);
    const tooLong = await rename(GMAIL_B, 'N'.repeat(CONNECTOR_ACCOUNT_NAME_MAX + 1), 1);
    expect([tooLong.statusCode, tooLong.json().code, tooLong.json().fields]).toEqual([422, 'VALIDATION_FAILED', [{ field: 'name', reason: 'Valor longo demais.' }]]);
    expect(await storedOf(GMAIL_B)).toEqual({ name: forty, version: 1 });

    // outra conta do mesmo app já se chama "Pessoal": recusado (com a mensagem que o dono vê), também sem diferenciar maiúsculas; o nome anterior continua gravado
    const taken = await rename(GMAIL_B, 'Pessoal', 1);
    expect([taken.statusCode, taken.json()]).toEqual([409, { code: 'CONNECTOR_ACCOUNT_NAME_TAKEN', message: 'Já existe uma conta com esse nome neste app.' }]);
    expect((await rename(GMAIL_B, 'pessoal', 1)).json().code).toBe('CONNECTOR_ACCOUNT_NAME_TAKEN');
    expect(await storedOf(GMAIL_B)).toEqual({ name: forty, version: 1 });

    // conta de outro app já se chama "Pessoal": gravado
    const otherApp = await rename(GITHUB, 'Pessoal', 0);
    expect(otherApp.statusCode).toBe(200);
    expect(otherApp.json().name).toBe('Pessoal');

    // sem nome: null volta ao rótulo "Gmail · ca_…1"; o vazio não é um nome (o contrato manda null)
    const cleared = await rename(GMAIL_A, null, 1);
    expect(cleared.json()).toMatchObject({ name: null, label: 'Gmail · ca_…1', version: 2 });
    for (const empty of ['', '   ']) expect((await rename(GMAIL_A, empty, 2)).json().code, JSON.stringify(empty)).toBe('VALIDATION_FAILED');
    expect(await storedOf(GMAIL_A)).toEqual({ name: null, version: 2 });
  });
});

describe('liberação por bot (A19)', () => {
  it('aceita: grava a lista, devolve a conta sem a chave e audita quem liberou e quem revogou qual conta para qual bot', async () => {
    const [x, y] = [await createBot('Liberado X'), await createBot('Liberado Y')];
    await accountOf(GMAIL_A);

    const released = await release(GMAIL_A, [x, y], 0);
    expect(released.statusCode).toBe(200);
    expect(released.json()).toEqual({ id: GMAIL_A, appSlug: 'gmail', appName: 'Gmail', name: null, label: 'Gmail · ca_…1', status: 'active', botIds: [x, y].sort(), version: 1 });
    expect(await releasedTo(GMAIL_A)).toEqual([x, y].sort());

    // Trocar a lista: Y sai (revogado), X fica; a versão sobe e a auditoria registra cada bot liberado e cada bot revogado.
    const revoked = await release(GMAIL_A, [x], 1);
    expect(revoked.json()).toMatchObject({ botIds: [x], version: 2 });
    const owner = { outcome: 'success', actor: 'owner', ip: expect.any(String), user_agent: CHROME_UA, target: 'ca_…1' };
    expect(await audits('connector_account.release')).toEqual(expect.arrayContaining([{ ...owner, details: { app: 'gmail', name: null, botId: x } }, { ...owner, details: { app: 'gmail', name: null, botId: y } }]));
    expect(await audits('connector_account.release')).toHaveLength(2);
    expect(await audits('connector_account.revoke')).toEqual([{ ...owner, details: { app: 'gmail', name: null, botId: y } }]);

    // A lista vazia revoga todos; repetir a mesma lista não muda nada (sem nova versão nem auditoria).
    expect((await release(GMAIL_A, [], 2)).json()).toMatchObject({ botIds: [], version: 3 });
    expect((await release(GMAIL_A, [], 3)).json()).toMatchObject({ botIds: [], version: 3 });
    expect(await audits('connector_account.revoke')).toHaveLength(2);

    // A renomeação também audita quem fez e o nome anterior, com o id mascarado.
    await rename(GMAIL_A, 'Pessoal', 3);
    expect(await audits('connector_account.rename')).toEqual([{ ...owner, details: { app: 'gmail', previousName: null, name: 'Pessoal' } }]);
  });

  it('o id do bot não diferencia maiúsculas: reenviar em maiúsculas um bot já liberado não muda versão nem auditoria, e o mesmo bot nas duas grafias é repetição (422)', async () => {
    const [x, y] = [await createBot('Caixa X'), await createBot('Caixa Y')];
    await accountOf(GMAIL_A);
    expect((await release(GMAIL_A, [x], 0)).json()).toMatchObject({ botIds: [x], version: 1 });
    const before = await snapshot();

    // O mesmo conjunto em maiúsculas é a mesma lista: nenhuma revogação nem liberação aconteceu, então nada é gravado nem auditado.
    const same = await release(GMAIL_A, [x.toUpperCase()], 1);
    expect([same.statusCode, same.json().botIds, same.json().version]).toEqual([200, [x], 1]);
    expect(await snapshot()).toBe(before);
    expect(await audits('connector_account.release')).toHaveLength(1);
    expect(await audits('connector_account.revoke')).toHaveLength(0);

    // Bot novo em maiúsculas é liberado com o id canônico (minúsculas) e só ele gera evento.
    const added = await release(GMAIL_A, [x.toUpperCase(), y.toUpperCase()], 1);
    expect(added.json()).toMatchObject({ botIds: [x, y].sort(), version: 2 });
    expect((await audits('connector_account.release')).map((event) => (event.details as { botId: string }).botId)).toEqual([x, y]);
    expect(await audits('connector_account.revoke')).toHaveLength(0);

    // O mesmo bot em maiúsculas e minúsculas é repetição.
    const afterAdd = await snapshot();
    await expectRefused('mesmo bot nas duas grafias', release(GMAIL_A, [x, x.toUpperCase()], 2), 422, 'VALIDATION_FAILED');
    expect(await snapshot()).toBe(afterAdd);
  });

  it('recusa sem sessão (401), sem Origin ou CSRF válidos (403), e nada é gravado', async () => {
    const bot = await createBot('Forjado');
    await accountOf(GMAIL_A);
    const before = await snapshot();
    const routes = [
      ['GET', '/api/connector/accounts', undefined],
      ['PATCH', `/api/connector/accounts/${GMAIL_A}`, { name: 'Invasor', expectedVersion: 0 }],
      ['PUT', `/api/connector/accounts/${GMAIL_A}/access`, { botIds: [bot], expectedVersion: 0 }],
      ['DELETE', `/api/connector/accounts/${GMAIL_A}`, undefined],
      ['DELETE', '/api/connector/accounts/ca_removida', undefined],
      ['GET', `/api/bots/${bot}/connector-accounts`, undefined],
    ] as const;
    for (const [method, url, payload] of routes) {
      await expectRefused(`${method} ${url} sem sessão`, call(method, url, payload, { cookie: undefined }), 401, 'AUTH_SESSION_EXPIRED');
      await expectRefused(`${method} ${url} com cookie vazio`, call(method, url, payload, { cookie: '' }), 401, 'AUTH_SESSION_EXPIRED');
      if (method === 'GET') continue;
      await expectRefused(`${method} ${url} sem token CSRF`, call(method, url, payload, { 'x-csrf-token': undefined }), 403, 'CSRF_TOKEN_INVALID');
      await expectRefused(`${method} ${url} com token CSRF de outra sessão`, call(method, url, payload, { 'x-csrf-token': 'x'.repeat(43) }), 403, 'CSRF_TOKEN_INVALID');
      await expectRefused(`${method} ${url} sem Origin`, call(method, url, payload, { origin: undefined }), 403, 'CSRF_ORIGIN_INVALID');
      await expectRefused(`${method} ${url} com Origin de outro site`, call(method, url, payload, { origin: 'https://evil.example' }), 403, 'CSRF_ORIGIN_INVALID');
    }
    expect(await snapshot()).toBe(before);
  });

  it('recusa bot inexistente (404 BOT_NOT_FOUND) sem liberar nenhum dos outros bots da mesma lista', async () => {
    const real = await createBot('Existente');
    await accountOf(GMAIL_A);
    const before = await snapshot();
    await expectRefused('só bot inexistente', release(GMAIL_A, [randomUUID()], 0), 404, 'BOT_NOT_FOUND');
    await expectRefused('bot real e bot inexistente', release(GMAIL_A, [real, randomUUID()], 0), 404, 'BOT_NOT_FOUND');
    await expectRefused('conta que o Aion não conhece', release('ca_desconhecida', [real], 0), 404, 'NOT_FOUND');
    await expectRefused('renomear conta que o Aion não conhece', rename('ca_desconhecida', 'Nome', 0), 404, 'NOT_FOUND');
    await expectRefused('leitura das contas de bot inexistente', call('GET', `/api/bots/${randomUUID()}/connector-accounts`), 404, 'BOT_NOT_FOUND');
    expect(await snapshot()).toBe(before);
  });

  it('recusa campo fora do permitido, formato inválido e corpo grande na borda (422 e 413), e nada é gravado', async () => {
    const bot = await createBot('Estrito');
    await accountOf(GMAIL_A);
    const before = await snapshot();
    const putAccess = (payload: unknown, id = GMAIL_A) => call('PUT', `/api/connector/accounts/${id}/access`, payload);
    const patchName = (payload: unknown, id = GMAIL_A) => call('PATCH', `/api/connector/accounts/${id}`, payload);

    const refused: [string, Promise<{ statusCode: number; json<T>(): T }>][] = [
      ['renomear com campo extra (botIds)', patchName({ name: 'X', expectedVersion: 0, botIds: [bot] })],
      ['renomear sem a versão esperada', patchName({ name: 'X' })],
      ['renomear sem o nome', patchName({ expectedVersion: 0 })],
      ['renomear com versão negativa', patchName({ name: 'X', expectedVersion: -1 })],
      ['renomear com nome que não é texto', patchName({ name: 42, expectedVersion: 0 })],
      ['renomear com caractere de controle no nome', patchName({ name: 'a\u0000b', expectedVersion: 0 })],
      ['renomear com id da conta fora do formato', patchName({ name: 'X', expectedVersion: 0 }, 'a%20b')],
      ['renomear com id da conta acima de 200 caracteres', patchName({ name: 'X', expectedVersion: 0 }, 'c'.repeat(201))],
      ['liberar com campo extra (name)', putAccess({ botIds: [bot], expectedVersion: 0, name: 'X' })],
      ['liberar sem a versão esperada', putAccess({ botIds: [bot] })],
      ['liberar sem a lista de bots', putAccess({ expectedVersion: 0 })],
      ['liberar com bot que não é um id', putAccess({ botIds: ['bot-x'], expectedVersion: 0 })],
      ['liberar com bot repetido', putAccess({ botIds: [bot, bot], expectedVersion: 0 })],
      ['liberar mais de 100 bots', putAccess({ botIds: Array.from({ length: 101 }, () => randomUUID()), expectedVersion: 0 })],
      ['liberar com id da conta fora do formato', putAccess({ botIds: [bot], expectedVersion: 0 }, 'a%20b')],
      ['ler as contas de um bot com id que não é UUID', call('GET', '/api/bots/nao-e-uuid/connector-accounts')],
    ];
    for (const [label, response] of refused) await expectRefused(label, response, 422, 'VALIDATION_FAILED');
    // Corpo acima do limite desta árvore (8 KiB, bem acima de 100 ids): recusado antes de qualquer leitura.
    await expectRefused('liberar com corpo grande', putAccess({ botIds: [bot], expectedVersion: 0, enchimento: 'x'.repeat(9000) }), 413, 'PAYLOAD_TOO_LARGE');
    expect(await snapshot()).toBe(before);
  });

  it('recusa a versão antiga (409 CONNECTOR_ACCOUNT_CONFLICT) em nome e em liberação, e nada é gravado', async () => {
    const bot = await createBot('Versão antiga');
    await accountOf(GMAIL_A);
    expect((await rename(GMAIL_A, 'Pessoal', 0)).statusCode).toBe(200);
    const before = await snapshot();

    const stale = await rename(GMAIL_A, 'Outro', 0);
    expect([stale.statusCode, stale.json()]).toEqual([409, { code: 'CONNECTOR_ACCOUNT_CONFLICT', message: 'As contas mudaram. Recarregue antes de salvar.' }]);
    await expectRefused('liberar com a versão antiga', release(GMAIL_A, [bot], 0), 409, 'CONNECTOR_ACCOUNT_CONFLICT');
    await expectRefused('liberar com a versão do futuro', release(GMAIL_A, [bot], 9), 409, 'CONNECTOR_ACCOUNT_CONFLICT');
    expect(await snapshot()).toBe(before);
    expect(await storedOf(GMAIL_A)).toEqual({ name: 'Pessoal', version: 1 });
  });
});

// Remoção da conta desconectada (R8): a rota entrega o 204 do serviço e, recusada, NADA é apagado. A regra em si (estado ao vivo, cascata, auditoria, concorrência) é do serviço
// (`credentials/accounts.test.ts`); aqui se prova a borda: sessão, Origin e CSRF (na tabela de A19, acima), o id da URL, os códigos estáveis e a auditoria com quem fez e sem o id inteiro.
describe('remoção da conta desconectada (R8)', () => {
  /** A conta que o Composio falso NÃO lista (desconectada), com nome e uma liberação, gravada direto no banco como a primeira leitura a teria gravado. */
  async function seedDisconnected(botId: string): Promise<void> {
    await api.pool.query("INSERT INTO connector_accounts (id, app_slug, app_name, name, name_key) VALUES ('ca_removida', 'gmail', 'Gmail', 'Antiga', 'antiga')");
    await api.pool.query("INSERT INTO connector_account_bots (account_id, bot_id) VALUES ('ca_removida', $1)", [botId]);
  }
  const remove = (id: string, headers?: Headers) => call('DELETE', `/api/connector/accounts/${id}`, undefined, headers);

  it('remove a conta desconectada e as liberações dela (204 sem corpo), some da lista e audita quem removeu, com o id mascarado e sem o id inteiro', async () => {
    const bot = await createBot('Dona da conta a remover');
    await accountOf(GMAIL_A); // a primeira leitura grava as contas do Composio, que a remoção não pode tocar
    await seedDisconnected(bot);
    expect((await accountOf('ca_removida')).status).toBe('disconnected');

    const removed = await remove('ca_removida');
    expect([removed.statusCode, removed.body]).toEqual([204, '']);
    expect(await storedOf('ca_removida')).toBeUndefined();
    expect(await releasedTo('ca_removida')).toEqual([]);
    expect((await listed()).map((account) => account.id)).not.toContain('ca_removida');
    expect((await listed()).map((account) => account.id)).toContain(GMAIL_A);
    expect(await audits('connector_account.remove')).toEqual([
      { outcome: 'success', actor: 'owner', ip: expect.any(String), user_agent: CHROME_UA, target: 'ca_…vida', details: { app: 'gmail', name: 'Antiga', bots: 1 } },
    ]);
    expect(JSON.stringify(await audits('connector_account.remove'))).not.toContain('ca_removida');
    await expectRefused('remover de novo a conta já removida', remove('ca_removida'), 404, 'NOT_FOUND');
  });

  it('recusa a conta que o Composio ainda lista (409 CONNECTOR_ACCOUNT_CONFLICT), a desconhecida (404) e o id fora do formato (422), sem apagar nada', async () => {
    const bot = await createBot('Dona da conta em uso');
    await accountOf(GMAIL_A);
    await release(GMAIL_A, [bot], 0);
    const before = await snapshot();

    // Ativa (ca_1), pendente (ca_2) e que requer atenção (ca_5): o Composio as lista, então o servidor recusa mesmo que a tela as mostrasse como desconectadas.
    for (const id of [GMAIL_A, 'ca_2', 'ca_5']) {
      const refused = await remove(id);
      expect([id, refused.statusCode, refused.json()]).toEqual([id, 409, { code: 'CONNECTOR_ACCOUNT_CONFLICT', message: 'As contas mudaram. Recarregue antes de salvar.' }]);
    }
    await expectRefused('conta que o Aion não conhece', remove('ca_desconhecida'), 404, 'NOT_FOUND');
    await expectRefused('id da conta fora do formato', remove('a%20b'), 422, 'VALIDATION_FAILED');
    await expectRefused('id da conta acima de 200 caracteres', remove('c'.repeat(201)), 422, 'VALIDATION_FAILED');
    expect(await snapshot()).toBe(before);
    expect(await releasedTo(GMAIL_A)).toEqual([bot]);
  });

  it('com o Composio sem chave a leitura ao vivo falha (409 CONNECTOR_NOT_CONFIGURED) e a conta desconectada continua guardada', async () => {
    const bot = await createBot('Dona da conta sem chave');
    await accountOf(GMAIL_A);
    await seedDisconnected(bot);
    expect((await call('DELETE', '/api/credentials/connector')).statusCode).toBe(204);
    try {
      const before = await snapshot();
      await expectRefused('remover sem poder ler o Composio', remove('ca_removida'), 409, 'CONNECTOR_NOT_CONFIGURED');
      expect(await snapshot()).toBe(before);
      expect(await storedOf('ca_removida')).toEqual({ name: 'Antiga', version: 0 });
    } finally {
      // Os testes seguintes partem da chave conectada.
      expect((await call('POST', '/api/credentials/connector', { key: CONNECTOR_KEY })).statusCode).toBe(200);
    }
    expect((await remove('ca_removida')).statusCode).toBe(204);
  });
});

describe('Composio sem chave (A13)', () => {
  it('a seção do editor do bot recebe 200 com configured: false e lista vazia, sem chamar o Composio nem gravar; a tela de Conexões e o bot inexistente seguem como erro', async () => {
    const bot = await createBot('Sem chave');
    await accountOf(GMAIL_A);
    expect((await release(GMAIL_A, [bot], 0)).statusCode).toBe(200);

    // Desconecta o Composio e confere o retrato do que a rota poderia gravar e quantas chamadas o falso já recebeu.
    expect((await call('DELETE', '/api/credentials/connector')).statusCode).toBe(204);
    try {
      const before = await snapshot();
      const composioCalls = upstreams.requests.filter((request) => request.service === 'composio').length;

      // Estado explícito, não erro: a lista vem vazia mesmo com uma liberação gravada, porque sem chave não há o que cruzar com o Composio.
      const forBot = await call('GET', `/api/bots/${bot}/connector-accounts`);
      expect([forBot.statusCode, forBot.json<BotConnectorAccounts>()]).toEqual([200, { configured: false, accounts: [] }]);

      // As demais leituras não mudam: a tela de Conexões continua recusando com o código estável, e o bot inexistente continua 404 mesmo sem chave.
      await expectRefused('lista das contas sem chave', call('GET', '/api/connector/accounts'), 409, 'CONNECTOR_NOT_CONFIGURED');
      await expectRefused('bot inexistente sem chave', call('GET', `/api/bots/${randomUUID()}/connector-accounts`), 404, 'BOT_NOT_FOUND');

      expect(upstreams.requests.filter((request) => request.service === 'composio')).toHaveLength(composioCalls);
      expect(await snapshot()).toBe(before);
    } finally {
      // Os testes seguintes (e o último, do segredo) partem da chave conectada.
      const restored = await call('POST', '/api/credentials/connector', { key: CONNECTOR_KEY });
      expect(restored.statusCode).toBe(200);
    }
    expect((await call('GET', `/api/bots/${bot}/connector-accounts`)).json<BotConnectorAccounts>()).toMatchObject({ configured: true, accounts: [expect.objectContaining({ id: GMAIL_A })] });
  });
});

describe('segredo (SEC-01)', () => {
  it('nenhuma resposta, auditoria nem log traz a chave do Composio', async () => {
    // Este é o último teste: `seen` já tem toda resposta dos anteriores (lista, nome, liberação, leitura por bot e recusas).
    expect(seen.length).toBeGreaterThan(20);
    expect(seen.join('\n')).not.toContain(CONNECTOR_KEY);
    expect(JSON.stringify((await api.pool.query('SELECT * FROM audit_log')).rows)).not.toContain(CONNECTOR_KEY);
    expect(api.logs.join('\n')).not.toContain(CONNECTOR_KEY);
    // O corpo de todo 200 das contas só tem os campos do contrato (o schema de resposta descarta o resto).
    const keys = new Set((await listed()).flatMap((account) => Object.keys(account)));
    expect([...keys].sort()).toEqual(['appName', 'appSlug', 'botIds', 'id', 'label', 'name', 'status', 'version']);
  });
});
