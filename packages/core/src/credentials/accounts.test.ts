// Prova do serviço das contas do conector liberadas por bot (phase 13, passo 2) contra PostgreSQL real: a semeadura única da liberação dos bots atuais (A14 no serviço e A15),
// o nome da conta (A11 no serviço), a liberação com versão esperada e auditoria, a conta que some do Composio (A17) e as consultas que a execução e o editor do bot usam.
// A leitura do Composio é uma fonte falsa controlada pelo teste: o serviço nunca vê a chave, só as contas e o estado delas.
import { randomUUID } from 'node:crypto';
import { connectorAccountViewSchema } from '@aion/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createPool, type Pool } from '../db/pool';
import { MIGRATIONS } from '../db/migrations';
import { DomainError } from '../errors';
import { migrateTestDatabase } from '../testing/migrate';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { ConnectorAccountService, connectorAccountLabel } from './accounts';
import type { ConnectorAccountListing } from './composio';

const ORIGIN = { ip: '203.0.113.7', userAgent: 'teste-contas' };
const NOW = new Date('2026-10-27T12:00:00Z');
const MIGRATION_0050 = '0050_connector_accounts';

/** Uma conta como a leitura do Composio a informa; o app vira o nome legível (`gmail` -> `Gmail`). */
const account = (id: string, toolkitSlug: string, status: ConnectorAccountListing['status'] = 'active'): ConnectorAccountListing => ({
  id,
  userId: 'usr_dono',
  toolkitSlug,
  toolkitName: toolkitSlug.charAt(0).toUpperCase() + toolkitSlug.slice(1),
  status,
});

/** Código do `DomainError` lançado, ou `ok`. */
const outcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof DomainError ? error.code : `inesperado: ${String(error)}`),
  );

const databases: TestDatabase[] = [];
const pools: Pool[] = [];

async function freshPool(migrations = MIGRATIONS): Promise<Pool> {
  const database = await createTestDatabase(inject('adminDatabaseUrl'));
  databases.push(database);
  const pool = createPool(database.url, { applicationName: 'accounts-test', max: 6 });
  pools.push(pool);
  await migrateTestDatabase(pool, { migrations });
  return pool;
}

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await Promise.all(databases.map((database) => database.drop()));
});

/** Fonte falsa da leitura ao vivo: o teste troca `live` (ou faz a leitura falhar) entre as chamadas. */
function createWorld(pool: Pool) {
  const state = { live: [] as ConnectorAccountListing[], failure: null as DomainError | null, truncated: false, reads: 0 };
  const service = new ConnectorAccountService({
    pool,
    source: {
      listConnectorAccounts: async () => {
        state.reads += 1;
        if (state.failure) throw state.failure;
        // `truncated` é o sinal do adaptador de que o Composio tem mais contas do que a primeira página lida (R9); só existe quando verdadeiro, como no adaptador.
        return state.truncated ? Object.assign([...state.live], { truncated: true as const }) : state.live;
      },
    },
    now: () => NOW,
  });
  return { state, service };
}

async function insertBot(pool: Pool, name: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO bots (id, name, name_key, color, created_at, updated_at) VALUES ($1, $2, lower($2), '#60A5FA', now(), now())", [id, name]);
  return id;
}

const audits = async (pool: Pool, action?: string) =>
  (await pool.query<{ action: string; outcome: string; actor: string; ip: string | null; user_agent: string | null; target: string | null; details: Record<string, unknown> }>(
    'SELECT action, outcome, actor, ip, user_agent, target, details FROM audit_log WHERE action LIKE $1 ORDER BY id', [action ?? 'connector_account.%'])).rows;

describe('rótulo automático', () => {
  it('é o nome do app e o sufixo do id ("Gmail · ca_…1a2b"), e o nome do dono vence quando existe', () => {
    expect(connectorAccountLabel({ appName: 'Gmail', id: 'ca_AbCd1a2b', name: null })).toBe('Gmail · ca_…1a2b');
    expect(connectorAccountLabel({ appName: 'Gmail', id: 'ca_1', name: null })).toBe('Gmail · ca_…1');
    expect(connectorAccountLabel({ appName: 'Gmail', id: 'ca_AbCd1a2b', name: 'Pessoal' })).toBe('Pessoal');
  });
});

