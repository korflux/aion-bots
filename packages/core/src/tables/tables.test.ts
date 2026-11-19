// Jornada de dois bots e dono no PostgreSQL real: tipos, concorrência, replay, relações e sobrevivência sem bots.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { tableCreateSchema, tableWriteSchema, type TableColumnInput, type TableCell } from '@aion/shared';
import { BotService } from '../bots/service';
import { createPool, type Pool } from '../db/pool';
import { botTablesMigration } from '../db/migrations/0030_bot_tables';
import { migrateTestDatabase } from '../testing/migrate';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { TableService } from './service';

let database: TestDatabase;
let pool: Pool;
let tables: TableService;
let bots: BotService;
const owner = { kind: 'owner' } as const;
const origin = { ip: '203.0.113.12', userAgent: 'tables-test' };
/** Cada chamada nova recebe identidade independente; testes de replay reutilizam explicitamente a mesma. */
const operation = () => randomUUID();
/** Entrada de criação passa pelo contrato público antes de alcançar o serviço. */
const createInput = (name: string, columns: TableColumnInput[] = []) => tableCreateSchema.parse({ name, columns, operationId: operation() });
beforeAll(async () => {
  database = await createTestDatabase(inject('adminDatabaseUrl'));
  pool = createPool(database.url, { applicationName: 'tables-test' });
  await migrateTestDatabase(pool);
  tables = new TableService({ pool });
  bots = new BotService({ pool, models: { validateSelection: async () => undefined } });
});
afterAll(async () => { await pool?.end(); await database?.drop(); });

/** Fixture de bot pelos serviços reais, sem depender do catálogo externo. */
const bot = (name: string) => bots.create({ name, color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 50 }, origin);

