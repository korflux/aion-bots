// Prova das migrations que rodam sozinhas a cada deploy: aplicação única e serializada, atomicidade,
// plano de rollback executável em todas e trava de migration destrutiva (a 0028, que remove `bots.mascot`, é a primeira do registro).
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { migrateTestDatabase } from '../testing/migrate';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { DESTRUCTIVE_SQL_PATTERN, MigrationError, runMigrations, type Migration } from './migrator';
import { MIGRATIONS } from './migrations';
import { createPool, type Pool } from './pool';

/**
 * Os seis personagens que a 0018 gravava em `bots.mascot` (a mesma lista fixa do SQL dela), na ordem em que a fórmula do id os indexa. Vive aqui, e não
 * em @aion/shared, porque o personagem saiu dos contratos na phase 5: só estas provas (e as migrations 0018 e 0028) ainda precisam dos ids.
 */
const LEGACY_MASCOTS = ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'pill'] as const;

/** Registro até a migration `id` inclusive: o estado do banco naquele ponto, para provar uma migration isolada. */
const upTo = (id: string): readonly Migration[] => MIGRATIONS.filter((migration) => migration.id <= id);

const databases: TestDatabase[] = [];
const pools: Pool[] = [];

/** Banco vazio e exclusivo do teste, para que um teste nunca dependa do estado de outro. */
async function freshPool(): Promise<Pool> {
  const database = await createTestDatabase(inject('adminDatabaseUrl'));
  databases.push(database);
  const pool = createPool(database.url, { applicationName: 'migrator-test', max: 4 });
  pools.push(pool);
  return pool;
}

const userTables = async (pool: Pool): Promise<string[]> =>
  (
    await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )
  ).rows.map((row) => row.tablename);

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await Promise.all(databases.map((database) => database.drop()));
});

