// Smoke / walking skeleton de T1: sobe a API e o worker REAIS (bundles de produção) contra o PostgreSQL de
// teste e confere o que só o processo de verdade prova: build do bundle, migrations na inicialização,
// `/api/health`, conexão do worker à fila, falha fechada sem variáveis e ausência de segredos nos logs.
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { TableColumn, TableRecord } from '@aion/shared';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PING_QUEUE, createBoss, createPool } from '@aion/core';
import { tableMarker, tableCopyMarker, type TableCopyRecipe } from '@aion/core/testing';
import { createTestDatabase, freePort, pythonMarker, startFakeSandbox, startFakeUpstreams, type FakeSandbox, type FakeUpstreams, docxFixture, pdfFixture, xlsxFixture, type TestDatabase } from '@aion/core/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runPnpm, spawnNode, waitUntil, type ManagedProcess } from './support/processes';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OWNER = { email: 'dono@aion.test', password: 'senha-de-teste-do-dono-1' };
const MASTER_KEY = Buffer.alloc(32, 3).toString('base64');
/** Trecho da resposta semeada que vira a prévia da lista de bots (phase 5, T5) e que nenhum log pode conter. */
const SMOKE_PREVIEW_SOURCE = 'Resumo de teste do smoke';
const ORIGIN = 'http://localhost:3000';

let database: TestDatabase;
let upstreams: FakeUpstreams;
let port: number;
let apiEnv: Record<string, string>;
let sandbox: FakeSandbox | undefined;
const running: ManagedProcess[] = [];

/** HTTP cru (o fetch do Node não deixa controlar o cabeçalho Origin como um navegador faria). */
function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, endpointPort = port) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string; bytes: Buffer }>(
    (resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
      const req = request(
        {
          host: '127.0.0.1',
          port: endpointPort,
          path,
          method,
          headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const bytes = Buffer.concat(chunks);
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: bytes.toString('utf8'), bytes });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    },
  );
}

beforeAll(async () => {
  // Bundles de produção: se o build quebrar (dependência que não empacota, import errado), o smoke falha aqui.
  runPnpm(['--filter', '@aion/api', '--filter', '@aion/worker', 'build'], ROOT);
  // Usage proporcional ao corpo: o worker real calibra a estimativa de contexto como em produção (com o valor fixo do falso, implausível, ele nunca calibra e a
  // rodada longa das rotinas seria compactada por uma estimativa 3,5 vezes acima do real).
  upstreams = await startFakeUpstreams({ realisticUsage: true });
  database = await createTestDatabase(inject('adminDatabaseUrl'));
  port = await freePort();
  apiEnv = {
    NODE_ENV: 'production',
    PORT: String(port),
    DATABASE_URL: database.url,
    AION_OWNER_EMAIL: OWNER.email,
    AION_OWNER_PASSWORD: OWNER.password,
    AION_MASTER_KEY: MASTER_KEY,
    AION_PUBLIC_ORIGIN: ORIGIN,
    // Banco descartável precisa do schema final: liga a permissão da migration destrutiva 0028 (remove `bots.mascot`). O padrão de produção continua `false`.
    AION_ALLOW_DESTRUCTIVE_MIGRATIONS: 'true',
    AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl,
    AION_ANTHROPIC_BASE_URL: upstreams.anthropicBaseUrl,
    // Pesquisa na web (phase 1, T8): endereço da Parallel em loopback (aceito pela regra de https ou loopback); nenhuma chamada sai dele no smoke.
    AION_PARALLEL_BASE_URL: 'http://127.0.0.1:9/mcp',
  };
});

afterAll(async () => {
  await Promise.all(running.map((process) => process.stop()));
  await database?.drop();
  await upstreams?.stop();
  await sandbox?.stop();
});

/**
 * O id de um registro como o `table_query` o mostra ao modelo: o começo de 8 caracteres do UUID (o menor tamanho da forma, TAB-03; vira mais longo só se dois registros do
 * mesmo resultado começarem igual, o que UUIDs aleatórios quase nunca fazem). O roteiro da rotina usa esse id curto na chave de deduplicação, então a prova calcula a mesma chave.
 */
const shownId = (record: { id: string }): string => record.id.slice(0, 8);