describe('semeadura única da liberação dos bots atuais (A14 no serviço, A15)', () => {
  /** Banco "de produção antes da 0050": três bots, um deles excluído antes da primeira leitura; depois a 0050 grava o instantâneo. */
  async function productionBeforeFirstRead() {
    const pool = await freshPool(MIGRATIONS.filter((migration) => migration.id < MIGRATION_0050));
    const [x, y, removed] = [await insertBot(pool, 'X'), await insertBot(pool, 'Y'), await insertBot(pool, 'Removido')];
    await migrateTestDatabase(pool);
    await pool.query('DELETE FROM bots WHERE id = $1', [removed]);
    return { pool, x, y, ...createWorld(pool) };
  }
  const LIVE = [
    account('ca_gmail_A111', 'gmail'),
    account('ca_gmail_B222', 'gmail'),
    account('ca_github_G111', 'github', 'pending'),
    account('ca_github_G222', 'github'),
    account('ca_slack_S111', 'slack', 'attention'),
  ];

  it('antes da primeira leitura boa nada é liberado; a primeira libera a primeira conta ATIVA de cada app aos bots do instantâneo e às demais ninguém (A14)', async () => {
    const { pool, state, service, x, y } = await productionBeforeFirstRead();
    state.live = LIVE;
    expect(await service.releasedTo(x)).toEqual([]);

    const views = await service.list();
    const byId = new Map(views.map((view) => [view.id, view]));
    // A primeira ativa de cada app (a regra que os bots já seguiam), na ordem da listagem do Composio; GitHub pula a pendente.
    expect([...byId.values()].filter((view) => view.botIds.length > 0).map((view) => view.id).sort()).toEqual(['ca_github_G222', 'ca_gmail_A111']);
    for (const id of ['ca_gmail_A111', 'ca_github_G222']) expect([...byId.get(id)!.botIds].sort()).toEqual([x, y].sort());
    for (const id of ['ca_gmail_B222', 'ca_github_G111', 'ca_slack_S111']) expect(byId.get(id)!.botIds).toEqual([]);
    // O bot excluído antes da primeira leitura não entra (e não quebra a chave estrangeira).
    expect((await service.releasedTo(x)).map((released) => released.id).sort()).toEqual(['ca_github_G222', 'ca_gmail_A111']);
    // Cada liberação semeada sobe a versão da conta; a conta sem liberação segue em 0.
    expect(byId.get('ca_gmail_A111')!.version).toBe(1);
    expect(byId.get('ca_gmail_B222')!.version).toBe(0);
    // O instantâneo cumpriu o papel e é descartado; a semeadura fica concluída e auditada pelo sistema, uma vez.
    expect((await pool.query('SELECT completed_at IS NOT NULL AS done, cardinality(bot_ids) AS bots FROM connector_seed')).rows).toEqual([{ done: true, bots: 0 }]);
    expect(await audits(pool, 'connector_account.seed')).toEqual([
      expect.objectContaining({ action: 'connector_account.seed', outcome: 'success', actor: 'system', details: { accounts: 2, bots: 2 } }),
    ]);
  });

  it('a segunda leitura não semeia de novo: conta nova e bot novo nascem sem liberação (A15)', async () => {
    const { pool, state, service, x } = await productionBeforeFirstRead();
    state.live = LIVE;
    await service.list();
    const auditsAfterSeed = (await audits(pool)).length;

    // O dono conecta outra conta Gmail (que vem ANTES da liberada na listagem) e cria um bot novo.
    const created = await insertBot(pool, 'Novo');
    state.live = [account('ca_gmail_NOVA', 'gmail'), ...LIVE];
    const views = await service.list();

    expect(views.find((view) => view.id === 'ca_gmail_NOVA')).toMatchObject({ botIds: [], version: 0, status: 'active' });
    expect(await service.releasedTo(created)).toEqual([]);
    expect((await service.releasedTo(x)).map((released) => released.id).sort()).toEqual(['ca_github_G222', 'ca_gmail_A111']);
    expect(await audits(pool)).toHaveLength(auditsAfterSeed);
  });

  it('leitura que falha deixa a semeadura pendente e nada liberado; a primeira leitura boa depois a conclui', async () => {
    const { pool, state, service, x } = await productionBeforeFirstRead();
    state.live = LIVE;
    state.failure = new DomainError('CONNECTOR_UNAVAILABLE');
    expect(await outcome(service.list())).toBe('CONNECTOR_UNAVAILABLE');
    expect((await pool.query('SELECT completed_at FROM connector_seed')).rows).toEqual([{ completed_at: null }]);
    expect(await service.releasedTo(x)).toEqual([]);

    state.failure = null;
    await service.list();
    expect((await service.releasedTo(x)).map((released) => released.id).sort()).toEqual(['ca_github_G222', 'ca_gmail_A111']);
  });

  it('duas primeiras leituras ao mesmo tempo semeiam uma única vez (trava de banco)', async () => {
    const { pool, state, service } = await productionBeforeFirstRead();
    state.live = LIVE;
    await Promise.all([service.list(), service.list(), service.sync(LIVE)]);
    expect(await audits(pool, 'connector_account.seed')).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS total FROM connector_account_bots')).rows).toEqual([{ total: 4 }]);
    expect((await pool.query("SELECT version FROM connector_accounts WHERE id = 'ca_gmail_A111'")).rows).toEqual([{ version: 1 }]);
  });

  it('com a leitura sem nenhuma conta a semeadura conclui sem liberar nada, e a conta conectada depois nasce sem acesso', async () => {
    const { state, service, x } = await productionBeforeFirstRead();
    state.live = [];
    expect(await service.list()).toEqual([]);
    state.live = LIVE;
    expect((await service.list()).every((view) => view.botIds.length === 0)).toBe(true);
    expect(await service.releasedTo(x)).toEqual([]);
  });
});

