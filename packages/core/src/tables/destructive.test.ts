// Prova transacional de preparações, ausência de cascata, conversões e recibos após remoção.
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { tableWriteSchema } from '@aion/shared';
import { createTablesWorld, owner, call, ref } from './test-support';
import { grantApprovalProof } from '../approvals/proof';
import { TABLE_ACTIONS } from './actions';

describe('tables operações destrutivas', () => {
  let world: Awaited<ReturnType<typeof createTablesWorld>>;
  beforeAll(async () => { world = await createTablesWorld(); });
  afterAll(async () => { await world.cleanup(); });
  /** Confirma exatamente o que o serviço preparou, usando nova chave de operação. */
  const confirm = async (id: string, operation: Parameters<typeof world.tables.prepareDestructive>[1]) => {
    const prepared = await world.tables.prepareDestructive(id, operation, owner);
    return world.tables.confirmDestructive(id, { preparationId: prepared.preparationId, operationId: randomUUID(), confirmation: true }, owner);
  };

  it('revisão abrange dados/acessos; bot exige proof real e não usa preparação do dono', async () => {
    const table = await world.create([{ name: 'Texto', type: 'text' }]);
    const bot = { kind: 'bot', botId: world.bot.id } as const;
    const prepared = await world.tables.prepareDestructive(table.id, { kind: 'delete_table', expectedVersion: table.version }, bot);
    const input = { preparationId: prepared.preparationId, operationId: randomUUID(), confirmation: true as const };
    await expect(world.tables.confirmDestructive(table.id, input, bot)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(world.tables.confirmDestructive(table.id, input, bot, { action: TABLE_ACTIONS.delete_table.slug, basis: 'owner_approved' } as never)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await world.write(table, [{ [table.columns[0]!.id]: 'novo' }]);
    await expect(world.tables.confirmDestructive(table.id, input, bot, grantApprovalProof(TABLE_ACTIONS.delete_table.slug, 'owner_approved'))).rejects.toMatchObject({ code: 'TABLE_CONFLICT' });
    const current = await world.tables.get(table.id, owner);
    const ownPrep = await world.tables.prepareDestructive(table.id, { kind: 'delete_table', expectedVersion: current.version }, owner);
    await expect(world.tables.confirmDestructive(table.id, { ...input, preparationId: ownPrep.preparationId }, bot, grantApprovalProof(TABLE_ACTIONS.delete_table.slug, 'owner_approved'))).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    const botPrep = await world.tables.prepareDestructive(table.id, { kind: 'delete_table', expectedVersion: current.version }, bot);
    await world.tables.share(table.id, { botIds: [], expectedVersion: current.version, operationId: randomUUID() }, owner);
    await expect(world.tables.confirmDestructive(table.id, { ...input, preparationId: botPrep.preparationId }, bot, grantApprovalProof(TABLE_ACTIONS.delete_table.slug, 'owner_approved'))).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
  });

  it('delete preserva recibos não afetados, saneia células removidas e deduplicação nunca recria', async () => {
    const table = await world.create([{ name: 'Privado', type: 'text' }]);
    const column = table.columns[0]!.id;
    const a = tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: { [column]: 'SEGREDO_REMOVIDO' }, deduplicationKey: 'a' }] });
    const b = tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: { [column]: 'preservado' }, deduplicationKey: 'b' }] });
    const ar = (await world.tables.write(table.id, a, owner)).records[0]!;
    const br = await world.tables.write(table.id, b, owner);
    await confirm(table.id, { kind: 'delete_records', expectedVersion: (await world.tables.get(table.id, owner)).version, records: [{ id: ar.id, expectedVersion: ar.version }] });
    await expect(world.tables.write(table.id, a, owner)).rejects.toMatchObject({ code: 'TABLE_RESOURCE_REMOVED' });
    expect(await world.tables.write(table.id, b, owner)).toEqual(br);
    await expect(world.tables.write(table.id, { ...a, operationId: randomUUID() }, owner)).rejects.toMatchObject({ code: 'TABLE_RESOURCE_REMOVED' });
    const receipts = await world.pool.query<{ result: unknown }>('SELECT result FROM table_mutation_receipts WHERE table_id=$1', [table.id]);
    expect(JSON.stringify(receipts.rows)).not.toContain('SEGREDO_REMOVIDO');
    const deletion = await world.tables.prepareDestructive(table.id, { kind: 'delete_table', expectedVersion: (await world.tables.get(table.id, owner)).version }, owner);
    const input = { preparationId: deletion.preparationId, operationId: randomUUID(), confirmation: true as const };
    await world.tables.confirmDestructive(table.id, input, owner);
    await expect(world.tables.confirmDestructive(table.id, input, owner)).rejects.toMatchObject({ code: 'TABLE_RESOURCE_REMOVED' });
    expect((await world.pool.query('SELECT 1 FROM data_tables WHERE id=$1', [table.id])).rowCount).toBe(0);
  });

  it('vínculos e dependências bloqueiam sem cascata; remoção de vínculo exige ambos acessos', async () => {
    const target = await world.create([{ name: 'Alvo', type: 'text' }]);
    const row = (await world.write(target, [{ [target.columns[0]!.id]: 'permanece' }])).records[0]!;
    const source = await world.create([{ name: 'Vínculo', type: 'relation', targetTableId: target.id, cardinality: 'one' }]);
    await world.write(source, [{ [source.columns[0]!.id]: row.id }]);
    await expect(world.tables.prepareDestructive(target.id, { kind: 'delete_table', expectedVersion: (await world.tables.get(target.id, owner)).version }, owner)).rejects.toMatchObject({ code: 'TABLE_DEPENDENCY' });
    await expect(world.tables.prepareDestructive(target.id, { kind: 'delete_records', expectedVersion: (await world.tables.get(target.id, owner)).version, records: [{ id: row.id, expectedVersion: row.version }] }, owner)).rejects.toMatchObject({ code: 'TABLE_DEPENDENCY' });
    const current = await world.tables.get(target.id, owner);
    await world.tables.share(target.id, { operationId: randomUUID(), expectedVersion: current.version, botIds: [] }, owner);
    await expect(world.tables.prepareDestructive(source.id, { kind: 'delete_table', expectedVersion: (await world.tables.get(source.id, owner)).version }, { kind: 'bot', botId: world.bot.id })).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    await confirm(source.id, { kind: 'delete_table', expectedVersion: (await world.tables.get(source.id, owner)).version });
    expect((await world.tables.records(target.id, owner)).records[0]?.id).toBe(row.id);
    const number = await world.create([{ name: 'Base', type: 'number' }]);
    const dependent = await world.add(number, [{ name: 'Ref', type: 'calculated', resultType: 'number', formula: call('ADD', ref(number.columns[0]!.id), ref(number.columns[0]!.id)) }]);
    await expect(world.tables.prepareDestructive(number.id, { kind: 'delete_column', expectedVersion: dependent.version, columnId: number.columns[0]!.id }, owner)).rejects.toMatchObject({ code: 'TABLE_DEPENDENCY' });
  });

  it('impedimentos paginados usam a mesma regra do portão e não são divulgados a bots', async () => {
    const target = await world.create([{ name: 'Nome', type: 'text' }]);
    const row = (await world.write(target, [{ [target.columns[0]!.id]: 'CONTEUDO_NAO_METADATA' }])).records[0]!;
    const source = await world.create([{ name: 'Primeira relação', type: 'relation', targetTableId: target.id, cardinality: 'one' }, { name: 'Segunda relação', type: 'relation', targetTableId: target.id, cardinality: 'many' }]);
    await world.write(source, [{ [source.columns[0]!.id]: row.id }]);
    const operation = { kind: 'delete_table', expectedVersion: (await world.tables.get(target.id, owner)).version } as const;
    const first = await world.tables.dependencies(target.id, { operation, limit: 1 }, owner);
    expect(first.dependencies).toHaveLength(1); expect(first.nextCursor).toBe(1);
    const second = await world.tables.dependencies(target.id, { operation, cursor: first.nextCursor!, limit: 1 }, owner);
    expect(second.dependencies).toHaveLength(1); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.dependencies, ...second.dependencies].map((item) => item.name))).toEqual(new Set(['Primeira relação', 'Segunda relação']));
    expect(first.dependencies[0]).toMatchObject({ kind: 'relation', tableId: source.id, tableName: source.name });
    expect(JSON.stringify(first)).not.toContain('CONTEUDO_NAO_METADATA');
    const records = await world.tables.dependencies(target.id, { operation: { kind: 'delete_records', expectedVersion: operation.expectedVersion, records: [{ id: row.id, expectedVersion: row.version }] } }, owner);
    expect(records.dependencies.map((item) => item.name)).toEqual(['Primeira relação']);
    await expect(world.tables.dependencies(target.id, { operation }, { kind: 'bot', botId: world.bot.id })).rejects.toMatchObject({ code: 'TABLE_ACCESS_DENIED' });
    const base = await world.create([{ name: 'Base', type: 'number' }]);
    const calculated = await world.add(base, [{ name: 'Dobro', type: 'calculated', resultType: 'number', formula: call('ADD', ref(base.columns[0]!.id), ref(base.columns[0]!.id)) }]);
    await world.tables.saveView(base.id, { name: 'Vista da base', operationId: randomUUID(), columns: [base.columns[0]!.id] }, owner);
    const current = await world.tables.get(base.id, owner);
    const dependencies = await world.tables.dependencies(base.id, { operation: { kind: 'delete_column', expectedVersion: current.version, columnId: base.columns[0]!.id } }, owner);
    expect(dependencies.dependencies).toEqual(expect.arrayContaining([{ kind: 'formula', tableId: base.id, tableName: base.name, name: 'Dobro' }, { kind: 'view', tableId: base.id, tableName: base.name, name: 'Vista da base' }]));
    expect((await world.tables.get(base.id, owner)).columns).toEqual(calculated.columns);
    await expect(world.tables.dependencies(base.id, { operation: { kind: 'delete_column', expectedVersion: 1, columnId: base.columns[0]!.id } }, owner)).rejects.toMatchObject({ code: 'TABLE_CONFLICT' });
  });

  it('conversões exatas materializam calculadas, preservam one/many e recusam perda', async () => {
    const target = await world.create();
    const targets = await world.write(target, [{}, {}]);
    const source = await world.create([{ name: 'Ligação', type: 'relation', cardinality: 'many', targetTableId: target.id }]);
    const column = source.columns[0]!;
    const row = (await world.write(source, [{ [column.id]: [targets.records[0]!.id] }])).records[0]!;
    await confirm(source.id, { kind: 'convert_column', expectedVersion: (await world.tables.get(source.id, owner)).version, column: { ...column, type: 'relation', cardinality: 'one', targetTableId: target.id } });
    expect((await world.tables.records(source.id, owner)).records[0]?.values[column.id]).toBe(targets.records[0]!.id);
    const current = await world.tables.get(source.id, owner);
    await confirm(source.id, { kind: 'convert_column', expectedVersion: current.version, column: { ...current.columns[0]!, type: 'relation', cardinality: 'many', targetTableId: target.id } });
    const again = await world.tables.get(source.id, owner);
    const existing = (await world.tables.records(source.id, owner)).records[0]!;
    await world.tables.write(source.id, tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: again.schemaVersion, updates: [{ id: row.id, expectedVersion: existing.version, values: { [column.id]: targets.records.map((item) => item.id) } }] }), owner);
    await expect(world.tables.prepareDestructive(source.id, { kind: 'convert_column', expectedVersion: (await world.tables.get(source.id, owner)).version, column: { ...column, type: 'relation', cardinality: 'one', targetTableId: target.id } }, owner)).rejects.toMatchObject({ code: 'TABLE_INVALID_VALUE' });
    const numeric = await world.create([{ name: 'Número', type: 'number' }]);
    await world.write(numeric, [{ [numeric.columns[0]!.id]: '1.234' }]);
    await expect(world.tables.prepareDestructive(numeric.id, { kind: 'convert_column', expectedVersion: (await world.tables.get(numeric.id, owner)).version, column: { id: numeric.columns[0]!.id, name: 'Valor', type: 'money', currency: 'BRL' } }, owner)).rejects.toMatchObject({ code: 'TABLE_INVALID_VALUE' });
    const base = await world.create([{ name: 'Base', type: 'number' }]);
    await world.write(base, [{ [base.columns[0]!.id]: '1.2' }]);
    const calculated = await world.add(base, [{ name: 'Dobro', type: 'calculated', resultType: 'number', formula: call('ADD', ref(base.columns[0]!.id), ref(base.columns[0]!.id)) }]);
    const derived = calculated.columns[1]!;
    await confirm(base.id, { kind: 'convert_column', expectedVersion: calculated.version, column: { id: derived.id, name: derived.name, type: 'money', currency: 'BRL' } });
    const materialized = (await world.tables.records(base.id, owner)).records[0]!;
    expect(materialized.values[derived.id]).toBe('2.4');
    const currentBase = await world.tables.get(base.id, owner);
    await world.tables.write(base.id, tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: currentBase.schemaVersion, updates: [{ id: materialized.id, expectedVersion: materialized.version, values: { [base.columns[0]!.id]: '9' } }] }), owner);
    expect((await world.tables.records(base.id, owner)).records[0]?.values[derived.id]).toBe('2.4');
  });
});