describe('migrations', () => {
  it('aplicam uma única vez mesmo com duas instâncias subindo juntas, e a segunda subida não faz nada', async () => {
    const pool = await freshPool();
    const [first, second] = await Promise.all([migrateTestDatabase(pool), migrateTestDatabase(pool)]);

    // Cada migration foi aplicada por exatamente uma das duas execuções concorrentes.
    expect([...first, ...second].sort()).toEqual(MIGRATIONS.map((m) => m.id).sort());
    expect(await migrateTestDatabase(pool)).toEqual([]);
    expect(await userTables(pool)).toEqual(
      expect.arrayContaining(['app_state', 'audit_log', 'login_failures', 'login_locks', 'schema_migrations', 'sessions']),
    );
  });

  it('uma migration que falha no meio não deixa nada aplicado nem registrado', async () => {
    const pool = await freshPool();
    const broken: Migration = {
      id: '9000_quebrada',
      description: 'falha depois de criar uma tabela',
      up: 'CREATE TABLE parcial (id int); SELECT funcao_que_nao_existe();',
      rollback: 'DROP TABLE parcial;',
    };
    await expect(runMigrations(pool, { migrations: [broken] })).rejects.toBeInstanceOf(MigrationError);
    expect(await userTables(pool)).not.toContain('parcial');
    expect((await pool.query('SELECT 1 FROM schema_migrations')).rowCount).toBe(0);
  });

  it('0030 preserva o banco antigo na ida/rollback vazio/re-up e recusa rollback que apagaria dados', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0030_bot_tables')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const botId = randomUUID();
    await pool.query("INSERT INTO bots (id, name, name_key, color, created_at, updated_at) VALUES ($1, 'Bot antigo', 'bot antigo', '#60A5FA', now(), now())", [botId]);
    const before = (await pool.query('SELECT to_jsonb(b) AS row FROM bots b WHERE id = $1', [botId])).rows;
    await migrateTestDatabase(pool, { migrations: upTo(migration.id) });
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);
    expect((await pool.query('SELECT to_jsonb(b) AS row FROM bots b WHERE id = $1', [botId])).rows).toEqual(before);
    await pool.query(migration.rollback);
    await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect((await pool.query('SELECT to_jsonb(b) AS row FROM bots b WHERE id = $1', [botId])).rows).toEqual(before);
    await pool.query("INSERT INTO data_tables (id, name) VALUES ($1, 'Dados novos')", [randomUUID()]);
    await expect(pool.query(migration.rollback)).rejects.toThrow(/preserve os dados/);
    expect((await pool.query('SELECT count(*) FROM data_tables')).rows[0]).toEqual({ count: '1' });
  });

  it('0031 mantém dados existentes, rollback vazio é idempotente e vistas preenchidas são preservadas', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0031_table_views')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const tableId = randomUUID(); const recordId = randomUUID();
    await pool.query("INSERT INTO data_tables (id, name) VALUES ($1, 'Dados preservados')", [tableId]);
    await pool.query('INSERT INTO table_records (table_id, id, values) VALUES ($1, $2, $3)', [tableId, recordId, '{}']);
    const before = (await pool.query('SELECT table_id, id, version, values FROM table_records')).rows;
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);
    await pool.query(migration.rollback);
    await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect((await pool.query('SELECT table_id, id, version, values FROM table_records')).rows).toEqual(before);
    await pool.query("INSERT INTO table_views (table_id, id, name, definition) VALUES ($1, $2, 'Vista preservada', '{}')", [tableId, randomUUID()]);
    await expect(pool.query(migration.rollback)).rejects.toThrow(/preserve as vistas/);
    expect((await pool.query('SELECT count(*) FROM table_views')).rows[0]).toEqual({ count: '1' });
    expect((await pool.query('SELECT table_id, id, version, values FROM table_records')).rows).toEqual(before);
  });

  it('0032 preserva dados anteriores, permite rollback vazio e protege preparações/argumentos íntegros', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0032_table_operations')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const tableId = randomUUID();
    await pool.query("INSERT INTO data_tables(id,name) VALUES($1,'Preservada')", [tableId]);
    const before = (await pool.query('SELECT id,name,version FROM data_tables')).rows;
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    await pool.query(migration.rollback); await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id=$1', [migration.id]);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect((await pool.query('SELECT id,name,version FROM data_tables')).rows).toEqual(before);
    await pool.query("INSERT INTO table_operation_preparations(id,actor,table_id,definition,impact) VALUES($1,'owner',$2,'{}','{}')", [randomUUID(), tableId]);
    await expect(pool.query(migration.rollback)).rejects.toThrow(/Preserve preparações e argumentos/);
    expect((await pool.query('SELECT 1 FROM table_operation_preparations')).rowCount).toBe(1);
  });

  it('0040 troca o padrão global de contexto de 32k para 64k sem tocar escolhas diferentes nem overrides por bot, e o rollback é o inverso', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0040_context_default_64k')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const globals = async () => (await pool.query<{ bots: number; chat: number }>('SELECT bot_context_window_tokens AS bots, general_chat_context_window_tokens AS chat FROM app_settings')).rows[0];
    const overrides = async () => (await pool.query<{ name: string; context_window_tokens: number | null }>('SELECT name, context_window_tokens FROM bots ORDER BY name')).rows;
    const columnDefaults = async () => (await pool.query<{ column_name: string; column_default: string }>(
      "SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name LIKE '%context_window_tokens' ORDER BY column_name")).rows.map((row) => row.column_default);
    // Banco de produção antes da 0040: Chat geral ainda no padrão antigo (32k), bots escolhidos pelo dono (128k) e três bots com override, um deles em 32k.
    await pool.query('UPDATE app_settings SET bot_context_window_tokens = 131072');
    for (const [name, override] of [['A herda', null], ['B em 32k', 32768], ['C em 128k', 131072]] as const) {
      await pool.query("INSERT INTO bots (name, name_key, color, context_window_tokens, created_at, updated_at) VALUES ($1, lower($1), '#60A5FA', $2, now(), now())", [name, override]);
    }
    const botsBefore = await overrides();
    expect(await columnDefaults()).toEqual(['32768', '32768']);

    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await globals()).toEqual({ bots: 131072, chat: 65536 }); // só o 32k do padrão antigo sobe; 128k escolhido fica
    expect(await overrides()).toEqual(botsBefore); // override explícito por bot, inclusive o 32k, nunca é tocado
    expect(await columnDefaults()).toEqual(['65536', '65536']);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);

    // Rollback é o inverso nos globais (idempotente) e devolve o DEFAULT; bots seguem intactos.
    await pool.query(migration.rollback); await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await globals()).toEqual({ bots: 131072, chat: 32768 });
    expect(await overrides()).toEqual(botsBefore);
    expect(await columnDefaults()).toEqual(['32768', '32768']);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await globals()).toEqual({ bots: 131072, chat: 65536 });

    // O CHECK dos presets segue valendo (64k e 32k continuam escolhas válidas, outros valores não).
    await pool.query('UPDATE app_settings SET bot_context_window_tokens = 32768');
    await expect(pool.query('UPDATE app_settings SET bot_context_window_tokens = 50000')).rejects.toThrow(/bot_context_window_tokens/);
  });

  it('0043 aceita a janela de 256k nos globais e no override por bot sem tocar valores, e o rollback rebaixa 256k para 128k e volta aos três presets', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0043_context_window_256k')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const globals = async () => (await pool.query<{ bots: number; chat: number }>('SELECT bot_context_window_tokens AS bots, general_chat_context_window_tokens AS chat FROM app_settings')).rows[0];
    const override = async () => (await pool.query<{ context_window_tokens: number | null }>("SELECT context_window_tokens FROM bots WHERE name = 'Grande'")).rows[0]!.context_window_tokens;
    await pool.query("INSERT INTO bots (name, name_key, color, context_window_tokens, created_at, updated_at) VALUES ('Grande', 'grande', '#60A5FA', 65536, now(), now())");
    // Antes da 0043 o banco recusa 256k.
    await expect(pool.query('UPDATE app_settings SET bot_context_window_tokens = 262144')).rejects.toThrow(/bot_context_window_tokens/);
    const before = await globals();

    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await globals()).toEqual(before);
    expect(await override()).toBe(65536);
    await pool.query('UPDATE app_settings SET bot_context_window_tokens = 262144, general_chat_context_window_tokens = 262144');
    await pool.query("UPDATE bots SET context_window_tokens = 262144 WHERE name = 'Grande'");
    for (const sql of ['UPDATE app_settings SET bot_context_window_tokens = 50000', 'UPDATE app_settings SET general_chat_context_window_tokens = 50000', 'UPDATE bots SET context_window_tokens = 50000']) {
      await expect(pool.query(sql)).rejects.toThrow(/context_window_tokens/);
    }
    await pool.query(migration.up); // repetível

    // Rollback (idempotente): 256k vira 128k e o CHECK antigo volta a recusar 256k.
    await pool.query(migration.rollback); await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await globals()).toEqual({ bots: 131072, chat: 131072 });
    expect(await override()).toBe(131072);
    await expect(pool.query('UPDATE bots SET context_window_tokens = 262144')).rejects.toThrow(/context_window_tokens/);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
  });

  it('0046 leva os globais a 256k, os bots de 32k a 64k e troca os presets para 64k a 512k sem apagar dados; o rollback devolve 128k e 64k, rebaixa 512k para 256k e reabre o 32k', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0046_context_window_512k')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const globals = async () => (await pool.query<{ bots: number; chat: number }>('SELECT bot_context_window_tokens AS bots, general_chat_context_window_tokens AS chat FROM app_settings')).rows[0];
    const overrides = async () => Object.fromEntries((await pool.query<{ name: string; context_window_tokens: number | null }>('SELECT name, context_window_tokens FROM bots ORDER BY name')).rows.map((row) => [row.name, row.context_window_tokens]));
    const columnDefaults = async () => (await pool.query<{ column_default: string }>(
      "SELECT column_default FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name LIKE '%context_window_tokens' ORDER BY column_name")).rows.map((row) => row.column_default);
    const identity = async () => (await pool.query('SELECT name, model, instructions FROM bots ORDER BY name')).rows;
    // Banco de produção antes da 0046: global dos bots em 128k, global do Chat geral em 64k e bots com override em 32k, 64k, 128k, 256k e herdando.
    await pool.query('UPDATE app_settings SET bot_context_window_tokens = 131072, general_chat_context_window_tokens = 65536');
    for (const [name, override] of [['Herda', null], ['Em 32k', 32768], ['Em 64k', 65536], ['Em 128k', 131072], ['Em 256k', 262144]] as const) {
      await pool.query("INSERT INTO bots (name, name_key, color, context_window_tokens, created_at, updated_at) VALUES ($1, lower($1), '#60A5FA', $2, now(), now())", [name, override]);
    }
    const identityBefore = await identity();
    expect(await columnDefaults()).toEqual(['65536', '65536']);
    // Antes da 0046 o banco recusa 512k.
    await expect(pool.query('UPDATE app_settings SET bot_context_window_tokens = 524288')).rejects.toThrow(/bot_context_window_tokens/);

    // Subida: globais em 256k nos dois escopos, DEFAULT 256k, só o bot em 32k muda (vai a 64k); o resto dos overrides fica.
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await globals()).toEqual({ bots: 262144, chat: 262144 });
    expect(await columnDefaults()).toEqual(['262144', '262144']);
    expect(await overrides()).toEqual({ Herda: null, 'Em 32k': 65536, 'Em 64k': 65536, 'Em 128k': 131072, 'Em 256k': 262144 });
    expect(await identity()).toEqual(identityBefore);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);

    // Novos presets: 512k entra nos três CHECKs; 32k e valores fora da lista saem em todos.
    await pool.query("UPDATE app_settings SET bot_context_window_tokens = 524288, general_chat_context_window_tokens = 524288");
    await pool.query("UPDATE bots SET context_window_tokens = 524288 WHERE name = 'Em 256k'");
    for (const sql of [
      'UPDATE app_settings SET bot_context_window_tokens = 32768', 'UPDATE app_settings SET general_chat_context_window_tokens = 32768', 'UPDATE bots SET context_window_tokens = 32768',
      'UPDATE app_settings SET bot_context_window_tokens = 50000', 'UPDATE app_settings SET general_chat_context_window_tokens = 50000', 'UPDATE bots SET context_window_tokens = 50000',
    ]) {
      await expect(pool.query(sql), sql).rejects.toThrow(/context_window_tokens/);
    }

    // Rollback (idempotente): globais voltam a 128k e 64k, o bot em 512k desce a 256k, o levado de 32k segue em 64k, o DEFAULT volta e o CHECK reabre o 32k e fecha o 512k.
    await pool.query(migration.rollback); await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await globals()).toEqual({ bots: 131072, chat: 65536 });
    expect(await columnDefaults()).toEqual(['65536', '65536']);
    expect(await overrides()).toEqual({ Herda: null, 'Em 32k': 65536, 'Em 64k': 65536, 'Em 128k': 131072, 'Em 256k': 262144 });
    expect(await identity()).toEqual(identityBefore);
    await pool.query('UPDATE bots SET context_window_tokens = 32768 WHERE name = \'Em 32k\'');
    for (const sql of ['UPDATE app_settings SET bot_context_window_tokens = 524288', 'UPDATE app_settings SET general_chat_context_window_tokens = 524288', 'UPDATE bots SET context_window_tokens = 524288']) {
      await expect(pool.query(sql), sql).rejects.toThrow(/context_window_tokens/);
    }
    await pool.query('UPDATE bots SET context_window_tokens = 65536 WHERE name = \'Em 32k\'');
    await pool.query('UPDATE app_settings SET bot_context_window_tokens = 32768, general_chat_context_window_tokens = 32768'); // o CHECK dos globais também reabriu o 32k
    await pool.query('UPDATE app_settings SET bot_context_window_tokens = 131072, general_chat_context_window_tokens = 65536');

    // Subir de novo repete a subida sobre o estado revertido.
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await globals()).toEqual({ bots: 262144, chat: 262144 });
    expect(await overrides()).toEqual({ Herda: null, 'Em 32k': 65536, 'Em 64k': 65536, 'Em 128k': 131072, 'Em 256k': 262144 });
  });

  it('0047 acrescenta a tabela da limpeza fria sem tocar nas mensagens, grava cada resultado uma vez, sobe e desce vazia e o rollback recusa com limpeza gravada sem apagar nada', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0047_cold_maintenance')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const tableExists = async () => ((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'context_cold_masks'")).rowCount ?? 0) > 0;
    // Banco de produção antes da 0047: uma conversa com a pergunta do dono e um resultado de ferramenta grande já concluído.
    const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
    await pool.query("INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, created_at) VALUES ($1, 'user', 'text', 'done', true, 'pedido do dono', now())", [conversation]);
    const result = (await pool.query<{ id: string }>("INSERT INTO messages (conversation_id, role, kind, status, step, content, data, created_at) VALUES ($1, 'assistant', 'activity', 'completed', 1, $2, '{\"tool\":\"t\"}', now()) RETURNING id", [conversation, 'r'.repeat(5000)])).rows[0]!.id;
    const messages = async () => (await pool.query('SELECT id, content, status, data FROM messages ORDER BY id')).rows;
    const before = await messages();
    expect(await tableExists()).toBe(false);

    // Aditiva: a tabela nasce vazia e nada do que existia muda; subir de novo não faz nada, e o SQL em si também é repetível (IF NOT EXISTS).
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await tableExists()).toBe(true);
    expect((await pool.query('SELECT count(*) AS total FROM context_cold_masks')).rows[0]).toEqual({ total: '0' });
    expect(await messages()).toEqual(before);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);
    await pool.query(migration.up);

    // Rollback com a tabela vazia: remove só ela, é repetível (a segunda execução não encontra a tabela) e subir de novo a recria.
    await pool.query(migration.rollback);
    await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await tableExists()).toBe(false);
    expect(await messages()).toEqual(before);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await tableExists()).toBe(true);

    // A limpeza é gravada uma vez por resultado: a chave é a mensagem, e gravar de novo conflita (quem grava usa ON CONFLICT DO NOTHING e não atualiza nada).
    const mask = (id: string) => pool.query('INSERT INTO context_cold_masks (message_id, conversation_id, masked_at) VALUES ($1, $2, now())', [id, conversation]);
    await mask(result);
    await expect(mask(result)).rejects.toThrow(/context_cold_masks_pkey/);
    await pool.query('INSERT INTO context_cold_masks (message_id, conversation_id, masked_at) VALUES ($1, $2, now()) ON CONFLICT (message_id) DO NOTHING', [result, conversation]);
    expect((await pool.query('SELECT message_id::text FROM context_cold_masks')).rows).toEqual([{ message_id: result }]);

    // Com limpeza gravada o rollback recusa (nada é apagado: as linhas e as mensagens ficam como estavam) e o registro da migration continua aplicado.
    await expect(pool.query(migration.rollback)).rejects.toThrow(/Preserve a limpeza fria gravada/);
    expect((await pool.query('SELECT message_id::text FROM context_cold_masks')).rows).toEqual([{ message_id: result }]);
    expect(await messages()).toEqual(before);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);

    // A limpeza só some junto com o resultado que ela descreve (o código apaga as mensagens de um bot ou sessão antes da conversa), sem apagar o resto.
    const other = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
    const otherResult = (await pool.query<{ id: string }>("INSERT INTO messages (conversation_id, role, kind, status, step, content, data, created_at) VALUES ($1, 'assistant', 'activity', 'completed', 1, 'x', '{}', now()) RETURNING id", [other])).rows[0]!.id;
    await pool.query('INSERT INTO context_cold_masks (message_id, conversation_id, masked_at) VALUES ($1, $2, now())', [otherResult, other]);
    await pool.query('DELETE FROM messages WHERE conversation_id = $1', [other]);
    await pool.query('DELETE FROM conversations WHERE id = $1', [other]);
    expect((await pool.query('SELECT message_id::text FROM context_cold_masks')).rows).toEqual([{ message_id: result }]);
    expect(await messages()).toEqual(before);
  });

  it('0048 torna session_id anulável sem tocar nas manutenções do dono, aceita a manutenção fria sem sessão, sobe e desce sem manutenção fria e o rollback recusa com manutenção fria gravada sem apagar nada', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0048_cold_compaction')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const sessionNullable = async () => (await pool.query<{ is_nullable: string }>("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'context_maintenance' AND column_name = 'session_id'")).rows[0]!.is_nullable;
    const rows = async () => (await pool.query('SELECT request_id, conversation_id, run_id::text AS run_id, session_id, mode, expected_revision::text AS expected_revision FROM context_maintenance ORDER BY created_at, run_id')).rows;
    // Uma manutenção grava a execução (`runs.context_operation_id`) e o recibo; `session` nula é a manutenção fria.
    const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
    const maintain = async (session: string | null, at: string) => {
      const requestId = randomUUID();
      const run = (await pool.query<{ id: string }>("INSERT INTO runs (conversation_id, input, created_at, context_operation_id, status) VALUES ($1, '[Manutenção de contexto]', $2, $3, 'completed') RETURNING id", [conversation, at, requestId])).rows[0]!.id;
      await pool.query("INSERT INTO context_maintenance (request_id, conversation_id, run_id, session_id, mode, expected_revision, created_at) VALUES ($1, $2, $3, $4, 'summarize', 7, $5)", [requestId, conversation, run, session, at]);
      return requestId;
    };
    // Banco de produção antes da 0048: uma operação pedida pelo dono (com a sessão dele), e nenhuma manutenção sem sessão é possível.
    const owner = randomUUID();
    await maintain(owner, '2026-10-17T10:00:00Z');
    const before = await rows();
    expect(await sessionNullable()).toBe('NO');
    await expect(maintain(null, '2026-10-17T11:00:00Z')).rejects.toThrow(/session_id/);

    // Aditiva: só afrouxa a restrição, nada do que existia muda; subir de novo não faz nada, e o SQL em si também é repetível.
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await sessionNullable()).toBe('YES');
    expect(await rows()).toEqual(before);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);
    await pool.query(migration.up);

    // Rollback sem manutenção fria: devolve a restrição, é repetível, não toca a linha do dono, e subir de novo reabre a coluna.
    await pool.query(migration.rollback);
    await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await sessionNullable()).toBe('NO');
    expect(await rows()).toEqual(before);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await sessionNullable()).toBe('YES');

    // A manutenção fria é gravada sem sessão; com ela gravada o rollback recusa (nada é apagado, a coluna segue anulável e a migration segue registrada).
    const cold = await maintain(null, '2026-10-17T12:00:00Z');
    const withCold = await rows();
    expect(withCold).toHaveLength(2);
    expect(withCold.filter((row) => row.session_id === null).map((row) => row.request_id)).toEqual([cold]);
    await expect(pool.query(migration.rollback)).rejects.toThrow(/Preserve a manutencao fria gravada/);
    expect(await sessionNullable()).toBe('YES');
    expect(await rows()).toEqual(withCold);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);

    // A manutenção fria some só junto com a execução dela (`ON DELETE CASCADE`, como a conversa e o bot apagam); sem ela o rollback volta a valer e a linha do dono segue intacta.
    await pool.query('DELETE FROM runs WHERE context_operation_id = $1', [cold]);
    expect(await rows()).toEqual(before);
    await pool.query(migration.rollback);
    expect(await sessionNullable()).toBe('NO');
    expect(await rows()).toEqual(before);
  });

  it('0049 acrescenta cache_write_tokens (inteiro anulável e não negativo) sem tocar no uso existente, e o rollback remove só a coluna, mesmo preenchida', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0049_cache_write_tokens')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const column = async () => (await pool.query<{ data_type: string; is_nullable: string }>("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'model_call_usage' AND column_name = 'cache_write_tokens'")).rows[0];
    // O que existia antes: a conversa, a execução e uma chamada concluída com cache lido (entrada total, leitura e saída), como o motor a deixa antes da 0049.
    const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
    const run = (await pool.query<{ id: string }>("INSERT INTO runs (conversation_id, input, created_at, status) VALUES ($1, 'pedido', now(), 'completed') RETURNING id", [conversation])).rows[0]!.id;
    const usageId = randomUUID();
    await pool.query("INSERT INTO model_call_usage (id, conversation_id, run_id, purpose, model, protocol, state, input_tokens, output_tokens, cached_tokens, created_at, completed_at) VALUES ($1, $2, $3, 'main', 'claude-haiku-5-5', 'messages', 'completed', 1000, 5, 800, now(), now())", [usageId, conversation, run]);
    const snapshot = async () => (await pool.query('SELECT id::text, conversation_id::text, run_id::text, purpose, model, protocol, state, input_tokens::text, output_tokens::text, cached_tokens::text, reasoning_tokens::text FROM model_call_usage ORDER BY id')).rows;
    const before = await snapshot();
    expect(await column()).toBeUndefined();

    // Aditiva: a coluna nasce anulável (NULL = o provedor não informou, e a linha antiga continua assim, sem preenchimento inventado) e nada do que existia muda; subir de novo não faz nada, e o SQL em si também é repetível.
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await column()).toEqual({ data_type: 'integer', is_nullable: 'YES' });
    expect(await snapshot()).toEqual(before);
    expect((await pool.query('SELECT cache_write_tokens FROM model_call_usage')).rows).toEqual([{ cache_write_tokens: null }]);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);
    await pool.query(migration.up);

    // O CHECK aceita nulo, zero (informado é dado) e positivo, e recusa negativo.
    for (const accepted of [null, 0, 180]) await pool.query('UPDATE model_call_usage SET cache_write_tokens = $1 WHERE id = $2', [accepted, usageId]);
    await expect(pool.query('UPDATE model_call_usage SET cache_write_tokens = -1 WHERE id = $1', [usageId])).rejects.toThrow(/cache_write_tokens/);

    // Rollback com a coluna preenchida: remove só ela (o resto da linha, a execução e a conversa ficam), é repetível e subir de novo a recria vazia.
    await pool.query(migration.rollback);
    await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await column()).toBeUndefined();
    expect(await snapshot()).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS total FROM runs WHERE id = $1', [run])).rows[0]).toEqual({ total: 1 });
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect((await pool.query('SELECT cache_write_tokens FROM model_call_usage')).rows).toEqual([{ cache_write_tokens: null }]);
  });

  it('0050 acrescenta contas do conector, liberação por bot e o instantâneo da semeadura sem tocar nos dados existentes; o rollback apaga as tabelas novas mesmo com dados e roda de novo sem erro (A20)', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0050_connector_accounts')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const newTables = async () => (await userTables(pool)).filter((name) => name.startsWith('connector_'));
    // Banco de produção antes da 0050: dois bots (um deles com conversa e mensagem) e uma linha de auditoria.
    const [x, y] = [randomUUID(), randomUUID()];
    for (const [id, name] of [[x, 'X'], [y, 'Y']] as const) {
      await pool.query("INSERT INTO bots (id, name, name_key, color, created_at, updated_at) VALUES ($1, $2, lower($2), '#60A5FA', now(), now())", [id, name]);
    }
    const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (bot_id, created_at) VALUES ($1, now()) RETURNING id', [x])).rows[0]!.id;
    await pool.query("INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, created_at) VALUES ($1, 'user', 'text', 'done', true, 'pedido do dono', now())", [conversation]);
    await pool.query("INSERT INTO audit_log (at, action, outcome, actor, details) VALUES (now(), 'bot.create', 'success', 'owner', '{}')");
    /** Retrato de TODAS as tabelas que a 0050 não cria (menos o registro de migrations): "as tabelas existentes ficam com os mesmos dados". */
    const existing = async () => {
      const dump: Record<string, unknown[]> = {};
      for (const table of (await userTables(pool)).filter((name) => !name.startsWith('connector_') && name !== 'schema_migrations')) {
        dump[table] = (await pool.query<{ row: unknown }>(`SELECT to_jsonb(t) AS row FROM "${table}" t`)).rows.map((entry) => JSON.stringify(entry.row)).sort();
      }
      return dump;
    };
    const before = await existing();
    expect(await newTables()).toEqual([]);

    // Aditiva: três tabelas novas; contas e liberações nascem vazias e o instantâneo guarda os bots que existem agora, com a semeadura pendente. Nada do que existia muda.
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await newTables()).toEqual(['connector_account_bots', 'connector_accounts', 'connector_seed']);
    const seed = async () => (await pool.query<{ bot_ids: string[]; completed_at: Date | null }>('SELECT bot_ids, completed_at FROM connector_seed')).rows;
    expect((await seed()).map((row) => ({ bots: [...row.bot_ids].sort(), completed: row.completed_at }))).toEqual([{ bots: [x, y].sort(), completed: null }]);
    expect((await pool.query('SELECT (SELECT count(*) FROM connector_accounts)::int AS accounts, (SELECT count(*) FROM connector_account_bots)::int AS releases')).rows).toEqual([{ accounts: 0, releases: 0 }]);
    expect(await existing()).toEqual(before);
    // Subir de novo não faz nada, e o SQL em si é repetível sem refazer nem apagar o instantâneo (uma semeadura concluída não volta a pendente).
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);
    await pool.query("UPDATE connector_seed SET completed_at = now(), bot_ids = '{}'");
    await pool.query(migration.up);
    expect((await seed()).map((row) => ({ bots: row.bot_ids, done: row.completed_at !== null }))).toEqual([{ bots: [], done: true }]);

    // Restrições: nome de 1 a 40 caracteres, único dentro do app sem diferenciar maiúsculas (a chave é do serviço), mesmo nome em outro app vale, versão não negativa, uma única linha de semeadura.
    const insertAccount = (id: string, app: string, name: string | null) =>
      pool.query('INSERT INTO connector_accounts (id, app_slug, app_name, name, name_key) VALUES ($1, $2, $2, $3, lower($3))', [id, app, name]);
    await insertAccount('ca_a', 'gmail', 'Pessoal');
    await insertAccount('ca_b', 'gmail', null);
    await insertAccount('ca_c', 'github', 'Pessoal');
    await expect(insertAccount('ca_d', 'gmail', 'Pessoal')).rejects.toThrow(/connector_accounts_app_name_key/);
    await expect(insertAccount('ca_e', 'gmail', 'x'.repeat(41))).rejects.toThrow(/connector_accounts_name_check/);
    await expect(pool.query('UPDATE connector_accounts SET version = -1 WHERE id = $1', ['ca_a'])).rejects.toThrow(/version/);
    await expect(pool.query('INSERT INTO connector_seed (id) VALUES (false)')).rejects.toThrow();
    // A liberação aponta para conta e bot existentes, não repete o par e some com o bot (cascata); a conta some com as liberações dela.
    await pool.query('INSERT INTO connector_account_bots (account_id, bot_id) VALUES ($1, $2), ($1, $3), ($4, $2)', ['ca_a', x, y, 'ca_c']);
    await expect(pool.query('INSERT INTO connector_account_bots (account_id, bot_id) VALUES ($1, $2)', ['ca_a', x])).rejects.toThrow(/connector_account_bots_pkey/);
    await expect(pool.query('INSERT INTO connector_account_bots (account_id, bot_id) VALUES ($1, $2)', ['ca_inexistente', x])).rejects.toThrow(/connector_account_bots_account_id_fkey/);
    await expect(pool.query('INSERT INTO connector_account_bots (account_id, bot_id) VALUES ($1, $2)', ['ca_a', randomUUID()])).rejects.toThrow(/connector_account_bots_bot_id_fkey/);
    await pool.query('DELETE FROM connector_accounts WHERE id = $1', ['ca_c']);
    expect((await pool.query('SELECT account_id, bot_id FROM connector_account_bots ORDER BY bot_id::text')).rows).toEqual([x, y].sort().map((bot_id) => ({ account_id: 'ca_a', bot_id })));

    // Rollback com as três tabelas CHEIAS (decisão do dono: apaga mesmo com dados, sem a recusa das 0030, 0047 e 0048): as tabelas somem, o resto fica como estava, é repetível e subir de novo recria o instantâneo.
    await pool.query(migration.rollback);
    await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await newTables()).toEqual([]);
    expect(await existing()).toEqual(before);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect((await seed()).map((row) => ({ bots: [...row.bot_ids].sort(), completed: row.completed_at }))).toEqual([{ bots: [x, y].sort(), completed: null }]);
    expect((await pool.query('SELECT count(*)::int AS total FROM connector_accounts')).rows).toEqual([{ total: 0 }]);
  });

  it('0051 acrescenta docs, versões, associação doc-bot e recibos sem tocar nos dados existentes (inclusive as tabelas de dados); o rollback apaga as tabelas novas mesmo com dados, roda duas vezes e a reaplicação deixa o resto intacto (A27)', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0051_docs')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const isNew = (name: string): boolean => name === 'docs' || name.startsWith('doc_');
    const newTables = async () => (await userTables(pool)).filter(isNew);
    // Banco de produção antes da 0051: dois bots (um com conversa e mensagem), uma tabela de dados compartilhada com um bot e com um registro, uma versão de memória e uma linha de auditoria.
    const [x, y] = [randomUUID(), randomUUID()];
    for (const [id, name] of [[x, 'X'], [y, 'Y']] as const) {
      await pool.query("INSERT INTO bots (id, name, name_key, color, created_at, updated_at) VALUES ($1, $2, lower($2), '#60A5FA', now(), now())", [id, name]);
    }
    const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (bot_id, created_at) VALUES ($1, now()) RETURNING id', [x])).rows[0]!.id;
    await pool.query("INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, created_at) VALUES ($1, 'user', 'text', 'done', true, 'pedido do dono', now())", [conversation]);
    const dataTable = randomUUID();
    await pool.query("INSERT INTO data_tables (id, name) VALUES ($1, 'Tabela de dados')", [dataTable]);
    await pool.query('INSERT INTO table_bot_access (table_id, bot_id) VALUES ($1, $2)', [dataTable, x]);
    await pool.query("INSERT INTO table_records (table_id, id, values) VALUES ($1, $2, '{}'::jsonb)", [dataTable, randomUUID()]);
    await pool.query("INSERT INTO memory_versions (bot_id, version, content, author, added, removed, created_at) VALUES ($1, 1, 'memória', 'owner', 1, 0, now())", [x]);
    await pool.query("INSERT INTO audit_log (at, action, outcome, actor, details) VALUES (now(), 'bot.create', 'success', 'owner', '{}')");
    /** Retrato de TODAS as tabelas que a 0051 não cria (menos o registro de migrations): "as tabelas existentes ficam com os mesmos dados". */
    const existing = async () => {
      const dump: Record<string, unknown[]> = {};
      for (const table of (await userTables(pool)).filter((name) => !isNew(name) && name !== 'schema_migrations')) {
        dump[table] = (await pool.query<{ row: unknown }>(`SELECT to_jsonb(t) AS row FROM "${table}" t`)).rows.map((entry) => JSON.stringify(entry.row)).sort();
      }
      return dump;
    };
    const before = await existing();
    expect(before.data_tables).toHaveLength(1);
    expect(await newTables()).toEqual([]);

    // Aditiva: quatro tabelas novas, vazias; nada do que existia muda. Subir de novo não faz nada, e o SQL em si é repetível sem apagar o que já foi gravado.
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await newTables()).toEqual(['doc_bot_access', 'doc_mutation_receipts', 'doc_versions', 'docs']);
    const counts = async () =>
      (await pool.query('SELECT (SELECT count(*) FROM docs)::int AS docs, (SELECT count(*) FROM doc_versions)::int AS versions, (SELECT count(*) FROM doc_bot_access)::int AS access, (SELECT count(*) FROM doc_mutation_receipts)::int AS receipts')).rows[0];
    expect(await counts()).toEqual({ docs: 0, versions: 0, access: 0, receipts: 0 });
    expect(await existing()).toEqual(before);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);

    // Restrições do banco, a última defesa dos limites do serviço: título de 1 a 120 caracteres (de verdade, não de bytes), texto de até 100.000, versões positivas e autor dono ou bot.
    const insertDoc = (id: string, fields: { title?: string; content?: string; version?: number; accessVersion?: number; updatedBy?: string } = {}) =>
      pool.query('INSERT INTO docs (id, title, content, version, access_version, updated_by) VALUES ($1, $2, $3, $4, $5, $6)', [id, fields.title ?? 'Plano', fields.content ?? '', fields.version ?? 1, fields.accessVersion ?? 1, fields.updatedBy ?? 'owner']);
    const [d1, d2, d3] = [randomUUID(), randomUUID(), randomUUID()];
    await insertDoc(d1, { title: '😀'.repeat(120), content: '😀'.repeat(100_000) });
    await expect(insertDoc(randomUUID(), { title: '' })).rejects.toThrow(/docs_title_check/);
    await expect(insertDoc(randomUUID(), { title: 'x'.repeat(121) })).rejects.toThrow(/docs_title_check/);
    await expect(insertDoc(randomUUID(), { content: 'x'.repeat(100_001) })).rejects.toThrow(/docs_content_check/);
    await expect(insertDoc(randomUUID(), { version: 0 })).rejects.toThrow(/docs_version_check/);
    await expect(insertDoc(randomUUID(), { accessVersion: 0 })).rejects.toThrow(/docs_access_version_check/);
    await expect(insertDoc(randomUUID(), { updatedBy: 'sistema' })).rejects.toThrow(/docs_updated_by_check/);
    expect((await pool.query('SELECT size FROM docs WHERE id = $1', [d1])).rows).toEqual([{ size: 100_000 }]); // `size` é gerada: conta caracteres, não bytes
    await expect(pool.query('UPDATE docs SET size = 1 WHERE id = $1', [d1])).rejects.toThrow(/size/);
    await insertDoc(d2);
    await insertDoc(d3);

    const insertVersion = (docId: string, version: number, author = 'owner', restoredFrom: number | null = null) =>
      pool.query('INSERT INTO doc_versions (doc_id, version, content, author, restored_from, created_at) VALUES ($1, $2, $3, $4, $5, now())', [docId, version, 'texto', author, restoredFrom]);
    await insertVersion(d1, 1);
    await insertVersion(d1, 2, 'bot', 1);
    await expect(insertVersion(d1, 2)).rejects.toThrow(/doc_versions_pkey/);
    await expect(insertVersion(d1, 0)).rejects.toThrow(/doc_versions_version_check/);
    await expect(insertVersion(d1, 3, 'sistema')).rejects.toThrow(/doc_versions_author_check/);
    await expect(insertVersion(d1, 3, 'owner', 0)).rejects.toThrow(/doc_versions_restored_from_check/);
    await expect(insertVersion(randomUUID(), 1)).rejects.toThrow(/doc_versions_doc_id_fkey/);
    await expect(pool.query("INSERT INTO doc_versions (doc_id, version, content, author, created_at) VALUES ($1, 3, $2, 'owner', now())", [d1, 'x'.repeat(100_001)])).rejects.toThrow(/doc_versions_content_check/);
    expect((await pool.query('SELECT version, size FROM doc_versions WHERE doc_id = $1 ORDER BY version', [d1])).rows).toEqual([{ version: 1, size: 5 }, { version: 2, size: 5 }]);
    await insertVersion(d2, 1);

    // A associação aponta para doc e bot existentes, não repete o par e some com o bot (cascata) sem tocar no doc nem nas versões; as versões NÃO apontam para bot nenhum (autor é só "dono" ou "bot").
    await pool.query('INSERT INTO doc_bot_access (doc_id, bot_id) VALUES ($1, $2), ($1, $3), ($4, $2)', [d1, x, y, d2]);
    await expect(pool.query('INSERT INTO doc_bot_access (doc_id, bot_id) VALUES ($1, $2)', [d1, x])).rejects.toThrow(/doc_bot_access_pkey/);
    await expect(pool.query('INSERT INTO doc_bot_access (doc_id, bot_id) VALUES ($1, $2)', [randomUUID(), x])).rejects.toThrow(/doc_bot_access_doc_id_fkey/);
    await expect(pool.query('INSERT INTO doc_bot_access (doc_id, bot_id) VALUES ($1, $2)', [d1, randomUUID()])).rejects.toThrow(/doc_bot_access_bot_id_fkey/);
    const botKeys = await pool.query<{ tabela: string }>("SELECT c.conrelid::regclass::text AS tabela FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = 'bots'::regclass AND c.conrelid::regclass::text LIKE 'doc%'");
    expect(botKeys.rows).toEqual([{ tabela: 'doc_bot_access' }]);
    // Recibo: sem chave estrangeira para o doc (sobrevive à exclusão), um por (ator, operação).
    const receipt = (actor: string, operationId: string, docId: string) =>
      pool.query("INSERT INTO doc_mutation_receipts (actor, operation_id, doc_id, action, payload_hash, result) VALUES ($1, $2, $3, 'doc.update', 'hash', '{}'::jsonb)", [actor, operationId, docId]);
    const operationId = randomUUID();
    await receipt('owner', operationId, d1);
    await receipt(`bot:${x}`, operationId, randomUUID()); // outro ator, mesma operação, doc que nem existe: aceito
    await expect(receipt('owner', operationId, d1)).rejects.toThrow(/doc_mutation_receipts_pkey/);
    await pool.query('DELETE FROM bots WHERE id = $1', [y]);
    expect((await pool.query('SELECT doc_id, bot_id FROM doc_bot_access')).rows.map((row) => `${row.doc_id}:${row.bot_id}`).sort()).toEqual([`${d1}:${x}`, `${d2}:${x}`].sort());
    expect(Number((await pool.query('SELECT count(*) FROM docs')).rows[0].count)).toBe(3);
    expect(Number((await pool.query('SELECT count(*) FROM doc_versions')).rows[0].count)).toBe(3);
    await pool.query('DELETE FROM docs WHERE id = $1', [d1]);
    expect((await pool.query('SELECT doc_id FROM doc_bot_access')).rows.map((row) => row.doc_id)).toEqual([d2]);
    expect((await pool.query('SELECT doc_id FROM doc_versions')).rows.map((row) => row.doc_id)).toEqual([d2]);
    expect(Number((await pool.query('SELECT count(*) FROM doc_mutation_receipts')).rows[0].count)).toBe(2);

    // O SQL de subida é repetível e não apaga o que já está gravado.
    await pool.query(migration.up);
    expect(await counts()).toEqual({ docs: 2, versions: 1, access: 1, receipts: 2 });

    // Rollback com as quatro tabelas CHEIAS (decisão do dono: apaga mesmo com dados): as tabelas somem, o resto fica como estava (o bot Y apagado acima não é dado "de antes": o retrato é refeito sem ele),
    // o rollback roda DUAS vezes sem erro e subir de novo recria as quatro tabelas vazias.
    const afterBotDelete = await existing();
    await pool.query(migration.rollback);
    await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await newTables()).toEqual([]);
    expect(await existing()).toEqual(afterBotDelete);
    expect(afterBotDelete.data_tables).toEqual(before.data_tables);
    expect(afterBotDelete.table_records).toEqual(before.table_records);
    expect(afterBotDelete.memory_versions).toEqual(before.memory_versions);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await newTables()).toEqual(['doc_bot_access', 'doc_mutation_receipts', 'doc_versions', 'docs']);
    expect(await counts()).toEqual({ docs: 0, versions: 0, access: 0, receipts: 0 });
    expect(await existing()).toEqual(afterBotDelete);
  });

  it('A6: o rollback da 0052 remove só as colunas de hash e effort e preserva as linhas de uso, mesmo com as colunas preenchidas', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0052_request_block_hashes')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const NEW_COLUMNS = ['system_hash', 'objective_hash', 'tools_hash', 'history_hash', 'history_turns', 'history_round_hashes', 'history_prior_hash', 'effort'];
    const columns = async () => (await pool.query<{ column_name: string; data_type: string; is_nullable: string }>("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'model_call_usage' AND column_name = ANY($1::text[]) ORDER BY column_name", [NEW_COLUMNS])).rows;
    // O que existia antes: a conversa, a execução e uma chamada principal concluída, como o motor a deixa antes da 0052.
    const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
    const run = (await pool.query<{ id: string }>("INSERT INTO runs (conversation_id, input, created_at, status) VALUES ($1, 'pedido', now(), 'completed') RETURNING id", [conversation])).rows[0]!.id;
    const usageId = randomUUID();
    await pool.query("INSERT INTO model_call_usage (id, conversation_id, run_id, purpose, model, protocol, state, input_tokens, output_tokens, cached_tokens, cache_write_tokens, created_at, completed_at) VALUES ($1, $2, $3, 'main', 'claude-haiku-5-5', 'messages', 'completed', 1000, 5, 800, 100, now(), now())", [usageId, conversation, run]);
    const snapshot = async () => (await pool.query('SELECT id::text, conversation_id::text, run_id::text, purpose, model, protocol, state, input_tokens::text, output_tokens::text, cached_tokens::text, cache_write_tokens::text, reasoning_tokens::text, request_fingerprint FROM model_call_usage ORDER BY id')).rows;
    const before = await snapshot();
    expect(await columns()).toEqual([]);

    // Aditiva: as oito colunas nascem anuláveis (linha antiga fica NULL, sem preenchimento inventado), nada do que existia muda, subir de novo não faz nada e o SQL em si é repetível.
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await columns()).toEqual([
      { column_name: 'effort', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'history_hash', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'history_prior_hash', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'history_round_hashes', data_type: 'ARRAY', is_nullable: 'YES' },
      { column_name: 'history_turns', data_type: 'integer', is_nullable: 'YES' },
      { column_name: 'objective_hash', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'system_hash', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'tools_hash', data_type: 'text', is_nullable: 'YES' },
    ]);
    expect(await snapshot()).toEqual(before);
    expect((await pool.query('SELECT system_hash, objective_hash, tools_hash, history_hash, history_turns, history_round_hashes, history_prior_hash, effort FROM model_call_usage')).rows).toEqual([
      { system_hash: null, objective_hash: null, tools_hash: null, history_hash: null, history_turns: null, history_round_hashes: null, history_prior_hash: null, effort: null },
    ]);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);
    await pool.query(migration.up);

    // Só hash entra: texto que não é sha256 em hex, contagem negativa e effort vazio são recusados pelo banco; hash válido, vetor vazio e nulos passam.
    const hash = 'ab'.repeat(32);
    await pool.query('UPDATE model_call_usage SET system_hash = $1, objective_hash = $1, tools_hash = $1, history_hash = $1, history_prior_hash = $1, history_turns = 4, history_round_hashes = $2::text[], effort = $3 WHERE id = $4', [hash, [hash, hash], 'high', usageId]);
    await pool.query("UPDATE model_call_usage SET history_round_hashes = '{}' WHERE id = $1", [usageId]);
    for (const column of ['system_hash', 'objective_hash', 'tools_hash', 'history_hash', 'history_prior_hash']) {
      await expect(pool.query(`UPDATE model_call_usage SET ${column} = 'Pedido do dono: conteúdo da conversa' WHERE id = $1`, [usageId]), column).rejects.toMatchObject({ code: '23514' });
      await expect(pool.query(`UPDATE model_call_usage SET ${column} = $2 WHERE id = $1`, [usageId, hash.toUpperCase()]), column).rejects.toMatchObject({ code: '23514' });
    }
    await expect(pool.query('UPDATE model_call_usage SET history_round_hashes = $2::text[] WHERE id = $1', [usageId, [hash, 'texto livre']])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE model_call_usage SET history_turns = -1 WHERE id = $1', [usageId])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("UPDATE model_call_usage SET effort = '' WHERE id = $1", [usageId])).rejects.toMatchObject({ code: '23514' });
    await pool.query('UPDATE model_call_usage SET history_round_hashes = $2::text[] WHERE id = $1', [usageId, [hash, hash]]);

    // Rollback com as colunas preenchidas: remove só as novas (a linha com o resto do uso, a execução e a conversa ficam), é repetível e subir de novo as recria vazias.
    await pool.query(migration.rollback);
    await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await columns()).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS total FROM runs WHERE id = $1', [run])).rows[0]).toEqual({ total: 1 });
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect((await pool.query('SELECT system_hash, history_round_hashes, effort FROM model_call_usage')).rows).toEqual([{ system_hash: null, history_round_hashes: null, effort: null }]);
  });

  it('A11: a 0055 prefixa opencode/ nas 9 colunas e no cartão model_without_tools, sem perder nem duplicar linha, e rodar o up de novo não prefixa duas vezes', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0055_provider_model_ids')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    // Banco de produção antes da 0055: os três ids reais do catálogo do OpenCode Go, uma coluna nula por tabela quando ela aceita nulo, e uma linha em cada um dos 9 lugares.
    const ids = { deepseek: 'deepseek-v4.1-flash', haiku: 'claude-haiku-5-5', mimo: 'mimo-v2.6-pro' };
    await pool.query("INSERT INTO bots (name, name_key, color, model, created_at, updated_at) VALUES ('B1','b1','#60A5FA',$1,now(),now()), ('B2','b2','#60A5FA',$2,now(),now()), ('B3','b3','#60A5FA',$3,now(),now()), ('B4','b4','#60A5FA',NULL,now(),now())", [ids.deepseek, ids.haiku, ids.mimo]);
    await pool.query('INSERT INTO general_chat_settings (model, updated_at) VALUES ($1, now())', [ids.deepseek]);
    const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at, preferred_model) VALUES (now(), $1) RETURNING id', [ids.haiku])).rows[0]!.id;
    await pool.query('INSERT INTO conversations (created_at) VALUES (now())');
    await pool.query('UPDATE app_settings SET summary_model = $1', [ids.mimo]);
    await pool.query("INSERT INTO context_summary_refusals (conversation_id, impression, model, outcome, created_at) VALUES ($1, 'impressao-a', $2, 'empty', now())", [conversation, ids.deepseek]);
    await pool.query('INSERT INTO model_profiles (model_id, created_at, updated_at) VALUES ($1, now(), now()), ($2, now(), now()), ($3, now(), now())', [ids.deepseek, ids.haiku, ids.mimo]);
    const run = (await pool.query<{ id: string }>("INSERT INTO runs (conversation_id, input, created_at, status, last_model) VALUES ($1, 'pedido', now(), 'completed', $2) RETURNING id", [conversation, ids.deepseek])).rows[0]!.id;
    await pool.query("INSERT INTO model_call_usage (id, conversation_id, run_id, purpose, model, protocol, state, input_tokens, output_tokens, created_at) VALUES ($1, $2, $3, 'main', $4, 'chat_completions', 'completed', 100, 5, now()), ($5, $2, $3, 'summary', $6, 'messages', 'completed', 200, 9, now())", [randomUUID(), conversation, run, ids.deepseek, randomUUID(), ids.haiku]);
    await pool.query("INSERT INTO messages (conversation_id, run_id, role, kind, status, content, data, created_at) VALUES ($1, $2, 'system', 'card', 'done', '', $3, now()), ($1, $2, 'system', 'card', 'done', '', $4, now())", [conversation, run, JSON.stringify({ type: 'model_without_tools', model: ids.mimo }), JSON.stringify({ type: 'memory_updated', model: 'nao-e-cartao-de-modelo' })]);
    const snapshot = async () => ({
      bots: (await pool.query<{ model: string | null }>('SELECT model FROM bots ORDER BY name')).rows.map((row) => row.model),
      general: (await pool.query<{ model: string }>('SELECT model FROM general_chat_settings')).rows.map((row) => row.model),
      preferred: (await pool.query<{ preferred_model: string | null }>('SELECT preferred_model FROM conversations')).rows.map((row) => row.preferred_model).sort(),
      summary: (await pool.query<{ summary_model: string | null }>('SELECT summary_model FROM app_settings')).rows.map((row) => row.summary_model),
      refusals: (await pool.query<{ model: string }>('SELECT model FROM context_summary_refusals')).rows.map((row) => row.model),
      profiles: (await pool.query<{ model_id: string }>('SELECT model_id FROM model_profiles ORDER BY model_id')).rows.map((row) => row.model_id),
      usage: (await pool.query<{ model: string }>('SELECT model FROM model_call_usage ORDER BY model')).rows.map((row) => row.model),
      lastModel: (await pool.query<{ last_model: string | null }>('SELECT last_model FROM runs')).rows.map((row) => row.last_model),
      cards: (await pool.query<{ type: string; model: string }>("SELECT data->>'type' AS type, data->>'model' AS model FROM messages WHERE kind = 'card' ORDER BY data->>'type'")).rows,
    });
    const before = await snapshot();
    const total = async (table: string) => Number((await pool.query<{ total: string }>(`SELECT count(*) AS total FROM ${table}`)).rows[0]!.total);
    const counts = async () => [await total('bots'), await total('conversations'), await total('model_profiles'), await total('model_call_usage'), await total('messages'), await total('context_summary_refusals')];
    const countsBefore = await counts();
    expect(before.bots).toEqual(['deepseek-v4.1-flash', 'claude-haiku-5-5', 'mimo-v2.6-pro', null]); // a foto de antes é a do banco antigo, sem prefixo

    // A tabela do dono: deepseek -> opencode/deepseek, haiku -> opencode/haiku, mimo -> opencode/mimo, nulo -> nulo; só o cartão model_without_tools muda dentro de messages.data.
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    const after = await snapshot();
    expect(after).toEqual({
      bots: ['opencode/deepseek-v4.1-flash', 'opencode/claude-haiku-5-5', 'opencode/mimo-v2.6-pro', null],
      general: ['opencode/deepseek-v4.1-flash'],
      preferred: [null, 'opencode/claude-haiku-5-5'],
      summary: ['opencode/mimo-v2.6-pro'],
      refusals: ['opencode/deepseek-v4.1-flash'],
      profiles: ['opencode/claude-haiku-5-5', 'opencode/deepseek-v4.1-flash', 'opencode/mimo-v2.6-pro'],
      usage: ['opencode/claude-haiku-5-5', 'opencode/deepseek-v4.1-flash'],
      lastModel: ['opencode/deepseek-v4.1-flash'],
      cards: [{ type: 'memory_updated', model: 'nao-e-cartao-de-modelo' }, { type: 'model_without_tools', model: 'opencode/mimo-v2.6-pro' }],
    });
    expect(await counts()).toEqual(countsBefore);

    // Idempotente: o SQL repetido não duplica o prefixo, e um id que já traga `anthropic/` (do catálogo novo) nunca é prefixado.
    await pool.query("UPDATE bots SET model = 'anthropic/claude-haiku-5-5' WHERE name = 'B2'");
    await pool.query(migration.up);
    expect(await snapshot()).toEqual({ ...after, bots: ['opencode/deepseek-v4.1-flash', 'anthropic/claude-haiku-5-5', 'opencode/mimo-v2.6-pro', null] });
    expect(await counts()).toEqual(countsBefore);
  });

  it('0055: os CHECKs de tamanho sobem de 200 para 209 nas 7 colunas, o perfil ganha hidden_at e a credencial aceita o kind anthropic com a coluna do saldo esgotado', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0055_provider_model_ids')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const longId = (length: number) => `opencode/${'m'.repeat(length - 'opencode/'.length)}`;
    // Antes: o CHECK de 200 recusa o id de 209, e a credencial anthropic não existe.
    await expect(pool.query('INSERT INTO model_profiles (model_id, created_at, updated_at) VALUES ($1, now(), now())', [longId(209)])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("INSERT INTO credentials (kind, secret_sealed, masked, created_at, updated_at) VALUES ('anthropic', 'v1.x.y.z', 'abcd', now(), now())")).rejects.toMatchObject({ code: '23514' });
    expect((await pool.query("SELECT 1 FROM information_schema.columns WHERE (table_name = 'model_profiles' AND column_name = 'hidden_at') OR (table_name = 'credentials' AND column_name = 'credits_exhausted_at')")).rowCount).toBe(0);

    await migrateTestDatabase(pool, { migrations: upTo(migration.id) });
    const definitions = (await pool.query<{ conname: string; def: string }>(
      'SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname',
      [['bots_model_check', 'general_chat_settings_model_check', 'conversations_preferred_model_check', 'app_settings_summary_model_check', 'context_summary_refusals_model_check', 'model_profiles_model_id_check', 'runs_last_model_check']])).rows;
    expect(definitions).toHaveLength(7);
    for (const { conname, def } of definitions) expect(def, conname).toContain('209');
    // Os nulos continuam aceitos onde a coluna aceita nulo, e vazio continua recusado.
    await pool.query("INSERT INTO bots (name, name_key, color, model, created_at, updated_at) VALUES ('Longo','longo','#60A5FA',$1,now(),now()), ('Sem modelo','sem-modelo','#60A5FA',NULL,now(),now())", [longId(209)]);
    await expect(pool.query("INSERT INTO bots (name, name_key, color, model, created_at, updated_at) VALUES ('Maior','maior','#60A5FA',$1,now(),now())", [longId(210)])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("INSERT INTO bots (name, name_key, color, model, created_at, updated_at) VALUES ('Vazio','vazio','#60A5FA','',now(),now())")).rejects.toMatchObject({ code: '23514' });
    await pool.query('INSERT INTO model_profiles (model_id, created_at, updated_at) VALUES ($1, now(), now())', [longId(209)]);
    // hidden_at nasce nulo (visível) e a credencial da Anthropic entra, com a coluna do saldo esgotado nula.
    expect((await pool.query('SELECT hidden_at FROM model_profiles')).rows).toEqual([{ hidden_at: null }]);
    await pool.query("INSERT INTO credentials (kind, secret_sealed, masked, created_at, updated_at) VALUES ('anthropic', 'v1.x.y.z', 'abcd', now(), now())");
    expect((await pool.query("SELECT credits_exhausted_at FROM credentials WHERE kind = 'anthropic'")).rows).toEqual([{ credits_exhausted_at: null }]);
    await expect(pool.query("INSERT INTO credentials (kind, secret_sealed, masked, created_at, updated_at) VALUES ('outro', 'v1.x.y.z', 'abcd', now(), now())")).rejects.toMatchObject({ code: '23514' });
    expect(migration.destructive).toBeFalsy(); // aditiva: roda no deploy sem o pedido do dono
  });

  it('0041 acrescenta o modelo do resumo (nulo, com CHECK de tamanho) sem tocar no resto de app_settings, e o rollback remove só essa coluna', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0041_summary_model')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const hasColumn = async () => ((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'summary_model'")).rowCount ?? 0) > 0;
    const others = async () => (await pool.query('SELECT language, time_zone, owner_name, bot_context_window_tokens, general_chat_context_window_tokens FROM app_settings')).rows[0];
    // Banco de produção antes da 0041: o dono já escolheu idioma, nome e janela.
    await pool.query("UPDATE app_settings SET language = 'en', owner_name = 'Marco', bot_context_window_tokens = 131072");
    const before = await others();
    expect(await hasColumn()).toBe(false);

    // Aditiva: a coluna nasce nula (= "o modelo da conversa") e nada do que já existia muda; subir de novo não faz nada, e o SQL em si também é repetível.
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await hasColumn()).toBe(true);
    expect((await pool.query('SELECT summary_model FROM app_settings')).rows).toEqual([{ summary_model: null }]);
    expect(await others()).toEqual(before);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);
    await pool.query(migration.up);

    // O CHECK aceita nulo e de 1 a 200 caracteres e recusa vazio e 201 (a validação do modelo em si é do serviço, não do banco).
    for (const accepted of ['glm-5.1', 'a'.repeat(200), null]) {
      await pool.query('UPDATE app_settings SET summary_model = $1', [accepted]);
    }
    for (const refused of ['', 'a'.repeat(201)]) {
      await expect(pool.query('UPDATE app_settings SET summary_model = $1', [refused])).rejects.toThrow(/summary_model/);
    }

    // Rollback: remove só a coluna (idempotente) e o resto de app_settings segue com os valores do dono; subir de novo a recria nula.
    await pool.query("UPDATE app_settings SET summary_model = 'glm-5.1'");
    await pool.query(migration.rollback);
    await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await hasColumn()).toBe(false);
    expect(await others()).toEqual(before);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect((await pool.query('SELECT summary_model FROM app_settings')).rows).toEqual([{ summary_model: null }]);
  });

  it('0042 acrescenta a tabela de recusas do resumo e o índice GIN parcial dos resultados sem tocar nas mensagens, e o rollback remove só os dois', async () => {
    const pool = await freshPool();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0042_summary_refusal')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    const tableExists = async () => ((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'context_summary_refusals'")).rowCount ?? 0) > 0;
    const indexDef = async () => (await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_result_search'")).rows[0]?.indexdef ?? null;
    // Banco de produção antes da 0042: já há uma conversa com um resultado de ferramenta concluído e um texto do dono.
    const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
    await pool.query("INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, created_at) VALUES ($1, 'user', 'text', 'done', true, 'pedido do dono', now())", [conversation]);
    await pool.query("INSERT INTO messages (conversation_id, role, kind, status, step, content, data, created_at) VALUES ($1, 'assistant', 'activity', 'completed', 1, 'protocolo ZX900 aberto', '{\"tool\":\"t\"}', now())", [conversation]);
    const before = (await pool.query('SELECT id, content, status FROM messages ORDER BY id')).rows;
    expect(await tableExists()).toBe(false);
    expect(await indexDef()).toBeNull();

    // Aditiva: tabela e índice nascem, o índice com a configuração tolerante a acento (a 0016 criou a extensão) e só sobre resultados concluídos; mensagens intactas.
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await tableExists()).toBe(true);
    const definition = (await indexDef())!;
    expect(definition).toContain('portuguese_unaccent');
    expect(definition).toContain("kind = 'activity'::text");
    expect(definition).toContain("status = 'completed'::text");
    expect(definition).toContain('100000');
    expect((await pool.query('SELECT id, content, status FROM messages ORDER BY id')).rows).toEqual(before);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([]);
    await pool.query(migration.up);

    // A tabela guarda uma recusa por conjunto (chave: conversa + impressão), só com desfechos conhecidos, e some junto com a conversa (sem apagar o resto).
    const refuse = (impression: string, outcome = 'empty', runId: string | null = null) => pool.query(
      'INSERT INTO context_summary_refusals (conversation_id, impression, run_id, model, outcome, created_at) VALUES ($1, $2, $3, $4, $5, now())', [conversation, impression, runId, 'glm-5.1', outcome]);
    await refuse('a'.repeat(64));
    await expect(refuse('a'.repeat(64))).rejects.toThrow(/context_summary_refusals_pkey/);
    await expect(refuse('b'.repeat(64), 'outro')).rejects.toThrow(/outcome/);
    await expect(refuse('', 'empty')).rejects.toThrow(/impression/);
    const empty = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
    await pool.query("INSERT INTO context_summary_refusals (conversation_id, impression, model, outcome, created_at) VALUES ($1, 'c', 'glm-5.1', 'format', now())", [empty]);
    await pool.query('DELETE FROM conversations WHERE id = $1', [empty]);
    expect((await pool.query('SELECT impression FROM context_summary_refusals')).rows).toEqual([{ impression: 'a'.repeat(64) }]);

    // Rollback: remove só a tabela e o índice (idempotente); subir de novo recria os dois.
    const kept = (await pool.query('SELECT count(*) AS total FROM messages')).rows[0];
    await pool.query(migration.rollback);
    await pool.query(migration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    expect(await tableExists()).toBe(false);
    expect(await indexDef()).toBeNull();
    expect((await pool.query('SELECT count(*) AS total FROM messages')).rows[0]).toEqual(kept);
    expect(await migrateTestDatabase(pool, { migrations: upTo(migration.id) })).toEqual([migration.id]);
    expect(await tableExists()).toBe(true);
    expect(await indexDef()).not.toBeNull();
  });

  it('0016 e 0042 desfazem em qualquer ordem (o índice dos resultados depende da configuração da 0016) e o procedimento da 0016 devolve o índice à busca tolerante', async () => {
    const pool = await freshPool();
    await migrateTestDatabase(pool);
    const unaccent = MIGRATIONS.find((candidate) => candidate.id === '0016_history_search_unaccent')!;
    const refusal = MIGRATIONS.find((candidate) => candidate.id === '0042_summary_refusal')!;
    const indexDef = async (name: string) => (await pool.query<{ indexdef: string }>('SELECT indexdef FROM pg_indexes WHERE indexname = $1', [name])).rows[0]?.indexdef ?? null;
    const tolerantConfig = async () => ((await pool.query("SELECT 1 FROM pg_ts_config WHERE cfgname = 'portuguese_unaccent'")).rowCount ?? 0) > 0;
    // Desfaz como o dono faria: roda o plano de rollback e apaga a linha do registro.
    const unapply = async (migration: Migration) => {
      await pool.query(migration.rollback);
      await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    };
    // Banco com histórico: um texto e um resultado de ferramenta concluído, que nenhum rollback pode tocar.
    const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
    await pool.query("INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, created_at) VALUES ($1, 'user', 'text', 'done', true, 'pedido do dono', now())", [conversation]);
    await pool.query("INSERT INTO messages (conversation_id, role, kind, status, step, content, data, created_at) VALUES ($1, 'assistant', 'activity', 'completed', 1, 'protocolo ZX900 aberto', '{\"tool\":\"t\"}', now())", [conversation]);
    const messages = async () => (await pool.query('SELECT id, content, status FROM messages ORDER BY id')).rows;
    const before = await messages();

    const tolerant = (await indexDef('messages_result_search'))!;
    expect(tolerant).toContain("'portuguese_unaccent'::regconfig");
    const fallback = tolerant.replace("'portuguese_unaccent'::regconfig", "'portuguese'::regconfig");

    // Ordem 1: a 0016 primeiro, com a 0042 ainda aplicada. A configuração sai, o índice dos resultados passa para `portuguese` (mesmo corte e predicado) e segue
    // existindo; o rollback é idempotente. Depois a 0042 sai sem erro, qualquer que seja a configuração do índice.
    await unapply(unaccent);
    await pool.query(unaccent.rollback);
    expect(await tolerantConfig()).toBe(false);
    expect(await indexDef('messages_result_search')).toBe(fallback);
    expect(await indexDef('messages_search')).toContain("to_tsvector('portuguese'::regconfig, content)");
    await unapply(refusal);
    expect(await indexDef('messages_result_search')).toBeNull();
    expect(await messages()).toEqual(before);
    // Subir tudo de novo recria a configuração e os dois índices na configuração tolerante, idêntico ao original.
    expect(await migrateTestDatabase(pool)).toEqual([unaccent.id, refusal.id]);
    expect(await tolerantConfig()).toBe(true);
    expect(await indexDef('messages_result_search')).toBe(tolerant);

    // Ordem 2: a 0042 primeiro e depois a 0016 (a ordem reversa do registro). Nada sobra do índice dos resultados nem da configuração.
    await unapply(refusal);
    await unapply(unaccent);
    expect(await tolerantConfig()).toBe(false);
    expect(await indexDef('messages_result_search')).toBeNull();
    expect(await indexDef('messages_search')).toContain("to_tsvector('portuguese'::regconfig, content)");
    expect(await migrateTestDatabase(pool)).toEqual([unaccent.id, refusal.id]);
    expect(await indexDef('messages_result_search')).toBe(tolerant);

    // Procedimento do cabeçalho da 0016 com a 0042 aplicada (rollback, apagar a linha, reiniciar a API): só a 0016 está pendente, e o índice dos resultados volta a
    // usar a configuração tolerante sem ninguém recriá-lo à mão (a busca de resultados volta a usar o índice).
    await unapply(unaccent);
    expect(await indexDef('messages_result_search')).toBe(fallback);
    expect(await migrateTestDatabase(pool)).toEqual([unaccent.id]);
    expect(await tolerantConfig()).toBe(true);
    expect(await indexDef('messages_result_search')).toBe(tolerant);
    expect(await indexDef('messages_search')).toContain("to_tsvector('portuguese_unaccent'::regconfig, content)");
    expect(await messages()).toEqual(before);
  });

  it('todas têm plano de rollback executável que devolve o banco ao vazio, e o up pode rodar de novo depois', async () => {
    const pool = await freshPool();
    await migrateTestDatabase(pool);
    for (const migration of [...MIGRATIONS].reverse()) {
      expect(migration.rollback.trim().length).toBeGreaterThan(0);
      // O rollback da 0046 devolve 128k ao global dos bots (o valor de antes dela, decisão 26 da spec da phase 11) e a guarda da 0033 trata qualquer global fora
      // do padrão original (32k) como escolha do dono e recusa. Este teste modela o dono que nunca escolheu nada, então volta o global ao padrão original antes da 0033.
      if (migration.id === '0033_context_preferences') await pool.query('UPDATE app_settings SET bot_context_window_tokens = 32768, general_chat_context_window_tokens = 32768');
      await pool.query(migration.rollback);
      await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    }
    expect(await userTables(pool)).toEqual(['schema_migrations']);
    expect(await migrateTestDatabase(pool)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('0018 dá a cada bot que já existia um personagem calculado do id (estável, nos seis valores) e o rollback remove só a coluna', async () => {
    const pool = await freshPool();
    const mascotMigration = MIGRATIONS.find((migration) => migration.id === '0018_bot_mascot')!;
    await runMigrations(pool, { migrations: MIGRATIONS.filter((migration) => migration.id < mascotMigration.id) });

    // A fórmula documentada na migration, escrita aqui em JavaScript: os 7 primeiros dígitos hexadecimais do id, módulo 6, indexam a lista fixa.
    const expectedFor = (id: string): string => LEGACY_MASCOTS[parseInt(id.slice(0, 7), 16) % LEGACY_MASCOTS.length]!;
    // Um id para cada resto (0 a 5), mais ids aleatórios: o preenchimento cobre os seis personagens e não depende de sorte.
    const perRest = [...LEGACY_MASCOTS.keys()].map((rest) => `000000${rest}0-0000-4000-8000-000000000000`);
    const ids = [...perRest];
    for (let index = 0; index < 30; index += 1) ids.push(randomUUID());
    for (const [index, id] of ids.entries()) {
      await pool.query("INSERT INTO bots (id, name, name_key, color, created_at, updated_at) VALUES ($1, $2, $2, '#60A5FA', now(), now())", [id, `bot ${index}`]);
    }
    expect((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'bots' AND column_name = 'mascot'")).rowCount).toBe(0); // antes da migration não há coluna

    // A prova desta migration usa o registro até ela; migrations posteriores têm suas próprias provas.
    expect(await runMigrations(pool, { migrations: upTo(mascotMigration.id) })).toEqual([mascotMigration.id]);
    const snapshot = async () => (await pool.query<{ id: string; mascot: string }>('SELECT id, mascot FROM bots ORDER BY id')).rows;
    const filled = await snapshot();
    expect(filled).toHaveLength(ids.length);
    for (const row of filled) expect(row.mascot, row.id).toBe(expectedFor(row.id));
    expect(new Set(filled.map((row) => row.mascot))).toEqual(new Set(LEGACY_MASCOTS)); // os seis aparecem
    // Um id por resto: o personagem de cada um é o da posição dele na lista (resto 0 = Bolinha ... resto 5 = Pílula).
    for (const [rest, id] of perRest.entries()) expect(filled.find((row) => row.id === id)?.mascot).toBe(LEGACY_MASCOTS[rest]);

    // Rollback: remove só a coluna (nome, cor e todas as linhas seguem), e roda de novo sem erro. Reaplicar devolve o MESMO personagem a cada bot.
    await pool.query(mascotMigration.rollback);
    await pool.query(mascotMigration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [mascotMigration.id]);
    expect((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'bots' AND column_name = 'mascot'")).rowCount).toBe(0);
    const remaining = await pool.query<{ name: string; color: string }>('SELECT name, color FROM bots');
    expect(remaining.rowCount).toBe(ids.length);
    expect(remaining.rows.every((row) => row.color === '#60A5FA')).toBe(true);
    await runMigrations(pool, { migrations: upTo(mascotMigration.id) });
    expect(await snapshot()).toEqual(filled);

    // O valor é só dado depois do preenchimento: a coluna é obrigatória, restrita à lista e tem a Bolinha como padrão.
    await expect(pool.query("UPDATE bots SET mascot = 'estrela' WHERE id = $1", [ids[0]])).rejects.toThrow(/bots_mascot_check/);
    await expect(pool.query('UPDATE bots SET mascot = NULL WHERE id = $1', [ids[0]])).rejects.toThrow(/mascot/);
    const fresh = await pool.query<{ mascot: string }>("INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ('novo', 'novo', '#60A5FA', now(), now()) RETURNING mascot");
    expect(fresh.rows[0]?.mascot).toBe('circle');
  });

  it('0028 remove bots.mascot sem tocar no resto, só roda com o pedido do dono, e o rollback recria a coluna com o valor da 0018 calculado do id', async () => {
    const pool = await freshPool();
    const dropMigration = MIGRATIONS.find((migration) => migration.id === '0028_drop_bot_mascot')!;
    expect(dropMigration.destructive).toBe(true);
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((migration) => migration.id < dropMigration.id) }); // a coluna ainda existe

    // Bots com dados: um id para cada resto da fórmula da 0018 (0 a 5) e ids aleatórios, todos com um personagem que o dono tinha escolhido ('pill'), que a
    // 0028 descarta. O rollback devolve o valor calculado do id, não o escolhido.
    const perRest = [...LEGACY_MASCOTS.keys()].map((rest) => `000000${rest}0-0000-4000-8000-000000000000`);
    const ids = [...perRest];
    for (let index = 0; index < 30; index += 1) ids.push(randomUUID());
    for (const [index, id] of ids.entries()) {
      await pool.query("INSERT INTO bots (id, name, name_key, color, mascot, created_at, updated_at) VALUES ($1, $2, $2, '#4ADE80', 'pill', now(), now())", [id, `bot ${index}`]);
    }
    const hasColumn = async () => (await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'bots' AND column_name = 'mascot'")).rowCount === 1;
    const untouched = async () => (await pool.query<{ id: string; name: string; color: string }>('SELECT id, name, color FROM bots ORDER BY id')).rows;
    const before = await untouched();
    expect(await hasColumn()).toBe(true);

    // Sem o pedido explícito do dono, a API recusaria subir: o migrator bloqueia pela mensagem de sempre e não toca no banco.
    await expect(runMigrations(pool)).rejects.toThrow('Migration destrutiva bloqueada (0028_drop_bot_mascot): exige AION_ALLOW_DESTRUCTIVE_MIGRATIONS=true.');
    expect(await hasColumn()).toBe(true);

    // Com o pedido: aplica (e as migrations seguintes, que ficaram pendentes atrás dela), a coluna sai e todos os bots, nomes e cores seguem como estavam.
    expect(await migrateTestDatabase(pool)).toEqual(MIGRATIONS.filter((migration) => migration.id >= dropMigration.id).map((migration) => migration.id));
    expect(await hasColumn()).toBe(false);
    expect(await untouched()).toEqual(before);

    // Rollback: recria a coluna e refaz o preenchimento da 0018 pela fórmula do id (os 7 primeiros dígitos hexadecimais, módulo 6), nos seis valores.
    const expectedFor = (id: string): string => LEGACY_MASCOTS[parseInt(id.slice(0, 7), 16) % LEGACY_MASCOTS.length]!;
    await pool.query(dropMigration.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [dropMigration.id]);
    const restored = (await pool.query<{ id: string; mascot: string }>('SELECT id, mascot FROM bots ORDER BY id')).rows;
    expect(restored).toHaveLength(ids.length);
    for (const row of restored) expect(row.mascot, row.id).toBe(expectedFor(row.id));
    expect(new Set(restored.map((row) => row.mascot))).toEqual(new Set(LEGACY_MASCOTS));
    for (const [position, id] of perRest.entries()) expect(restored.find((row) => row.id === id)?.mascot).toBe(LEGACY_MASCOTS[position]);
    expect(await untouched()).toEqual(before);

    // A coluna volta como a 0018 a criou: obrigatória, restrita aos seis ids e com a Bolinha de padrão.
    await expect(pool.query("UPDATE bots SET mascot = 'estrela' WHERE id = $1", [ids[0]])).rejects.toThrow(/bots_mascot_check/);
    await expect(pool.query('UPDATE bots SET mascot = NULL WHERE id = $1', [ids[0]])).rejects.toThrow(/mascot/);
    const fresh = await pool.query<{ mascot: string }>("INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ('novo', 'novo', '#60A5FA', now(), now()) RETURNING mascot");
    expect(fresh.rows[0]?.mascot).toBe('circle');
    await pool.query("DELETE FROM bots WHERE name_key = 'novo'");

    // O rollback é idempotente: rodar de novo, com a coluna já recriada, não recalcula o que o código antigo possa ter gravado desde então.
    await pool.query("UPDATE bots SET mascot = 'pill' WHERE id = $1", [perRest[0]]);
    await pool.query(dropMigration.rollback);
    expect((await pool.query<{ mascot: string }>('SELECT mascot FROM bots WHERE id = $1', [perRest[0]])).rows[0]?.mascot).toBe('pill');

    // Reaplicar remove de novo a coluna, ainda sem perder nada do resto.
    expect(await migrateTestDatabase(pool)).toEqual([dropMigration.id]);
    expect(await hasColumn()).toBe(false);
    expect(await untouched()).toEqual(before);
  });

  it('toda chave estrangeira tem um índice que começa pela coluna dela (o PostgreSQL não o cria sozinho)', async () => {
    const pool = await freshPool();
    await migrateTestDatabase(pool);
    // Atende a FK um índice cuja primeira coluna é a da FK e que vale para qualquer linha não nula (o parcial `IS NOT NULL` serve:
    // a conferência da FK só procura valores não nulos). Índice parcial por outra condição não atende (ex.: só execuções ativas).
    const uncovered = await pool.query<{ tabela: string; coluna: string }>(
      `SELECT c.conrelid::regclass::text AS tabela, a.attname AS coluna
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
           WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]
             AND (i.indpred IS NULL OR pg_get_expr(i.indpred, i.indrelid) = '(' || a.attname || ' IS NOT NULL)'))
       ORDER BY 1, 2`,
    );
    expect(uncovered.rows).toEqual([]);
  });

  it('o registro é ordenado e único, e SQL destrutivo só entra declarado e com pedido explícito do dono', async () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const migration of MIGRATIONS) {
      expect(migration.id).toMatch(/^\d{4}_[a-z0-9_]+$/);
      // Se o `up` parece destrutivo, a migration precisa se declarar destrutiva.
      if (DESTRUCTIVE_SQL_PATTERN.test(migration.up)) expect(migration.destructive).toBe(true);
    }

    const pool = await freshPool();
    await migrateTestDatabase(pool);
    const destructive: Migration = {
      id: '9999_remove_estado',
      description: 'remove app_state',
      up: 'DROP TABLE app_state;',
      rollback: 'CREATE TABLE app_state (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());',
      destructive: true,
    };
    const all = [...MIGRATIONS, destructive];

    // Sem o pedido explícito, bloqueia e não toca em nada.
    await expect(runMigrations(pool, { migrations: all })).rejects.toThrow(/destrutiva bloqueada/);
    expect(await userTables(pool)).toContain('app_state');
    // Com o pedido explícito, aplica.
    expect(await runMigrations(pool, { migrations: all, allowDestructive: true })).toEqual(['9999_remove_estado']);
    expect(await userTables(pool)).not.toContain('app_state');
  });
});