describe('contas, nomes e liberações', () => {
  let pool: Pool;
  let world: ReturnType<typeof createWorld>;
  let x: string;
  let y: string;

  beforeAll(async () => {
    pool = await freshPool();
  });

  beforeEach(async () => {
    // Banco migrado do zero nasce sem bots, então a semeadura não libera nada; cada teste parte de contas e bots próprios.
    await pool.query('TRUNCATE connector_accounts, audit_log CASCADE');
    await pool.query('DELETE FROM bots');
    await pool.query('UPDATE connector_seed SET completed_at = now(), bot_ids = $1', [[]]);
    [x, y] = [await insertBot(pool, 'X'), await insertBot(pool, 'Y')];
    world = createWorld(pool);
    world.state.live = [account('ca_gmail_A111', 'gmail'), account('ca_gmail_B222', 'gmail'), account('ca_github_G222', 'github'), account('ca_slack_S111', 'slack', 'attention')];
  });

  const versionOf = async (id: string) => (await pool.query<{ version: number }>('SELECT version FROM connector_accounts WHERE id = $1', [id])).rows[0]!.version;
  const nameOf = async (id: string) => (await pool.query<{ name: string | null }>('SELECT name FROM connector_accounts WHERE id = $1', [id])).rows[0]!.name;

  it('lista uma linha por conta (as duas do Gmail separadas), com rótulo automático, estado, bots e versão, ordenadas por app e rótulo, sem campo além do contrato', async () => {
    const views = await world.service.list();
    expect(views.map((view) => [view.id, view.appName, view.label, view.status])).toEqual([
      ['ca_github_G222', 'Github', 'Github · ca_…G222', 'active'],
      ['ca_gmail_A111', 'Gmail', 'Gmail · ca_…A111', 'active'],
      ['ca_gmail_B222', 'Gmail', 'Gmail · ca_…B222', 'active'],
      ['ca_slack_S111', 'Slack', 'Slack · ca_…S111', 'attention'],
    ]);
    for (const view of views) {
      expect(view).toMatchObject({ name: null, botIds: [], version: 0 });
      expect(connectorAccountViewSchema.parse(view)).toEqual(view);
    }
  });

  describe('nome (A11 no serviço)', () => {
    const rename = (id: string, name: string | null, expectedVersion: number, extra: object = {}) => world.service.rename(id, { name, expectedVersion, ...extra }, ORIGIN);

    it('grava o nome, sobe a versão, mostra o nome no lugar do rótulo e audita sem expor o id inteiro', async () => {
      await world.service.list();
      const renamed = await rename('ca_gmail_A111', '  Pessoal  ', 0);
      expect(renamed).toMatchObject({ id: 'ca_gmail_A111', name: 'Pessoal', label: 'Pessoal', version: 1 });
      expect(await nameOf('ca_gmail_A111')).toBe('Pessoal');
      expect((await world.service.list()).find((view) => view.id === 'ca_gmail_A111')).toMatchObject({ name: 'Pessoal', label: 'Pessoal', version: 1 });
      const [event] = await audits(pool, 'connector_account.rename');
      expect(event).toMatchObject({ outcome: 'success', actor: 'owner', ip: ORIGIN.ip, user_agent: ORIGIN.userAgent, target: 'ca_…A111', details: { app: 'gmail', previousName: null, name: 'Pessoal' } });
      expect(JSON.stringify(await audits(pool))).not.toContain('ca_gmail_A111');
    });

    it('aceita 40 caracteres e recusa 41 com VALIDATION_FAILED, mantendo o nome anterior', async () => {
      await world.service.list();
      await rename('ca_gmail_A111', 'Antigo', 0);
      expect(await outcome(rename('ca_gmail_A111', 'x'.repeat(41), 1))).toBe('VALIDATION_FAILED');
      expect(await nameOf('ca_gmail_A111')).toBe('Antigo');
      expect(await versionOf('ca_gmail_A111')).toBe(1);
      expect(await outcome(rename('ca_gmail_A111', 'x'.repeat(40), 1))).toBe('ok');
      expect(await nameOf('ca_gmail_A111')).toBe('x'.repeat(40));
    });

    it('recusa nome vazio, com caractere de controle, campo extra e id fora do alfabeto (nada é gravado)', async () => {
      await world.service.list();
      for (const bad of ['', '   ', 'a\nb', 'a\u0000b']) expect(await outcome(rename('ca_gmail_A111', bad, 0)), JSON.stringify(bad)).toBe('VALIDATION_FAILED');
      expect(await outcome(rename('ca_gmail_A111', 'Pessoal', 0, { appSlug: 'github' }))).toBe('VALIDATION_FAILED');
      expect(await outcome(world.service.rename('ca_x; DROP TABLE bots', { name: 'Pessoal', expectedVersion: 0 }, ORIGIN))).toBe('VALIDATION_FAILED');
      expect(await nameOf('ca_gmail_A111')).toBeNull();
      expect(await audits(pool, 'connector_account.rename')).toEqual([]);
    });

    it('recusa nome já usado por outra conta do MESMO app, sem diferenciar maiúsculas, e aceita o mesmo nome em outro app', async () => {
      await world.service.list();
      await rename('ca_gmail_A111', 'Pessoal', 0);
      expect(await outcome(rename('ca_gmail_B222', 'Pessoal', 0))).toBe('CONNECTOR_ACCOUNT_NAME_TAKEN');
      expect(await outcome(rename('ca_gmail_B222', 'pessoal', 0))).toBe('CONNECTOR_ACCOUNT_NAME_TAKEN');
      expect(await nameOf('ca_gmail_B222')).toBeNull();
      expect(await outcome(rename('ca_github_G222', 'Pessoal', 0))).toBe('ok'); // outro app
      // A própria conta pode refazer o nome só trocando maiúsculas.
      expect(await outcome(rename('ca_gmail_A111', 'PESSOAL', 1))).toBe('ok');
    });

    it('o rótulo automático de outra conta do app também ocupa o nome (o modelo usa o nome como valor do parâmetro)', async () => {
      await world.service.list();
      expect(await outcome(rename('ca_gmail_B222', 'gmail · ca_…a111', 0))).toBe('CONNECTOR_ACCOUNT_NAME_TAKEN');
      expect(await outcome(rename('ca_gmail_A111', 'Gmail · ca_…A111', 0))).toBe('ok'); // o rótulo da própria conta não conflita
    });

    it('null limpa o nome e a conta volta ao rótulo automático', async () => {
      await world.service.list();
      await rename('ca_gmail_A111', 'Pessoal', 0);
      expect(await rename('ca_gmail_A111', null, 1)).toMatchObject({ name: null, label: 'Gmail · ca_…A111', version: 2 });
      expect(await nameOf('ca_gmail_A111')).toBeNull();
    });

    it('repetir o mesmo nome não muda nada (sem nova versão nem auditoria)', async () => {
      await world.service.list();
      await rename('ca_gmail_A111', 'Pessoal', 0);
      expect(await rename('ca_gmail_A111', 'Pessoal', 1)).toMatchObject({ version: 1 });
      expect(await audits(pool, 'connector_account.rename')).toHaveLength(1);
    });

    it('versão esperada antiga é CONNECTOR_ACCOUNT_CONFLICT e conta desconhecida é NOT_FOUND, sem gravar', async () => {
      await world.service.list();
      await rename('ca_gmail_A111', 'Pessoal', 0);
      expect(await outcome(rename('ca_gmail_A111', 'Outro', 0))).toBe('CONNECTOR_ACCOUNT_CONFLICT');
      expect(await nameOf('ca_gmail_A111')).toBe('Pessoal');
      expect(await outcome(rename('ca_inexistente', 'Pessoal', 0))).toBe('NOT_FOUND');
    });
  });

  describe('liberação por bot (A19 no serviço)', () => {
    const release = (id: string, botIds: string[], expectedVersion: number, extra: object = {}) => world.service.release(id, { botIds, expectedVersion, ...extra }, ORIGIN);

    it('libera a lista completa de bots, sobe a versão, audita quem liberou o quê para qual bot e a execução enxerga a liberação', async () => {
      await world.service.list();
      const released = await release('ca_gmail_A111', [x], 0);
      expect(released).toMatchObject({ id: 'ca_gmail_A111', botIds: [x], version: 1 });
      expect((await world.service.releasedTo(x)).map((item) => item.id)).toEqual(['ca_gmail_A111']);
      expect(await world.service.releasedTo(y)).toEqual([]);
      expect(await audits(pool, 'connector_account.release')).toEqual([
        expect.objectContaining({ outcome: 'success', actor: 'owner', ip: ORIGIN.ip, user_agent: ORIGIN.userAgent, target: 'ca_…A111', details: { app: 'gmail', name: null, botId: x } }),
      ]);
    });

    it('troca a lista: quem sai perde o acesso (revogação auditada), quem entra ganha, e o resto fica como estava', async () => {
      await world.service.list();
      await release('ca_gmail_A111', [x], 0);
      await release('ca_gmail_B222', [x, y], 0);
      const swapped = await release('ca_gmail_A111', [y], 1);
      expect(swapped).toMatchObject({ botIds: [y], version: 2 });
      expect((await world.service.releasedTo(x)).map((item) => item.id)).toEqual(['ca_gmail_B222']);
      expect((await world.service.releasedTo(y)).map((item) => item.id).sort()).toEqual(['ca_gmail_A111', 'ca_gmail_B222']);
      expect((await audits(pool, 'connector_account.revoke')).map((event) => event.details)).toEqual([{ app: 'gmail', name: null, botId: x }]);
      expect(await release('ca_gmail_A111', [], 2)).toMatchObject({ botIds: [], version: 3 }); // lista vazia revoga todos
      expect(await world.service.releasedTo(y).then((items) => items.map((item) => item.id))).toEqual(['ca_gmail_B222']);
    });

    it('a mesma lista é no-op (sem versão nova nem auditoria)', async () => {
      await world.service.list();
      await release('ca_gmail_A111', [x, y], 0);
      expect(await release('ca_gmail_A111', [y, x], 1)).toMatchObject({ version: 1 });
      expect(await audits(pool, 'connector_account.%')).toHaveLength(2); // uma liberação por bot, nada a mais
    });

    it('recusa versão antiga (CONNECTOR_ACCOUNT_CONFLICT), bot inexistente (BOT_NOT_FOUND), conta desconhecida (NOT_FOUND) e entrada inválida (VALIDATION_FAILED) sem gravar nada', async () => {
      await world.service.list();
      await release('ca_gmail_A111', [x], 0);
      const before = (await pool.query('SELECT account_id, bot_id FROM connector_account_bots ORDER BY 1, 2')).rows;
      const auditCount = (await audits(pool)).length;

      expect(await outcome(release('ca_gmail_A111', [x, y], 0))).toBe('CONNECTOR_ACCOUNT_CONFLICT');
      expect(await outcome(release('ca_gmail_A111', [x, randomUUID()], 1))).toBe('BOT_NOT_FOUND');
      expect(await outcome(release('ca_inexistente', [x], 0))).toBe('NOT_FOUND');
      expect(await outcome(release('ca_gmail_A111', [x, x], 1))).toBe('VALIDATION_FAILED'); // repetido
      expect(await outcome(release('ca_gmail_A111', ['nao-e-uuid'], 1))).toBe('VALIDATION_FAILED');
      expect(await outcome(release('ca_gmail_A111', [x], 1, { name: 'x' }))).toBe('VALIDATION_FAILED'); // campo fora do permitido
      expect(await outcome(release('ca_gmail_A111', Array.from({ length: 101 }, () => randomUUID()), 1))).toBe('VALIDATION_FAILED');

      expect((await pool.query('SELECT account_id, bot_id FROM connector_account_bots ORDER BY 1, 2')).rows).toEqual(before);
      expect(await versionOf('ca_gmail_A111')).toBe(1);
      expect(await audits(pool)).toHaveLength(auditCount);
    });

    it('duas liberações da mesma versão ao mesmo tempo: uma vence e a outra recebe o conflito', async () => {
      await world.service.list();
      const results = await Promise.all([release('ca_gmail_A111', [x], 0).then(() => 'ok', (error: DomainError) => error.code), release('ca_gmail_A111', [y], 0).then(() => 'ok', (error: DomainError) => error.code)]);
      expect(results.sort()).toEqual(['CONNECTOR_ACCOUNT_CONFLICT', 'ok']);
    });
  });

  describe('conta que some do Composio (A17 no núcleo) e consultas por bot', () => {
    it('a conta ausente na leitura aparece como desconectada mantendo nome e liberações, e volta a ativa quando o Composio a lista de novo', async () => {
      await world.service.list();
      await world.service.rename('ca_gmail_A111', { name: 'Pessoal', expectedVersion: 0 }, ORIGIN);
      await world.service.release('ca_gmail_A111', { botIds: [x], expectedVersion: 1 }, ORIGIN);

      world.state.live = world.state.live.filter((item) => item.id !== 'ca_gmail_A111');
      const gone = (await world.service.list()).find((view) => view.id === 'ca_gmail_A111')!;
      expect(gone).toMatchObject({ status: 'disconnected', name: 'Pessoal', label: 'Pessoal', botIds: [x], version: 2, appSlug: 'gmail', appName: 'Gmail' });
      // A liberação continua no banco (a execução a recusa por a conta estar desconectada), e o editor do bot a mostra desconectada.
      expect((await world.service.releasedTo(x)).map((item) => item.id)).toEqual(['ca_gmail_A111']);
      expect(await world.service.forBot(x)).toEqual([{ id: 'ca_gmail_A111', appSlug: 'gmail', appName: 'Gmail', name: 'Pessoal', label: 'Pessoal', status: 'disconnected' }]);

      world.state.live = [...world.state.live, account('ca_gmail_A111', 'gmail')];
      expect((await world.service.list()).find((view) => view.id === 'ca_gmail_A111')).toMatchObject({ status: 'active', name: 'Pessoal', botIds: [x] });
    });

    it('a troca da chave (lista de outra conta do Composio) deixa as contas antigas desconectadas, sem apagar nome nem liberação', async () => {
      await world.service.list();
      await world.service.release('ca_gmail_A111', { botIds: [y], expectedVersion: 0 }, ORIGIN);
      world.state.live = [account('ca_outra_chave', 'gmail')];
      const views = await world.service.list();
      expect(views.find((view) => view.id === 'ca_gmail_A111')).toMatchObject({ status: 'disconnected', botIds: [y] });
      expect(views.find((view) => view.id === 'ca_outra_chave')).toMatchObject({ status: 'active', botIds: [] });
    });

    it('forBot devolve só as contas liberadas ao bot, com o estado ao vivo e sem bots nem versão; bot inexistente é BOT_NOT_FOUND', async () => {
      await world.service.list();
      await world.service.release('ca_gmail_A111', { botIds: [x], expectedVersion: 0 }, ORIGIN);
      await world.service.release('ca_slack_S111', { botIds: [x, y], expectedVersion: 0 }, ORIGIN);
      await world.service.release('ca_gmail_B222', { botIds: [y], expectedVersion: 0 }, ORIGIN);
      expect(await world.service.forBot(x)).toEqual([
        { id: 'ca_gmail_A111', appSlug: 'gmail', appName: 'Gmail', name: null, label: 'Gmail · ca_…A111', status: 'active' },
        { id: 'ca_slack_S111', appSlug: 'slack', appName: 'Slack', name: null, label: 'Slack · ca_…S111', status: 'attention' },
      ]);
      expect(await outcome(world.service.forBot(randomUUID()))).toBe('BOT_NOT_FOUND');
    });

    it('a leitura do Composio que falha não grava nem esconde o que já está gravado (list e forBot propagam o erro seguro)', async () => {
      await world.service.list();
      await world.service.release('ca_gmail_A111', { botIds: [x], expectedVersion: 0 }, ORIGIN);
      world.state.failure = new DomainError('CONNECTOR_UNAVAILABLE');
      expect(await outcome(world.service.list())).toBe('CONNECTOR_UNAVAILABLE');
      expect(await outcome(world.service.forBot(x))).toBe('CONNECTOR_UNAVAILABLE');
      expect((await world.service.releasedTo(x)).map((item) => item.id)).toEqual(['ca_gmail_A111']); // a conferência da execução é só do banco
    });
  });

  // Remoção da conta desconectada (R8): o dono apaga a conta que o Composio não lista mais (reconectar o app gera outro id, então ela nunca voltaria). O serviço confere o estado na
  // leitura ao vivo, não na tela: só a conta AUSENTE dela é removível, e a leitura que falha não pode ser confundida com "a conta sumiu".
  describe('remoção da conta desconectada (R8)', () => {
    const remove = (id: string) => world.service.remove(id, ORIGIN);
    const accountRows = async () => (await pool.query<{ id: string }>('SELECT id FROM connector_accounts ORDER BY id')).rows.map((row) => row.id);
    const releaseRows = async (id: string) => (await pool.query<{ bot_id: string }>('SELECT bot_id FROM connector_account_bots WHERE account_id = $1', [id])).rows.length;
    /** Deixa "Pessoal" (Gmail A111) nomeada e liberada a X e Y, e a outra conta Gmail (B222) liberada a X, e depois o Composio deixa de listar a "Pessoal". */
    async function disconnectPessoal() {
      await world.service.list();
      await world.service.rename('ca_gmail_A111', { name: 'Pessoal', expectedVersion: 0 }, ORIGIN);
      await world.service.release('ca_gmail_A111', { botIds: [x, y], expectedVersion: 1 }, ORIGIN);
      await world.service.release('ca_gmail_B222', { botIds: [x], expectedVersion: 0 }, ORIGIN);
      world.state.live = world.state.live.filter((item) => item.id !== 'ca_gmail_A111');
      expect((await world.service.list()).find((view) => view.id === 'ca_gmail_A111')?.status).toBe('disconnected');
    }

    it('apaga a conta desconectada e as liberações dela, mantém as demais contas e libera o nome, e audita quem removeu sem o id inteiro nem a chave', async () => {
      await disconnectPessoal();
      await remove('ca_gmail_A111');

      expect(await accountRows()).toEqual(['ca_github_G222', 'ca_gmail_B222', 'ca_slack_S111']);
      expect(await releaseRows('ca_gmail_A111')).toBe(0);
      expect((await world.service.releasedTo(x)).map((released) => released.id)).toEqual(['ca_gmail_B222']); // a liberação da outra conta continua
      expect(await world.service.releasedTo(y)).toEqual([]);
      expect((await world.service.list()).map((view) => view.id)).not.toContain('ca_gmail_A111');
      // O nome "Pessoal" ficou livre para outra conta do mesmo app.
      expect(await outcome(world.service.rename('ca_gmail_B222', { name: 'Pessoal', expectedVersion: 1 }, ORIGIN))).toBe('ok');

      const events = await audits(pool, 'connector_account.remove');
      expect(events).toEqual([
        expect.objectContaining({ outcome: 'success', actor: 'owner', ip: ORIGIN.ip, user_agent: ORIGIN.userAgent, target: 'ca_…A111', details: { app: 'gmail', name: 'Pessoal', bots: 2 } }),
      ]);
      expect(JSON.stringify(await audits(pool))).not.toContain('ca_gmail_A111');
    });

    it('recusa a conta que o Composio ainda lista (ativa, pendente ou que requer atenção) com CONNECTOR_ACCOUNT_CONFLICT, sem apagar nada nem auditar', async () => {
      await world.service.list();
      await world.service.release('ca_gmail_A111', { botIds: [x], expectedVersion: 0 }, ORIGIN);
      world.state.live = [account('ca_gmail_A111', 'gmail', 'active'), account('ca_gmail_B222', 'gmail', 'pending'), account('ca_slack_S111', 'slack', 'attention')];
      const before = await accountRows();
      const auditCount = (await audits(pool)).length;

      for (const id of ['ca_gmail_A111', 'ca_gmail_B222', 'ca_slack_S111']) expect(await outcome(remove(id)), id).toBe('CONNECTOR_ACCOUNT_CONFLICT');

      expect(await accountRows()).toEqual(before);
      expect(await releaseRows('ca_gmail_A111')).toBe(1);
      expect(await audits(pool)).toHaveLength(auditCount);
    });

    it('conta que o Aion não conhece é NOT_FOUND (inclusive a já removida) e id fora do formato é VALIDATION_FAILED, sem auditar', async () => {
      await disconnectPessoal();
      expect(await outcome(remove('ca_inexistente'))).toBe('NOT_FOUND');
      expect(await outcome(remove('ca_x; DROP TABLE bots'))).toBe('VALIDATION_FAILED');
      expect(await outcome(remove('ca_gmail_A111'))).toBe('ok');
      expect(await outcome(remove('ca_gmail_A111'))).toBe('NOT_FOUND');
      expect(await audits(pool, 'connector_account.remove')).toHaveLength(1);
    });

    it('com a leitura do Composio falhando nada é apagado: a falha não vale como "a conta sumiu"', async () => {
      await disconnectPessoal();
      const before = await accountRows();
      for (const code of ['CONNECTOR_UNAVAILABLE', 'CONNECTOR_NOT_CONFIGURED', 'CONNECTOR_KEY_INVALID'] as const) {
        world.state.failure = new DomainError(code);
        expect(await outcome(remove('ca_gmail_A111')), code).toBe(code);
      }
      expect(await accountRows()).toEqual(before);
      expect(await releaseRows('ca_gmail_A111')).toBe(2);
      expect(await audits(pool, 'connector_account.remove')).toEqual([]);
    });

    it('leitura TRUNCADA (mais de 100 contas no Composio) recusa a remoção com CONNECTOR_UNAVAILABLE, sem apagar nem auditar, mesmo com a conta ausente da primeira página; list e a conta ativa não mudam (R9)', async () => {
      await disconnectPessoal();
      const before = await accountRows();
      world.state.truncated = true;

      // A conta ausente da primeira página PODE ser uma conta ativa além da 100ª: a leitura não prova que sumiu, então nada é removido.
      expect(await outcome(remove('ca_gmail_A111'))).toBe('CONNECTOR_UNAVAILABLE');
      expect(await outcome(remove('ca_gmail_B222'))).toBe('CONNECTOR_UNAVAILABLE');
      expect(await accountRows()).toEqual(before);
      expect(await releaseRows('ca_gmail_A111')).toBe(2);
      expect(await audits(pool, 'connector_account.remove')).toEqual([]);
      // O resto do serviço lê a mesma leitura truncada como sempre: a conta ausente segue aparecendo como desconectada, com nome e liberações.
      expect((await world.service.list()).find((view) => view.id === 'ca_gmail_A111')).toMatchObject({ status: 'disconnected', name: 'Pessoal', botIds: [x, y].sort() });

      // Com a leitura completa de novo, a mesma conta é removida.
      world.state.truncated = false;
      expect(await outcome(remove('ca_gmail_A111'))).toBe('ok');
      expect(await accountRows()).toEqual(before.filter((id) => id !== 'ca_gmail_A111'));
      expect(await audits(pool, 'connector_account.remove')).toHaveLength(1);
    });

    it('a conta removida que o Composio volta a listar reaparece como conta NOVA, sem nome nem liberação', async () => {
      await disconnectPessoal();
      await remove('ca_gmail_A111');

      world.state.live = [...world.state.live, account('ca_gmail_A111', 'gmail')];
      const back = (await world.service.list()).find((view) => view.id === 'ca_gmail_A111');
      expect(back).toEqual({ id: 'ca_gmail_A111', appSlug: 'gmail', appName: 'Gmail', name: null, label: 'Gmail · ca_…A111', status: 'active', botIds: [], version: 0 });
      expect(await world.service.releasedTo(x)).toEqual([expect.objectContaining({ id: 'ca_gmail_B222' })]);
    });

    it('duas remoções da mesma conta ao mesmo tempo: uma apaga e a outra recebe NOT_FOUND (trava de banco)', async () => {
      await disconnectPessoal();
      const results = await Promise.all([outcome(remove('ca_gmail_A111')), outcome(remove('ca_gmail_A111'))]);
      expect(results.sort()).toEqual(['NOT_FOUND', 'ok']);
      expect(await audits(pool, 'connector_account.remove')).toHaveLength(1);
    });
  });

  it('excluir o bot pelo banco remove as liberações dele e mantém as dos outros (cascata das chaves)', async () => {
    await world.service.list();
    await world.service.release('ca_gmail_A111', { botIds: [x, y], expectedVersion: 0 }, ORIGIN);
    await pool.query('DELETE FROM bots WHERE id = $1', [x]);
    expect((await world.service.list()).find((view) => view.id === 'ca_gmail_A111')!.botIds).toEqual([y]);
  });
});