describe('tables persistência e autorização', () => {
  it('leitura individual completa é exclusiva do dono; bot continua limitado à consulta projetada', async () => {
    const a = await bot('Registro completo'); const actor = { kind: 'bot', botId: a.id } as const;
    const table = await tables.create(createInput('Registro completo', [{ name: 'A', type: 'text' }, { name: 'B', type: 'text' }, { name: 'C', type: 'text' }]), actor);
    const values = Object.fromEntries(table.columns.map((column) => [column.id, '漢'.repeat(8000)]));
    const written = await tables.write(table.id, { operationId: operation(), expectedSchemaVersion: 1, creates: [{ values }], updates: [] }, owner);
    const record = written.records[0]!;
    expect(await tables.readRecord(table.id, record.id, owner)).toEqual(record);
    await expect(tables.readRecord(table.id, record.id, actor)).rejects.toMatchObject({ code: 'TABLE_ACCESS_DENIED' });
    await expect(tables.readRecord(table.id, record.id, { kind: 'chat' })).rejects.toMatchObject({ code: 'TABLE_ACCESS_DENIED' });
    await expect(tables.lookupRecords(table.id, { ids: [record.id] }, actor)).rejects.toMatchObject({ code: 'TABLE_QUERY_LIMIT' });
    expect((await tables.lookupRecords(table.id, { ids: [record.id], columns: [table.columns[0]!.id] }, actor)).records[0]!.values).toEqual({ [table.columns[0]!.id]: values[table.columns[0]!.id] });
  });
  it('lookup pagina nomes íntegros em 64 KiB, vincula cursor e reautoriza acesso atual', async () => {
    const a = await bot('Lookup A'); const b = await bot('Lookup B');
    const actor = { kind: 'bot', botId: a.id } as const;
    const other = { kind: 'bot', botId: b.id } as const;
    const table = await tables.create(createInput('Lookup', [{ name: 'Primeiro', type: 'text' }, { name: 'Alternativo', type: 'text' }, { name: 'Oculto', type: 'boolean' }]), actor);
    const [first, second, secret] = table.columns;
    const written = await tables.write(table.id, { operationId: operation(), expectedSchemaVersion: 1, updates: [], creates: Array.from({ length: 4 }, () => ({ values: { [first!.id]: null, [second!.id]: '界'.repeat(8000), [secret!.id]: false } })) }, owner);
    const foreign = await tables.create(createInput('Outra'), actor);
    const foreignRows = await tables.write(foreign.id, { operationId: operation(), expectedSchemaVersion: 1, updates: [], creates: [{ values: {} }] }, owner);
    const ids = [...written.records.map((row) => row.id), foreignRows.records[0]!.id, operation()];
    const input = { ids, columns: [first!.id, second!.id], limit: 100 };
    const page = await tables.lookupRecords(table.id, input, actor);
    expect(page.totalCount).toBe(4); expect(page.hasMore).toBe(true);
    const found: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await tables.lookupRecords(table.id, { ...input, ...(cursor ? { cursor } : {}) }, actor);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
      for (const row of result.records) { expect(row.values).toEqual({ [first!.id]: null, [second!.id]: '界'.repeat(8000) }); found.push(row.id); }
      cursor = result.nextCursor;
    } while (cursor);
    expect(found.sort()).toEqual(written.records.map((row) => row.id).sort());
    await expect(tables.lookupRecords(table.id, { ...input, ids: ids.slice(1), cursor: page.nextCursor! }, actor)).rejects.toMatchObject({ code: 'TABLE_QUERY_LIMIT' });
    await expect(tables.lookupRecords(table.id, { ids: [ids[0]!, ids[0]!] }, actor)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(tables.lookupRecords(table.id, input, other)).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    let current = await tables.get(table.id, owner);
    await tables.share(table.id, { operationId: operation(), expectedVersion: current.version, botIds: [a.id, b.id] }, owner);
    const allowed = await tables.lookupRecords(table.id, input, other);
    current = await tables.get(table.id, owner);
    await tables.share(table.id, { operationId: operation(), expectedVersion: current.version, botIds: [a.id] }, owner);
    await expect(tables.lookupRecords(table.id, { ...input, cursor: allowed.nextCursor! }, other)).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    current = await tables.get(table.id, owner);
    const removed = written.records[0]!;
    const prepared = await tables.prepareDestructive(table.id, { kind: 'delete_records', expectedVersion: current.version, records: [{ id: removed.id, expectedVersion: removed.version }] }, owner);
    await tables.confirmDestructive(table.id, { preparationId: prepared.preparationId, operationId: operation(), confirmation: true }, owner);
    expect(await tables.lookupRecords(table.id, { ids: [removed.id] }, actor)).toMatchObject({ records: [], totalCount: 0 });
  });
  it('mantém todos os escalares exatos, patches parciais, conflitos e replay sem efeitos duplicados', async () => {
    const a = await bot('Escalares A');
    const b = await bot('Escalares B');
    const c = await bot('Sem acesso');
    const choice = operation();
    const columnInputs: TableColumnInput[] = [
      { name: 'Texto', type: 'text' }, { name: 'Número', type: 'number' }, { name: 'Dinheiro', type: 'money', currency: 'BRL' },
      { name: 'Sim', type: 'boolean' }, { name: 'Escolha', type: 'select', options: [{ id: choice, label: 'A' }] },
      { name: 'Escolhas', type: 'multiselect', options: [{ id: choice, label: 'A' }] },
      { name: 'Data', type: 'date' }, { name: 'Hora', type: 'time' }, { name: 'Instante', type: 'datetime' },
    ];
    const input = createInput('Escalares', columnInputs);
    const table = await tables.create(input, { kind: 'bot', botId: a.id });
    expect(await tables.create(input, { kind: 'bot', botId: a.id })).toEqual(table);
    expect(table.botIds).toEqual([]); // bot não recebe o catálogo de associações do dono
    await expect(tables.get(table.id, { kind: 'bot', botId: c.id })).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    await expect(tables.get(table.id, { kind: 'chat' })).rejects.toMatchObject({ code: 'TABLE_ACCESS_DENIED' });
    await expect(tables.get(table.id, { kind: 'bot' } as never)).rejects.toMatchObject({ code: 'TABLE_ACCESS_DENIED' });
    await expect(tables.share(table.id, { operationId: operation(), expectedVersion: 1, botIds: [b.id] }, { kind: 'bot', botId: a.id })).rejects.toMatchObject({ code: 'TABLE_ACCESS_DENIED' });
    await tables.share(table.id, { operationId: operation(), expectedVersion: 1, botIds: [a.id, b.id] }, owner);
    const cells: TableCell[] = ['Texto privado', '0.123456', '-999999999999.99', false, choice, [choice], '2024-02-29', '23:59', '2024-02-29T23:59:00-03:00'];
    const values = Object.fromEntries(table.columns.map((column, index) => [column.id, cells[index]!]));
    const write = tableWriteSchema.parse({ operationId: operation(), expectedSchemaVersion: 1, creates: [{ values, deduplicationKey: 'mes:2024-02' }, { values: {} }] });
    const result = await tables.write(table.id, write, { kind: 'bot', botId: a.id });
    expect(result.records[0]!.values).toEqual(values);
    expect(Object.values(result.records[1]!.values)).toEqual(Array(9).fill(null));
    expect(await tables.write(table.id, write, { kind: 'bot', botId: a.id })).toEqual(result);
    const duplicate = await tables.write(table.id, tableWriteSchema.parse({ ...write, operationId: operation(), creates: [write.creates[0]] }), { kind: 'bot', botId: b.id });
    expect(duplicate.records[0]!.id).toBe(result.records[0]!.id);
    const record = result.records[0]!;
    const patch = { expectedSchemaVersion: 1, creates: [], updates: [{ id: record.id, expectedVersion: 1, values: { [table.columns[0]!.id]: 'Atualizado' } }] };
    const concurrency = await Promise.allSettled([tables.write(table.id, { ...patch, operationId: operation() }, owner), tables.write(table.id, { ...patch, operationId: operation() }, { kind: 'bot', botId: b.id })]);
    expect(concurrency.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(concurrency.find((item) => item.status === 'rejected')).toMatchObject({ reason: { code: 'TABLE_CONFLICT' } });
    const saved = (await tables.records(table.id, owner)).records.find((row) => row.id === record.id)!;
    expect(saved.values).toEqual({ ...values, [table.columns[0]!.id]: 'Atualizado' });
    // Falha no último registro do lote desfaz o primeiro e não deixa recibo.
    const invalidOp = operation();
    await expect(tables.write(table.id, tableWriteSchema.parse({ operationId: invalidOp, expectedSchemaVersion: 1, creates: [{ values: {} }, { values: { [table.columns[6]!.id]: '2023-02-29' } }] }), owner)).rejects.toMatchObject({ code: 'TABLE_INVALID_VALUE' });
    expect((await tables.records(table.id, owner)).records).toHaveLength(2);
    expect((await pool.query('SELECT 1 FROM table_mutation_receipts WHERE operation_id = $1', [invalidOp])).rowCount).toBe(0);
    for (const [index, invalid] of [[1, '01'], [1, '0.1234567'], [1, '1000000000000000000'], [2, '1.001'], [2, 0.1], [3, 'true'], [4, operation()], [7, '24:00']] as const) {
      await expect(tables.write(table.id, { operationId: operation(), expectedSchemaVersion: 1, creates: [{ values: { [table.columns[index]!.id]: invalid } }], updates: [] } as never, owner)).rejects.toHaveProperty('code');
    }
    const preserved = await tables.write(table.id, { operationId: operation(), expectedSchemaVersion: 1, creates: [write.creates[0]!], updates: [] }, owner);
    expect(preserved.records[0]!.values).toEqual(saved.values); // dedup original não sobrescreve edição posterior
    await expect(tables.write(table.id, { operationId: operation(), expectedSchemaVersion: 1, creates: [{ values: {}, deduplicationKey: 'mes:2024-02' }], updates: [] }, owner)).rejects.toMatchObject({ code: 'TABLE_CONFLICT' });
    const renamed = await tables.update(table.id, { operationId: operation(), expectedSchemaVersion: 1, columns: table.columns.map((column, index) => ({ ...column, name: `Renomeado ${index}` })) }, owner);
    expect(renamed.columns.map((column) => column.id)).toEqual(table.columns.map((column) => column.id));
    await expect(tables.write(table.id, { ...patch, operationId: operation() }, owner)).rejects.toMatchObject({ code: 'TABLE_CONFLICT' });
    await expect(tables.update(table.id, { operationId: operation(), expectedSchemaVersion: 2, columns: renamed.columns.slice(1) }, owner)).rejects.toMatchObject({ code: 'TABLE_COLUMNS_INCOMPLETE' });
    // T3 ativa AST válida; objeto sem nó continua recusado agora pelo contrato estrito de fórmula.
    await expect(tables.update(table.id, { operationId: operation(), expectedSchemaVersion: 2, columns: [...renamed.columns, { name: 'Cálculo', type: 'calculated', resultType: 'number', formula: {} }] } as never, owner)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const now = await tables.get(table.id, owner);
    await tables.share(table.id, { operationId: operation(), expectedVersion: now.version, botIds: [b.id] }, owner);
    await expect(tables.write(table.id, write, { kind: 'bot', botId: a.id })).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    const audit = (await pool.query('SELECT details FROM audit_log WHERE target = $1', [table.id])).rows;
    expect(JSON.stringify(audit)).not.toContain('Texto privado');
    expect(JSON.stringify(audit)).not.toContain('Renomeado');
  });

  it('revalida relações, preserva vínculos omitidos e bloqueia alvo referenciado no banco', async () => {
    const a = await bot('Relação A');
    const b = await bot('Relação B');
    const actor = { kind: 'bot', botId: a.id } as const;
    const target = await tables.create(createInput('Destino', [{ name: 'Descrição', type: 'text' }]), owner, a.id);
    const targetRecord = (await tables.write(target.id, { operationId: operation(), expectedSchemaVersion: 1, creates: [{ values: {} }], updates: [] }, owner)).records[0]!;
    const source = await tables.create(createInput('Origem', [{ name: 'Nome', type: 'text' }, { name: 'Vínculo', type: 'relation', targetTableId: target.id, cardinality: 'one' }]), owner, a.id);
    const relation = source.columns[1]!.id;
    const relationWrite = { operationId: operation(), expectedSchemaVersion: 1, creates: [{ values: { [relation]: targetRecord.id } }], updates: [] };
    const written = await tables.write(source.id, relationWrite, actor);
    await expect(pool.query('DELETE FROM table_records WHERE table_id = $1 AND id = $2', [target.id, targetRecord.id])).rejects.toHaveProperty('code', '23503');
    await expect(pool.query('INSERT INTO table_links (table_id, record_id, column_id, target_table_id, target_record_id) VALUES ($1, $2, $3, $1, $2)', [source.id, written.records[0]!.id, relation])).rejects.toHaveProperty('code', '23503');
    await tables.share(source.id, { operationId: operation(), expectedVersion: (await tables.get(source.id, owner)).version, botIds: [a.id, b.id] }, owner);
    const forbidden = { kind: 'bot', botId: b.id } as const;
    expect((await tables.get(source.id, forbidden)).columns).toHaveLength(1);
    expect((await tables.records(source.id, forbidden)).records[0]!.values).not.toHaveProperty(relation);
    // Origem acessível não autoriza relacionar um ID real de outra tabela ou de tabela sem acesso.
    await expect(tables.write(source.id, { operationId: operation(), expectedSchemaVersion: 1, creates: [{ values: { [relation]: written.records[0]!.id } }], updates: [] }, actor)).rejects.toMatchObject({ code: 'TABLE_INVALID_VALUE' });
    await expect(tables.write(source.id, { operationId: operation(), expectedSchemaVersion: 1, creates: [], updates: [{ id: written.records[0]!.id, expectedVersion: 1, values: { [relation]: null } }] }, forbidden)).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    await tables.write(source.id, { operationId: operation(), expectedSchemaVersion: 1, creates: [], updates: [{ id: written.records[0]!.id, expectedVersion: 1, values: { [source.columns[0]!.id]: 'Permitido' } }] }, forbidden);
    expect((await tables.records(source.id, owner)).records[0]!.values[relation]).toBe(targetRecord.id);
    await tables.share(target.id, { operationId: operation(), expectedVersion: (await tables.get(target.id, owner)).version, botIds: [] }, owner);
    expect((await tables.records(source.id, actor)).records[0]!.values).not.toHaveProperty(relation);
    await expect(tables.write(source.id, relationWrite, actor)).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    const visible = await tables.get(source.id, forbidden);
    await tables.update(source.id, { operationId: operation(), expectedSchemaVersion: 1, columns: visible.columns.map((column) => ({ ...column, name: 'Título acessível' })) }, forbidden);
    expect((await tables.get(source.id, owner)).columns).toHaveLength(2);
    expect((await tables.records(source.id, owner)).records[0]!.values[relation]).toBe(targetRecord.id);
  });

  it('preserva tabelas/recibos ao excluir criador e último bot, invalidando revisão de compartilhamento', async () => {
    const a = await bot('Preservação A');
    const b = await bot('Preservação B');
    const table = await tables.create(createInput('Permanente'), owner, a.id);
    const shared = await tables.share(table.id, { operationId: operation(), expectedVersion: 1, botIds: [a.id, b.id] }, owner);
    await bots.archive(a.id, origin);
    await bots.deleteArchived(a.id, a.name, origin);
    expect((await tables.get(table.id, owner)).botIds).toEqual([b.id]);
    await expect(tables.share(table.id, { operationId: operation(), expectedVersion: shared.version, botIds: [] }, owner)).rejects.toMatchObject({ code: 'TABLE_CONFLICT' });
    await bots.archive(b.id, origin);
    await bots.deleteArchived(b.id, b.name, origin);
    expect((await tables.get(table.id, owner)).botIds).toEqual([]);
    expect((await pool.query('SELECT 1 FROM table_mutation_receipts WHERE table_id = $1', [table.id])).rowCount).toBe(2);
  });

  it('desfaz escrita e recibo quando a auditoria falha após a mutação', async () => {
    const a = await bot('Atomicidade');
    const table = await tables.create(createInput('Atomicidade'), owner, a.id);
    const operationId = operation();
    await pool.query("CREATE FUNCTION fail_table_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'table.write' THEN RAISE EXCEPTION 'falha de teste'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_table_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_table_audit()");
    const input = { operationId, expectedSchemaVersion: 1, creates: [{ values: {} }], updates: [] };
    try {
      await expect(tables.write(table.id, input, owner)).rejects.toThrow('falha de teste');
      expect((await tables.records(table.id, owner)).records).toEqual([]);
      expect((await tables.get(table.id, owner)).version).toBe(1);
      expect((await pool.query('SELECT 1 FROM table_mutation_receipts WHERE operation_id = $1', [operationId])).rowCount).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER fail_table_audit ON audit_log; DROP FUNCTION fail_table_audit()');
    }
    expect((await tables.write(table.id, input, owner)).records).toHaveLength(1);
    expect((await tables.write(table.id, input, owner)).records).toHaveLength(1);
    expect((await tables.records(table.id, owner)).records).toHaveLength(1);
  });

  it('serializa cotas de registros e tabelas entre operações concorrentes', async () => {
    const a = await bot('Cotas');
    const table = await tables.create(createInput('Cotas'), owner, a.id);
    await pool.query("INSERT INTO table_records (table_id, id, values) SELECT $1, md5(i::text)::uuid, '{}'::jsonb FROM generate_series(1, 9999) i", [table.id]);
    const results = await Promise.allSettled(Array.from({ length: 2 }, () => tables.write(table.id, { operationId: operation(), expectedSchemaVersion: 1, creates: [{ values: {} }], updates: [] }, owner)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'TABLE_LIMIT_EXCEEDED' } });
    const count = Number((await pool.query('SELECT count(*) FROM data_tables')).rows[0].count);
    await pool.query("INSERT INTO data_tables (id, name) SELECT md5(('quota-' || i)::text)::uuid, 'Quota' FROM generate_series(1, $1::int) i", [99 - count]);
    const creations = await Promise.allSettled(Array.from({ length: 2 }, (_, i) => tables.create(createInput(`Limite ${i}`), owner, a.id)));
    expect(creations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(creations.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'TABLE_LIMIT_EXCEEDED' } });
  });

  it('rollback recusa perda de dados e mantém tabelas e dados antigos no rollback da aplicação', async () => {
    const before = (await pool.query('SELECT count(*) FROM data_tables')).rows[0];
    await expect(pool.query(botTablesMigration.rollback)).rejects.toThrow(/preserve os dados/);
    expect((await pool.query('SELECT count(*) FROM data_tables')).rows[0]).toEqual(before);
    expect(await migrateTestDatabase(pool)).toEqual([]);
    expect((await pool.query('SELECT 1 FROM bots LIMIT 1')).rowCount).toBe(1);
  });
});