describe('api e worker reais', () => {
  it('rotinas geram ausentes em tabelas genéricas, retomam após commit e preservam pagamentos e mudanças prospectivas', async () => {
    const db = await createTestDatabase(inject('adminDatabaseUrl'));
    const localPort = await freePort();
    const preload = new URL('./support/fixed-clock.mjs', import.meta.url).href;
    const environment = { ...apiEnv, DATABASE_URL: db.url, PORT: String(localPort), AION_SMOKE_FIXED_NOW: '2027-02-01T11:59:00Z' };
    const api = spawnNode(['--import', preload, 'dist/main.js'], { cwd: `${ROOT}apps/api`, env: environment });
    const pool = createPool(db.url, { applicationName: 'smoke-recurring-tables', max: 1 });
    const workers: ManagedProcess[] = [];
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => http(method, path, body, headers, localPort);
    try {
      await api.waitForOutput(/api no ar/);
      const login = await call('POST', '/api/auth/login', OWNER, { origin: ORIGIN });
      const cookie = String(login.headers['set-cookie']).match(/aion_session=[^;]+/)?.[0] ?? '';
      const csrf = JSON.parse((await call('GET', '/api/auth/session', undefined, { cookie })).body).csrfToken as string;
      const write = { cookie, origin: ORIGIN, 'x-csrf-token': csrf };
      /** Cada etapa passa pela API autenticada; SQL abaixo apenas observa estado e controla a lease do restart. */
      const json = async (method: string, path: string, body?: unknown) => {
        const response = await call(method, path, body, write);
        expect(response.status, `${method} ${path}: ${response.body}`).toBeLessThan(300);
        return JSON.parse(response.body) as { id: string; columns: TableColumn[]; records: TableRecord[]; occurrences: string[]; nextRunAt: string; totalCount: number };
      };
      await json('POST', '/api/credentials/provider', { key: 'valid-smoke-recurring' });
      const bot = await json('POST', '/api/bots', { name: 'Trabalho periódico', color: '#60A5FA', model: 'opencode/glm-5.1' });
      const source = await json('POST', `/api/bots/${bot.id}/tables`, { operationId: randomUUID(), name: 'Recorrências', columns: [{ name: 'Descrição', type: 'text' }, { name: 'Ativa', type: 'boolean' }, { name: 'Valor', type: 'money', currency: 'BRL' }] });
      const [title, active, amount] = source.columns.map((column: { id: string }) => column.id) as string[];
      const seeded = await json('POST', `/api/tables/${source.id}/records`, { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [
        { values: { [title!]: 'Entrada', [active!]: true, [amount!]: '1200.1' } },
        { values: { [title!]: 'Parcela de saída', [active!]: true, [amount!]: '-99.9' } },
        { values: { [title!]: 'Variável pendente', [active!]: true, [amount!]: null } },
        { values: { [title!]: 'Inativa', [active!]: false, [amount!]: '50' } },
      ] });
      const target = await json('POST', `/api/bots/${bot.id}/tables`, { operationId: randomUUID(), name: 'Lançamentos', columns: [{ name: 'Recorrência', type: 'relation', targetTableId: source.id, cardinality: 'one' }, { name: 'Período', type: 'text' }, { name: 'Descrição', type: 'text' }, { name: 'Previsto', type: 'money', currency: 'BRL' }, { name: 'Pago', type: 'boolean' }, { name: 'Efetivo', type: 'money', currency: 'BRL' }] });
      const [relation, period, label, planned, paid, effective] = target.columns.map((column: { id: string }) => column.id) as string[];
      const paidValues = { [relation!]: seeded.records[0]!.id, [period!]: '2027-02', [label!]: 'Entrada já paga', [planned!]: '1200.1', [paid!]: true, [effective!]: '1199.9' };
      const paidRecord = (await json('POST', `/api/tables/${target.id}/records`, { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [{ values: paidValues, deduplicationKey: `${shownId(seeded.records[0]!)}/2027-02` }] })).records[0]!;
      const recipe: TableCopyRecipe = { sourceId: source.id, targetId: target.id, activeColumn: active!, requiredColumns: [amount!], mappings: { [label!]: title!, [planned!]: amount! }, targetSourceColumn: relation!, targetPeriodColumn: period!, period: '2027-02', defaults: { [paid!]: false, [effective!]: null }, operationId: randomUUID(), pauseAfterWriteMs: 5000 };
      const settings = { schedule: { type: 'monthly_business_day', position: 1, time: '09:00' }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null };
      const preview = await json('POST', '/api/routines/preview', settings);
      const routine = await json('POST', '/api/routines', { ...settings, botId: bot.id, name: 'Gerar lançamentos ausentes', instruction: tableCopyMarker(recipe) });
      expect(routine.nextRunAt).toBe(preview.occurrences[0]);
      /** Muda só o relógio do processo descartável; scheduler e executor permanecem os de produção. */
      const startWorker = async (at: string) => {
        const worker = spawnNode(['--import', preload, 'dist/main.js'], { cwd: `${ROOT}apps/worker`, env: { ...environment, AION_SMOKE_FIXED_NOW: at } });
        workers.push(worker); await worker.waitForOutput(/worker no ar/); return worker;
      };
      let worker = await startWorker('2027-02-01T12:00:30Z');
      await waitUntil(async () => (await pool.query("SELECT 1 FROM messages m JOIN runs r ON r.id=m.run_id WHERE r.routine_id=$1 AND m.kind='activity' AND m.data->>'tool'='table_write' AND m.status='completed'", [routine.id])).rowCount === 1, { description: 'commit da tool real antes da resposta final' });
      await worker.stop();
      expect((await pool.query("SELECT 1 FROM runs WHERE routine_id=$1 AND status='running'", [routine.id])).rowCount).toBe(1);
      await pool.query("UPDATE runs SET lease_until=now()-interval '1 second' WHERE routine_id=$1 AND status='running'", [routine.id]);
      worker = await startWorker('2027-02-01T12:00:30Z');
      await waitUntil(async () => (await pool.query("SELECT 1 FROM runs WHERE routine_id=$1 AND status='completed'", [routine.id])).rowCount === 1, { description: 'retomada da rodada com leituras e escrita persistidas' });
      const february = await json('POST', `/api/tables/${target.id}/query`, {});
      expect(february.totalCount).toBe(2);
      expect(february.records.find((row: { id: string }) => row.id === paidRecord.id)!.values).toEqual(paidValues);
      const generated = february.records.find((row: { id: string }) => row.id !== paidRecord.id)!;
      // O roteiro só viu o id curto da origem no pedido; a relação gravada é o UUID completo do registro de origem, resolvido pelo servidor na tabela de destino da coluna.
      expect(generated.values).toMatchObject({ [relation!]: seeded.records[1]!.id, [planned!]: '-99.9', [paid!]: false, [effective!]: null });
      const unpaid = await json('POST', `/api/tables/${target.id}/query`, { filter: { op: 'eq', columnId: paid!, value: false } });
      expect(unpaid.records.map((row) => row.id)).toEqual([generated.id]);
      // O dono registra pagamento depois; replay da chave com o conteúdo original deve manter o novo pagamento.
      await json('POST', `/api/tables/${target.id}/records`, { operationId: randomUUID(), expectedSchemaVersion: 1, updates: [{ id: generated.id, expectedVersion: generated.version, values: { [paid!]: true, [effective!]: '-98.5' } }] });
      await json('POST', `/api/tables/${target.id}/records`, { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [{ values: generated.values, deduplicationKey: `${shownId(seeded.records[1]!)}/2027-02` }] });
      const replay = await json('POST', `/api/routines/${routine.id}/run`, {});
      await waitUntil(async () => (await pool.query("SELECT 1 FROM runs WHERE id=$1 AND status='completed'", [replay.id])).rowCount === 1, { description: 'repetição consulta existentes sem duplicar' });
      expect((await json('POST', `/api/tables/${target.id}/query`, {})).totalCount).toBe(2);
      await worker.stop();
      await json('POST', `/api/tables/${source.id}/records`, { operationId: randomUUID(), expectedSchemaVersion: 1, updates: [{ id: seeded.records[1]!.id, expectedVersion: 1, values: { [amount!]: '-109.9' } }] });
      await json('PUT', `/api/routines/${routine.id}`, { ...settings, botId: bot.id, name: 'Gerar lançamentos ausentes', instruction: tableCopyMarker({ ...recipe, period: '2027-03', operationId: randomUUID(), pauseAfterWriteMs: 0 }) });
      worker = await startWorker('2027-03-01T12:00:30Z');
      await waitUntil(async () => (await pool.query("SELECT 1 FROM routine_occurrences o JOIN runs r ON r.id=o.run_id WHERE o.routine_id=$1 AND o.scheduled_for=$2 AND r.status='completed'", [routine.id, '2027-03-01T12:00:00Z'])).rowCount === 1, { description: 'próximo período com configuração atual' });
      const march = await json('POST', `/api/tables/${target.id}/query`, {});
      expect(march.totalCount).toBe(4);
      expect(march.records.find((row: { id: string }) => row.id === generated.id)!.values).toMatchObject({ [planned!]: '-99.9', [paid!]: true, [effective!]: '-98.5' });
      expect(march.records.find((row: { values: Record<string, unknown> }) => row.values[relation!] === seeded.records[1]!.id && row.values[period!] === '2027-03')!.values[planned!]).toBe('-109.9');
      expect((await pool.query("SELECT content FROM messages m JOIN runs r ON r.id=m.run_id WHERE r.routine_id=$1 AND m.role='assistant' AND m.kind='text'", [routine.id])).rows.map((row) => row.content).join('\n')).toContain('Pendências sem valor obrigatório: 1');
      await worker.stop();
      // Mesmo roteiro em domínio não financeiro: tarefas periódicas, sem valores/pagamentos ou política de negócio no core.
      const tasks = await json('POST', `/api/bots/${bot.id}/tables`, { operationId: randomUUID(), name: 'Tarefas', columns: [{ name: 'Modelo', type: 'relation', targetTableId: source.id, cardinality: 'one' }, { name: 'Semana', type: 'text' }, { name: 'Título', type: 'text' }, { name: 'Concluída', type: 'boolean' }] });
      const [taskSource, taskPeriod, taskTitle, done] = tasks.columns.map((column: { id: string }) => column.id) as string[];
      const taskRecipe: TableCopyRecipe = { sourceId: source.id, targetId: tasks.id, activeColumn: active!, requiredColumns: [title!], mappings: { [taskTitle!]: title! }, targetSourceColumn: taskSource!, targetPeriodColumn: taskPeriod!, period: 'Semana 9', defaults: { [done!]: false }, operationId: randomUUID() };
      const taskRoutine = await json('POST', '/api/routines', { ...settings, schedule: { type: 'once', at: '2027-03-01T09:05' }, botId: bot.id, name: 'Tarefas genéricas', instruction: tableCopyMarker(taskRecipe) });
      worker = await startWorker('2027-03-01T12:05:30Z');
      await waitUntil(async () => (await pool.query("SELECT 1 FROM runs WHERE routine_id=$1 AND status='completed'", [taskRoutine.id])).rowCount === 1, { description: 'tarefa genérica no worker real' });
      const taskRows = await json('POST', `/api/tables/${tasks.id}/query`, {});
      expect(taskRows.totalCount).toBe(3);
      expect(taskRows.records.every((row: { values: Record<string, unknown> }) => row.values[done!] === false)).toBe(true);
      // Cada tarefa aponta, pelo UUID completo, para um registro ativo da origem (o modelo só leu o id curto no pedido).
      expect(taskRows.records.map((row) => row.values[taskSource!]).sort()).toEqual(seeded.records.slice(0, 3).map((record) => record.id).sort());
      expect((await pool.query("SELECT count(*)::int AS n FROM messages m JOIN runs r ON r.id=m.run_id WHERE r.routine_id=$1 AND m.kind='activity' AND m.data->>'tool'='table_write'", [routine.id])).rows[0]?.n).toBe(2);
    } finally {
      await Promise.all(workers.map((worker) => worker.stop())); await api.stop(); await pool.end(); await db.drop();
    }
  });
  it('prévia da API e disparo do worker concordam no dia útil e no mensal ajustado, sem aguardar meses', async () => {
    const db = await createTestDatabase(inject('adminDatabaseUrl'));
    const localPort = await freePort();
    const preload = new URL('./support/fixed-clock.mjs', import.meta.url).href;
    const environment = { ...apiEnv, DATABASE_URL: db.url, PORT: String(localPort), AION_SMOKE_FIXED_NOW: '2027-02-01T11:59:00Z' };
    const api = spawnNode(['--import', preload, 'dist/main.js'], { cwd: `${ROOT}apps/api`, env: environment });
    const pool = createPool(db.url, { applicationName: 'smoke-civil-calendar', max: 1 });
    const workers: ManagedProcess[] = [];
    /** O endpoint é independente do smoke anterior, para nenhum worker consumir estas ocorrências. */
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => http(method, path, body, headers, localPort);
    try {
      await api.waitForOutput(/api no ar/);
      const login = await call('POST', '/api/auth/login', OWNER, { origin: ORIGIN });
      expect(login.status).toBe(200);
      const cookie = String(login.headers['set-cookie']).match(/aion_session=[^;]+/)?.[0] ?? '';
      const csrf = JSON.parse((await call('GET', '/api/auth/session', undefined, { cookie })).body).csrfToken as string;
      const write = { cookie, origin: ORIGIN, 'x-csrf-token': csrf };
      expect((await call('POST', '/api/credentials/provider', { key: 'valid-smoke-civil' }, write)).status).toBe(200);
      const botResponse = await call('POST', '/api/bots', { name: 'Agenda civil', color: '#60A5FA', model: 'opencode/glm-5.1' }, write);
      expect(botResponse.status).toBe(201);
      const botId = JSON.parse(botResponse.body).id as string;
      const agendas = [
        { schedule: { type: 'monthly_business_day', position: 1, time: '09:00' }, expected: '2027-02-01T12:00:00.000Z', maxRuns: 1 },
        { schedule: { type: 'monthly_day', day: 31, time: '09:00' }, expected: '2027-02-28T12:00:00.000Z', maxRuns: 2 },
      ];
      const routines: string[] = [];
      for (const agenda of agendas) {
        const settings = { schedule: agenda.schedule, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: agenda.maxRuns };
        const previewResponse = await call('POST', '/api/routines/preview', settings, write);
        expect(previewResponse.status).toBe(200);
        const preview = JSON.parse(previewResponse.body) as { valid: boolean; occurrences: string[] };
        expect(preview.valid).toBe(true);
        expect(preview.occurrences[0]).toBe(agenda.expected);
        const created = await call('POST', '/api/routines', { ...settings, botId, name: 'Agenda civil', instruction: 'Resuma o dia' }, write);
        expect(created.status).toBe(201);
        const routine = JSON.parse(created.body) as { id: string; nextRunAt: string };
        expect(routine.nextRunAt).toBe(preview.occurrences[0]);
        routines.push(routine.id);
      }
      for (const [index, agenda] of agendas.entries()) {
        const worker = spawnNode(['--import', preload, 'dist/main.js'], { cwd: `${ROOT}apps/worker`, env: { ...environment, AION_SMOKE_FIXED_NOW: new Date(Date.parse(agenda.expected) + 30_000).toISOString() } });
        workers.push(worker);
        await worker.waitForOutput(/worker no ar/);
        await waitUntil(async () => (await pool.query("SELECT 1 FROM routine_occurrences o JOIN runs r ON r.id = o.run_id WHERE o.routine_id = $1 AND r.status = 'completed'", [routines[index]])).rowCount === 1, { description: 'ocorrência civil completada pelo worker real' });
        const occurrences = await pool.query<{ scheduled_for: Date }>('SELECT scheduled_for FROM routine_occurrences WHERE routine_id = $1', [routines[index]]);
        expect(occurrences.rows.map((row) => row.scheduled_for.toISOString())).toEqual([agenda.expected]);
        await worker.stop();
      }
      const monthly = await pool.query<{ next_run_at: Date }>('SELECT next_run_at FROM routines WHERE id = $1', [routines[1]]);
      expect(monthly.rows[0]?.next_run_at.toISOString()).toBe('2027-03-31T12:00:00.000Z');
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
      await api.stop();
      await pool.end();
      await db.drop();
    }
  });
  it('a api sobe, migra o banco, responde /api/health com cabeçalhos e aceita login sem vazar segredos', async () => {
    const api = spawnNode(['dist/main.js'], { cwd: `${ROOT}apps/api`, env: apiEnv });
    running.push(api);
    await api.waitForOutput(/api no ar/);

    // Saúde pública, com os cabeçalhos de segurança da produção.
    const health = await http('GET', '/api/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: 'ok' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['permissions-policy']).toBe('camera=(), microphone=(self), geolocation=()');
    expect(health.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(health.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    // A origin pública do smoke é http, então sem HSTS; com https ele existe (coberto em security.test).
    expect(health.headers['strict-transport-security']).toBeUndefined();

    // As migrations rodaram na subida (e a fila do pg-boss ainda não existe: é o worker que cria).
    const pool = createPool(database.url, { applicationName: 'smoke-check', max: 1 });
    try {
      const migrated = await pool.query<{ id: string }>('SELECT id FROM schema_migrations');
      expect(migrated.rows.map((row) => row.id)).toEqual(expect.arrayContaining(['0001_auth_foundation', '0017_web_search_settings', '0018_bot_mascot', '0020_model_image_support', '0024_complements', '0028_drop_bot_mascot']));
    } finally {
      await pool.end();
    }

    // Login errado e certo pelo processo real, sem sessão vazando senha.
    const wrong = await http('POST', '/api/auth/login', { email: OWNER.email, password: 'senha-errada-qualquer' }, { origin: ORIGIN });
    expect(wrong.status).toBe(401);
    const right = await http('POST', '/api/auth/login', { email: OWNER.email, password: OWNER.password }, { origin: ORIGIN });
    expect(right.status).toBe(200);
    expect(String(right.headers['set-cookie'])).toContain('HttpOnly');

    // Pesquisa na web (T8): a migration 0017 criou a coluna do interruptor, e a rota autenticada responde com o padrão (ligada, sem chave) sem chamar a Parallel.
    const sessionCookie = String(right.headers['set-cookie']).match(/aion_session=[^;]+/)?.[0] ?? '';
    const webSearch = await http('GET', '/api/settings/web-search', undefined, { cookie: sessionCookie });
    expect(webSearch.status).toBe(200);
    expect(JSON.parse(webSearch.body)).toEqual({ enabled: true, key: { kind: 'web_search', configured: false, masked: null, updatedAt: null, modelCount: null } });
    // Python (phase 4, T7): sem a configuração do sandbox, a API real responde "não instalado" sem chamar nada.
    const python = await http('GET', '/api/settings/python', undefined, { cookie: sessionCookie });
    expect([python.status, JSON.parse(python.body)]).toEqual([200, { status: 'not_installed' }]);

    // T5: processo empacotado resolve a entrada de thread em dist e extrai sem node_modules/nativos.
    const csrf = JSON.parse((await http('GET', '/api/auth/session', undefined, { cookie: sessionCookie })).body).csrfToken as string;
    // Phase 8: bundle real migra e grava um escopo sem perder o outro ou as preferências anteriores.
    const contextHeaders = { cookie: sessionCookie, origin: ORIGIN, 'x-csrf-token': csrf };
    expect(JSON.parse((await http('GET', '/api/settings/context', undefined, contextHeaders)).body)).toEqual({ bots: 262144, generalChat: 262144, summaryModel: null }); // padrão 256k (migration 0046); modelo do resumo nulo = o da conversa (phase 9, T4)
    // Phase 11: 32k saiu das opções (o bundle real recusa com 422 e nada muda); 64k e 512k são aceitos, e a escolha de um escopo não mexe no outro.
    expect((await http('PUT', '/api/settings/context', { scope: 'bots', windowTokens: 32768 }, contextHeaders)).status).toBe(422);
    expect((await http('PUT', '/api/settings/context', { scope: 'bots', windowTokens: 65536 }, contextHeaders)).status).toBe(200);
    expect((await http('PUT', '/api/settings/context', { scope: 'general_chat', windowTokens: 524288 }, contextHeaders)).status).toBe(200);
    expect(JSON.parse((await http('GET', '/api/settings/context', undefined, contextHeaders)).body)).toEqual({ bots: 65536, generalChat: 524288, summaryModel: null });
    expect((await http('PUT', '/api/settings/context', { scope: 'bots', windowTokens: 262144 }, contextHeaders)).status).toBe(200);
    expect((await http('PUT', '/api/settings/context', { scope: 'general_chat', windowTokens: 262144 }, contextHeaders)).status).toBe(200);
    // T6: a API real aplica a migration de visão e publica a sonda sob sessão e CSRF.
    expect((await http('POST', '/api/credentials/provider', { key: 'valid-smoke-provider-image' }, { cookie: sessionCookie, origin: ORIGIN, 'x-csrf-token': csrf })).status).toBe(200);
    const vision = await http('POST', '/api/models/verify-image', { model: 'opencode/vision-model' }, { cookie: sessionCookie, origin: ORIGIN, 'x-csrf-token': csrf });
    expect(vision.status).toBe(200);
    expect(JSON.parse(vision.body).acceptsImages).toBe(true);
    const attachmentSession = JSON.parse((await http('POST', '/api/chat/sessions', {}, { cookie: sessionCookie, origin: ORIGIN, 'x-csrf-token': csrf })).body).id as string;
    const attachmentIds: string[] = [];
    for (const [name, document] of [['relatório-😀.pdf', pdfFixture()], ['relatório-😀.docx', docxFixture()]] as const) {
      const response = await http('POST', `/api/chat/sessions/${attachmentSession}/attachments`, document, { cookie: sessionCookie, origin: ORIGIN, 'x-csrf-token': csrf, 'content-type': 'application/octet-stream', 'x-attachment-name': encodeURIComponent(name) });
      expect(response.status).toBe(201);
      const attachment = JSON.parse(response.body) as { id: string; kind: string };
      attachmentIds.push(attachment.id);
      expect(attachment.kind).toBe('document');
      const content = await http('GET', `/api/chat/sessions/${attachmentSession}/attachments/${attachment.id}/content`, undefined, { cookie: sessionCookie });
      expect(content.status).toBe(200); expect(content.body).toContain('Documento');
      expect(content.headers['cache-control']).toBe('no-store');
      expect(content.headers['content-disposition']).toContain('.txt');
    }
    // T7: a borda empacotada liga documentos à fila sem enviar o texto extraído na resposta.
    expect((await http('PATCH', `/api/chat/sessions/${attachmentSession}/conversation`, { model: 'opencode/vision-model', effort: null }, { cookie: sessionCookie, origin: ORIGIN, 'x-csrf-token': csrf })).status).toBe(200);
    const queued = await http('POST', `/api/chat/sessions/${attachmentSession}/messages`, { content: 'Confira os documentos', attachmentIds }, { cookie: sessionCookie, origin: ORIGIN, 'x-csrf-token': csrf });
    expect(queued.status).toBe(201);
    expect(JSON.parse(queued.body).attachments.map((file: { id: string }) => file.id)).toEqual(attachmentIds);
    expect(queued.body).not.toContain('Documento PDF de teste');

    // Bot sem personagem (phase 5, T2): a migration 0028 já estava aplicada na subida (o smoke liga a permissão), então a coluna `bots.mascot` não existe e o
    // bot sai da API real sem o campo. Prévia da última novidade (phase 5, T5): a lista da API real traz a primeira linha da última resposta final, sem Markdown, e o
    // texto da conversa não vai a nenhum log. O bot, a conversa e a mensagem semeados saem ao fim.
    const seedPool = createPool(database.url, { applicationName: 'smoke-bot-list', max: 1 });
    try {
      expect((await seedPool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'bots' AND column_name = 'mascot'")).rowCount).toBe(0);
      const seeded = await seedPool.query<{ id: string }>("INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ('Smoke bot', 'smoke bot', '#60A5FA', now(), now()) RETURNING id");
      const botId = seeded.rows[0]!.id;
      await seedPool.query('INSERT INTO conversations (bot_id, created_at) VALUES ($1, now())', [botId]);
      await seedPool.query(
        "INSERT INTO messages (conversation_id, role, kind, status, step, content, data, created_at) SELECT c.id, 'assistant', 'text', 'done', 1, $2, '{}', now() FROM conversations c WHERE c.bot_id = $1",
        [botId, `## **${SMOKE_PREVIEW_SOURCE}**: veja o [anexo](https://exemplo.com/a)\nsegunda linha que não aparece`],
      );
      const listed = await http('GET', '/api/bots', undefined, { cookie: sessionCookie });
      expect(listed.status).toBe(200);
      const bots = (JSON.parse(listed.body) as { bots: Record<string, unknown>[] }).bots;
      expect(bots).toEqual([expect.objectContaining({ name: 'Smoke bot', color: '#60A5FA', preview: `${SMOKE_PREVIEW_SOURCE}: veja o anexo` })]);
      expect(Object.keys(bots[0] ?? {})).not.toContain('mascot');
    } finally {
      await seedPool.query("DELETE FROM messages WHERE conversation_id IN (SELECT c.id FROM conversations c JOIN bots b ON b.id = c.bot_id WHERE b.name_key = 'smoke bot')");
      await seedPool.query("DELETE FROM conversations WHERE bot_id IN (SELECT id FROM bots WHERE name_key = 'smoke bot')");
      await seedPool.query("DELETE FROM bots WHERE name_key = 'smoke bot'");
      await seedPool.end();
    }

    // Nada de segredo na saída (logs) do processo.
    const logs = api.output();
    for (const secret of [OWNER.password, MASTER_KEY, 'senha-errada-qualquer', 'relatório-😀', encodeURIComponent('relatório-😀.pdf'), 'Documento PDF de teste', 'Documento de teste', SMOKE_PREVIEW_SOURCE, 'segunda linha que não aparece']) expect(logs).not.toContain(secret);
  });

  it('o worker conecta à fila e conclui um job de ping', async () => {
    // Phase 4 (T7): o worker empacotado recebe o sandbox (aqui o falso, o mesmo HTTP do serviço real) e passa a oferecer `run_python`.
    sandbox = await startFakeSandbox();
    const worker = spawnNode(['dist/main.js'], {
      cwd: `${ROOT}apps/worker`,
      env: {
        NODE_ENV: 'production', DATABASE_URL: database.url, AION_MASTER_KEY: MASTER_KEY, AION_PARALLEL_BASE_URL: apiEnv.AION_PARALLEL_BASE_URL!, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl,
        AION_ANTHROPIC_BASE_URL: upstreams.anthropicBaseUrl,
        AION_SANDBOX_URL: sandbox.url, AION_SANDBOX_TOKEN: sandbox.token,
      },
    });
    running.push(worker);
    await worker.waitForOutput(/worker conectado à fila/);
    // Claim no bundle real liga os arquivos à mensagem, não só à execução enfileirada pela API.
    const pool = createPool(database.url, { applicationName: 'smoke-attachment-claim', max: 1 });
    try {
      await waitUntil(async () => (await pool.query<{ total: number }>('SELECT count(*)::int AS total FROM attachments WHERE message_id IS NOT NULL')).rows[0]?.total === 2, {
        description: 'worker ligar os anexos à mensagem', timeoutMs: 30_000,
      });
    } finally { await pool.end(); }

    // Phase 4 (T2, F5): pelos processos reais, enviar com a execução ativa vira complemento (sem interromper o streaming), e o desfecho com o
    // complemento pendente o promove a uma execução nova, que o worker roda até a resposta.
    const login = await http('POST', '/api/auth/login', { email: OWNER.email, password: OWNER.password }, { origin: ORIGIN });
    const cookie = String(login.headers['set-cookie']).match(/aion_session=[^;]+/)?.[0] ?? '';
    const csrf = JSON.parse((await http('GET', '/api/auth/session', undefined, { cookie })).body).csrfToken as string;
    const write = { cookie, origin: ORIGIN, 'x-csrf-token': csrf };
    // Tabelas pela API empacotada: a migration, composição de rotas e persistência não dependem de app.inject.
    const tableBot = JSON.parse((await http('POST', '/api/bots', { name: 'Bot de tabelas smoke', color: '#60A5FA', model: 'opencode/glm-5.1', effort: null }, write)).body) as { id: string };
    // Phase 8: worker empacotado usa evidências materializadas, persiste cartão/objetivo e o dono desfaz pela borda real.
    const objectiveBot = JSON.parse((await http('POST', '/api/bots', { name: 'Bot de objetivo smoke', color: '#60A5FA', model: 'opencode/glm-5.1' }, write)).body) as { id: string };
    expect((await http('POST', `/api/bots/${objectiveBot.id}/messages`, { content: '[objetivo:Direção contínua sintética do smoke.]' }, write)).status).toBe(201);
    await waitUntil(async () => JSON.parse((await http('GET', `/api/bots/${objectiveBot.id}/objective`, undefined, { cookie })).body).version === 1, { description: 'worker real grava objetivo', timeoutMs: 30000 });
    const objectiveSnapshot = JSON.parse((await http('GET', `/api/bots/${objectiveBot.id}/conversation`, undefined, { cookie })).body) as { items: { id: string; kind: string; card?: { type: string } }[] };
    const objectiveCard = objectiveSnapshot.items.find((item) => item.card?.type === 'objective_updated')!;
    expect(objectiveCard).toBeDefined();
    const undoObjective = `/api/bots/${objectiveBot.id}/objective/cards/${objectiveCard.id}/undo`;
    expect(JSON.parse((await http('POST', undoObjective, { expectedVersion: 1 }, write)).body)).toMatchObject({ content: '', version: 2 });
    expect(JSON.parse((await http('POST', undoObjective, { expectedVersion: 1 }, write)).body)).toMatchObject({ version: 2 });
    const tableResponse = await http('POST', `/api/bots/${tableBot.id}/tables`, { operationId: randomUUID(), name: 'Tabela smoke', columns: [{ name: 'Dinheiro', type: 'money', currency: 'BRL' }] }, write);
    expect(tableResponse.status).toBe(201);
    const table = JSON.parse(tableResponse.body) as { id: string; columns: { id: string }[] };
    const tableValues = { [table.columns[0]!.id]: '0.1' };
    expect((await http('POST', `/api/tables/${table.id}/records`, { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [{ values: tableValues }] }, write)).status).toBe(200);
    const tableRead = await http('GET', `/api/tables/${table.id}/records`, undefined, { cookie });
    expect(tableRead.status).toBe(200);
    expect(JSON.parse(tableRead.body)).toMatchObject({ records: [{ version: 1, values: tableValues }] });
    // T3: vista e NUMERIC calculado atravessam rota/bundle/migration reais sem copiar registros.
    const formula = { kind: 'call', op: 'MULTIPLY', args: [{ kind: 'ref', columnId: table.columns[0]!.id }, { kind: 'literal', type: 'number', value: '2' }] };
    const configuredTable = await http('PATCH', `/api/tables/${table.id}`, { operationId: randomUUID(), expectedSchemaVersion: 1, columns: [...table.columns, { name: 'Dobro', type: 'calculated', resultType: 'money', currency: 'BRL', formula }] }, write);
    expect(configuredTable.status).toBe(200);
    const calculatedColumn = (JSON.parse(configuredTable.body) as { columns: { id: string }[] }).columns[1]!.id;
    const viewResponse = await http('POST', `/api/tables/${table.id}/views`, { operationId: randomUUID(), name: 'Calculada smoke', columns: [calculatedColumn], filter: { op: 'eq', columnId: calculatedColumn, value: '0.2' } }, write);
    expect(viewResponse.status).toBe(201);
    const viewId = (JSON.parse(viewResponse.body) as { id: string }).id;
    const tableQuery = await http('POST', `/api/tables/${table.id}/query`, { viewId, aggregate: [{ alias: 'Total', op: 'sum', columnId: calculatedColumn }] }, write);
    expect(tableQuery.status).toBe(200);
    expect(JSON.parse(tableQuery.body)).toMatchObject({ records: [{ values: { [calculatedColumn]: '0.2' } }], aggregate: { Total: '0.2' }, totalCount: 1, hasMore: false, nextCursor: null });
    // T4: catálogo padrão no worker empacotado cria/consulta e passa pelo cartão real antes de excluir.
    const tablesPool = createPool(database.url, { applicationName: 'smoke-table-tools', max: 1 });
    try {
      /** Envia chamada pelo provedor falso, mas toda autorização/execução ocorre nos bundles reais. */
      const runTableTool = async (name: string, args: unknown, status = 'completed') => {
        const sent = await http('POST', `/api/bots/${tableBot.id}/messages`, { content: tableMarker(name, args) }, write);
        expect({ status: sent.status, body: sent.status === 201 ? undefined : sent.body }).toMatchObject({ status: 201 });
        const runId = (JSON.parse(sent.body) as { id: string }).id;
        await waitUntil(async () => (await tablesPool.query<{ status: string }>('SELECT status FROM runs WHERE id=$1', [runId])).rows[0]?.status === status, { description: `ferramenta ${name} ${status}`, timeoutMs: 30_000 });
        return runId;
      };
      const createdRun = await runTableTool('table_create', { operationId: randomUUID(), name: 'Criada pelo agente' });
      const created = JSON.parse((await tablesPool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND kind='activity'", [createdRun])).rows[0]!.content) as { id: string; version: number };
      const queriedRun = await runTableTool('table_query', { tableId: table.id, query: { viewId, aggregate: [{ alias: 'Total', op: 'sum', columnId: calculatedColumn }] } });
      expect(JSON.parse((await tablesPool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND kind='activity'", [queriedRun])).rows[0]!.content)).toMatchObject({ aggregate: { Total: '0.2' }, totalCount: 1 });
      const prepRun = await runTableTool('table_prepare_operation', { tableId: created.id, operation: { kind: 'delete_table', expectedVersion: created.version } });
      const prepared = JSON.parse((await tablesPool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND kind='activity'", [prepRun])).rows[0]!.content) as { preparationId: string };
      const deleteRun = await runTableTool('table_delete_table', { tableId: created.id, preparationId: prepared.preparationId, operationId: randomUUID(), confirmation: true }, 'waiting_approval');
      const approval = (await tablesPool.query<{ id: string }>('SELECT id::text FROM approvals WHERE run_id=$1', [deleteRun])).rows[0]!;
      expect((await http('GET', `/api/tables/${created.id}`, undefined, { cookie })).status).toBe(200);
      expect((await http('POST', `/api/approvals/${approval.id}/respond`, { decision: 'allow_once' }, write)).status).toBe(200);
      await waitUntil(async () => (await tablesPool.query<{ status: string }>('SELECT status FROM runs WHERE id=$1', [deleteRun])).rows[0]?.status === 'completed', { description: 'exclusão interna aprovada', timeoutMs: 30_000 });
      expect((await http('GET', `/api/tables/${created.id}`, undefined, { cookie })).status).toBe(404);
      expect((await http('GET', `/api/tables/${table.id}`, undefined, { cookie })).status).toBe(200);
    } finally { await tablesPool.end(); }
    const chat = JSON.parse((await http('POST', '/api/chat/sessions', {}, write)).body).id as string;
    expect((await http('PATCH', `/api/chat/sessions/${chat}/conversation`, { model: 'opencode/glm-5.1', effort: null }, write)).status).toBe(200);
    const snapshot = async () => JSON.parse((await http('GET', `/api/chat/sessions/${chat}/conversation`, undefined, { cookie })).body) as {
      runs: { status: string; complements: { content: string }[] }[];
      items: { kind: string; role?: string; content?: string; complement?: boolean }[];
    };
    const base = await http('POST', `/api/chat/sessions/${chat}/messages`, { content: '[lento] base do smoke' }, write);
    expect(JSON.parse(base.body)).toMatchObject({ kind: 'run', status: 'queued' });
    await waitUntil(async () => (await snapshot()).runs.some((run) => run.status === 'running'), { description: 'a execução base rodar', timeoutMs: 30_000 });
    const complement = await http('POST', `/api/chat/sessions/${chat}/messages`, { content: 'complemento do smoke' }, write);
    expect([complement.status, JSON.parse(complement.body).kind]).toEqual([201, 'complement']);
    await waitUntil(
      async () => {
        const state = await snapshot();
        return state.runs.length === 0 && state.items.some((item) => item.role === 'assistant' && item.content === 'Resposta: complemento do smoke');
      },
      { description: 'o complemento promovido ser respondido', timeoutMs: 30_000 },
    );
    const finished = await snapshot();
    expect(finished.items.filter((item) => item.role === 'user').map((item) => item.content)).toEqual(['[lento] base do smoke', 'complemento do smoke']);
    expect(finished.items.find((item) => item.role === 'assistant')?.content).toContain('parte8'); // o streaming terminou inteiro

    // Phase 4 (T7): pelo worker empacotado, o modelo chama `run_python`, o pedido chega ao sandbox com o token e o resultado volta ao modelo.
    // A planilha força o worker de produção a abrir o leitor isolado ao validar /out/; o bundle precisa incluir essa entrada.
    const workbook = xlsxFixture();
    sandbox!.handler = () => ({ output: 'saida do smoke', files: [{ name: 'produtos.xlsx', data: workbook }] });
    expect((await http('POST', `/api/chat/sessions/${chat}/messages`, { content: pythonMarker({ code: 'print("smoke")' }) }, write)).status).toBe(201);
    await waitUntil(async () => (await snapshot()).items.some((item) => item.role === 'assistant' && item.content?.startsWith('Encontrei: Desfecho: ok.')), {
      description: 'o run_python ser respondido', timeoutMs: 30_000,
    });
    expect(sandbox!.requests.map((request) => request.code)).toEqual(['print("smoke")']);
    const generatedPool = createPool(database.url, { applicationName: 'smoke-generated-xlsx', max: 1 });
    try {
      const stored = await generatedPool.query<{ id: string }>("SELECT id::text AS id FROM attachments WHERE kind = 'generated' AND name = 'produtos.xlsx'");
      expect(stored.rows).toHaveLength(1);
      const download = await http('GET', `/api/chat/sessions/${chat}/attachments/${stored.rows[0]!.id}/content`, undefined, { cookie });
      expect(download.status).toBe(200);
      expect(download.bytes).toEqual(workbook);
    } finally { await generatedPool.end(); }

    // Phase 17 (A6, A15): a chave da Anthropic é provada pela API empacotada, o catálogo traz os dois provedores e o worker empacotado serve a conversa de um modelo Claude, só com
    // `x-api-key` e a versão (sem Bearer nem sessão do OpenCode) e com a chave dela, nunca a do OpenCode Go.
    const claudeSmoke = 'valid-smoke-anthropic-0001';
    expect((await http('POST', '/api/credentials/anthropic', { key: claudeSmoke }, write)).status).toBe(200);
    const catalog = (JSON.parse((await http('GET', '/api/models', undefined, { cookie })).body) as { models: { id: string }[] }).models.map((model) => model.id);
    expect(catalog.filter((id) => id.startsWith('anthropic/'))).toHaveLength(8);
    expect(catalog.filter((id) => id.startsWith('opencode/')).length).toBeGreaterThan(0);
    expect(catalog.every((id) => id.startsWith('opencode/') || id.startsWith('anthropic/'))).toBe(true);
    const claudeChat = JSON.parse((await http('POST', '/api/chat/sessions', {}, write)).body).id as string;
    expect((await http('PATCH', `/api/chat/sessions/${claudeChat}/conversation`, { model: 'anthropic/claude-haiku-5-5', effort: null }, write)).status).toBe(200);
    expect((await http('POST', `/api/chat/sessions/${claudeChat}/messages`, { content: 'olá, Claude do smoke' }, write)).status).toBe(201);
    await waitUntil(
      async () => (JSON.parse((await http('GET', `/api/chat/sessions/${claudeChat}/conversation`, undefined, { cookie })).body) as { items: { role?: string; content?: string }[] }).items.some((item) => item.role === 'assistant' && item.content === 'Resposta: olá, Claude do smoke'),
      { description: 'o modelo Claude ser respondido', timeoutMs: 30_000 },
    );
    const claudeCalls = upstreams.requests.filter((request) => request.service === 'anthropic' && request.method === 'POST' && Array.isArray(request.body?.system));
    expect(claudeCalls).toHaveLength(1);
    expect(claudeCalls[0]).toMatchObject({ path: '/anthropic/v1/messages', key: claudeSmoke, model: 'claude-haiku-5-5', anthropicVersion: '2023-06-01', bearer: false });
    expect(claudeCalls[0]!.sessionId).toBeUndefined();
    expect(worker.output()).not.toContain(claudeSmoke);

    const client = createBoss(database.url, 'smoke-client');
    await client.start();
    try {
      const id = await client.send(SYSTEM_PING_QUEUE, { origem: 'smoke' });
      await waitUntil(async () => (await client.getJobById(SYSTEM_PING_QUEUE, id!))?.state === 'completed', {
        description: 'o worker concluir o ping',
        timeoutMs: 30_000,
      });
    } finally {
      await client.stop({ graceful: false, timeout: 2_000 });
    }
    expect(worker.output()).not.toContain(database.url);
    expect(worker.output()).not.toContain(MASTER_KEY);
    expect(worker.output()).not.toContain(sandbox!.token);
    expect(worker.output()).not.toContain('saida do smoke');
  });

  it('a api não inicia sem as variáveis obrigatórias: sai com erro citando só o nome, sem valores', async () => {
    for (const variable of ['AION_OWNER_EMAIL', 'AION_OWNER_PASSWORD', 'AION_MASTER_KEY']) {
      const api = spawnNode(['dist/main.js'], {
        cwd: `${ROOT}apps/api`,
        env: { ...apiEnv, PORT: String(await freePort()), [variable]: '' },
      });
      const code = await api.exited;
      expect(code, variable).toBe(1);
      expect(api.output()).toContain(`${variable}`);
      expect(api.output()).toContain('a api não iniciou');
      for (const secret of [OWNER.password, MASTER_KEY, database.url]) expect(api.output()).not.toContain(secret);
    }
  });

  it('a api e o worker não iniciam com o endereço da Parallel inválido: citam só o nome da variável, nunca o valor', async () => {
    const invalid = 'ftp://parallel.exemplo.test/mcp';
    const api = spawnNode(['dist/main.js'], { cwd: `${ROOT}apps/api`, env: { ...apiEnv, PORT: String(await freePort()), AION_PARALLEL_BASE_URL: invalid } });
    expect(await api.exited).toBe(1);
    expect(api.output()).toContain('AION_PARALLEL_BASE_URL');
    expect(api.output()).not.toContain(invalid);
    const worker = spawnNode(['dist/main.js'], {
      cwd: `${ROOT}apps/worker`,
      env: { NODE_ENV: 'production', DATABASE_URL: database.url, AION_MASTER_KEY: MASTER_KEY, AION_PARALLEL_BASE_URL: invalid },
    });
    expect(await worker.exited).toBe(1);
    expect(worker.output()).toContain('AION_PARALLEL_BASE_URL');
    expect(worker.output()).not.toContain(invalid);
  });
});
