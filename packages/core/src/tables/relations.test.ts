// Relações one/many preservam FKs e patches, e não concedem acesso por vista, filtro, grupos ou cursor.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createTablesWorld, owner, ref } from './test-support';

let world: Awaited<ReturnType<typeof createTablesWorld>>;
beforeAll(async () => { world = await createTablesWorld(); });
afterAll(async () => { await world.cleanup(); });

describe('tables relações autorizadas', () => {
  it('one/many exigem ambos acessos, preservam omitidos e não vazam após revogação', async () => {
    const bot = { kind: 'bot', botId: world.bot.id } as const;
    const target = await world.create([{ name: 'Nome privado', type: 'text' }]);
    const destinations = await world.write(target, [{ [target.columns[0]!.id]: 'Destino privado A' }, { [target.columns[0]!.id]: 'Destino privado B' }]);
    const first = destinations.records[0]!.id; const second = destinations.records[1]!.id;
    const table = await world.create([{ name: 'Texto', type: 'text' }, { name: 'Um', type: 'relation', targetTableId: target.id, cardinality: 'one' }, { name: 'Muitos', type: 'relation', targetTableId: target.id, cardinality: 'many' }]);
    const [text, one, many] = table.columns.map((column) => column.id) as [string, string, string];
    const written = await world.write(table, [{ [text]: 'Linha', [one]: first, [many]: [second, first] }]);
    const row = written.records[0]!;
    expect(row.values[one]).toBe(first);
    expect(row.values[many]).toEqual([first, second].sort());
    const patched = await world.tables.write(table.id, { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [], updates: [{ id: row.id, expectedVersion: row.version, values: { [text]: 'Renomeada' } }] }, bot);
    expect(patched.records[0]!.values[one]).toBe(first);
    expect(patched.records[0]!.values[many]).toEqual(row.values[many]);
    const input = { operationId: randomUUID(), name: 'Relacionada', columns: [text, one], filter: { op: 'includes' as const, columnId: many, value: second } };
    const view = await world.tables.saveView(table.id, input, bot);
    expect((await world.tables.query(table.id, { viewId: view.id }, bot)).totalCount).toBe(1);
    expect((await world.tables.query(table.id, { columns: [], groupBy: [one], aggregate: [{ alias: 'Count', op: 'count' }] }, bot)).groups).toEqual([{ values: { [one]: first }, aggregate: { Count: '1' } }]);
    const current = await world.tables.get(target.id, owner);
    await world.tables.share(target.id, { operationId: randomUUID(), expectedVersion: current.version, botIds: [] }, owner);
    const hidden = await world.tables.query(table.id, {}, bot);
    expect(hidden.records[0]!.values).toEqual({ [text]: 'Renomeada' });
    expect(JSON.stringify(hidden)).not.toContain(first);
    for (const query of [
      { columns: [one] }, { columns: [text], filter: { op: 'includes' as const, columnId: many, value: second } },
      { columns: [], groupBy: [one], aggregate: [{ alias: 'Count', op: 'count' as const }] },
      { columns: [], aggregate: [{ alias: 'Min', op: 'min' as const, columnId: one }] },
      { viewId: view.id }, { viewId: view.id, columns: [text], filter: null },
    ]) await expect(world.tables.query(table.id, query, bot)).rejects.toMatchObject({ code: 'TABLE_ACCESS_DENIED' });
    await expect(world.tables.views(table.id, bot)).rejects.toMatchObject({ code: 'TABLE_ACCESS_DENIED' });
    await expect(world.tables.saveView(table.id, input, bot)).rejects.toMatchObject({ code: 'TABLE_ACCESS_DENIED' });
    await expect(world.tables.write(table.id, { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [{ values: { [one]: first } }], updates: [] }, bot)).rejects.toMatchObject({ code: 'TABLE_NOT_FOUND' });
    await expect(world.tables.previewFormula(table.id, { formula: ref(one), resultType: 'text' }, owner)).rejects.toMatchObject({ code: 'TABLE_INVALID_FORMULA' });
    const cleared = await world.tables.write(table.id, { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [], updates: [{ id: row.id, expectedVersion: 2, values: { [one]: null, [many]: null } }] }, owner);
    expect(cleared.records[0]!.values).toEqual({ [text]: 'Renomeada', [one]: null, [many]: null });
  });

  it('lista incompleta falha sem perda; lista visível completa acrescenta coluna e preserva relações ocultas', async () => {
    const bot = { kind: 'bot', botId: world.bot.id } as const;
    const target = await world.create([{ name: 'Privado', type: 'text' }]);
    const row = (await world.write(target, [{ [target.columns[0]!.id]: 'Destino' }])).records[0]!;
    const table = await world.create([{ name: 'Nome', type: 'text' }, { name: 'Oculta', type: 'relation', targetTableId: target.id, cardinality: 'one' }]);
    await world.write(table, [{ [table.columns[0]!.id]: 'Preservar', [table.columns[1]!.id]: row.id }]);
    await world.tables.share(target.id, { operationId: randomUUID(), expectedVersion: (await world.tables.get(target.id, owner)).version, botIds: [] }, owner);
    const baseline = await world.tables.get(table.id, owner); const records = await world.tables.records(table.id, owner);
    await expect(world.tables.update(table.id, { operationId: randomUUID(), expectedSchemaVersion: baseline.schemaVersion, columns: [{ name: 'Nova', type: 'text' }] }, bot)).rejects.toMatchObject({ code: 'TABLE_COLUMNS_INCOMPLETE' });
    expect(await world.tables.get(table.id, owner)).toEqual(baseline); expect(await world.tables.records(table.id, owner)).toEqual(records);
    const visible = await world.tables.get(table.id, bot); expect(visible.columns).toHaveLength(1);
    const updated = await world.tables.update(table.id, { operationId: randomUUID(), expectedSchemaVersion: visible.schemaVersion, columns: [...visible.columns, { name: 'Nova', type: 'text' }] }, bot);
    expect(updated.columns).toHaveLength(2);
    const all = await world.tables.get(table.id, owner); expect(all.columns).toHaveLength(3); expect(all.columns.find((column) => column.id === table.columns[1]!.id)).toEqual(table.columns[1]);
    expect((await world.tables.records(table.id, owner)).records[0]).toMatchObject({ id: records.records[0]!.id, version: records.records[0]!.version, values: records.records[0]!.values });
    await expect(world.tables.update(table.id, { operationId: randomUUID(), expectedSchemaVersion: all.schemaVersion, columns: all.columns.map((column) => column.id === table.columns[0]!.id ? { id: column.id, name: column.name, type: 'number' } : column) }, owner)).rejects.toMatchObject({ code: 'TABLE_DEPENDENCY' });
  });

  it('FKs impedem record/coluna de outra tabela e inclusão forjada não altera lote parcialmente', async () => {
    const target = await world.create();
    const other = await world.create();
    const foreign = (await world.write(other, [{}])).records[0]!.id;
    const table = await world.create([{ name: 'Relação', type: 'relation', targetTableId: target.id, cardinality: 'one' }]);
    const id = table.columns[0]!.id;
    await expect(world.write(table, [{}, { [id]: foreign }])).rejects.toMatchObject({ code: 'TABLE_INVALID_VALUE' });
    expect((await world.tables.records(table.id, owner)).records).toEqual([]);
    await expect(world.tables.previewFormula(table.id, { formula: call('COALESCE', ref(id), ref(id)), resultType: 'text' }, owner)).rejects.toMatchObject({ code: 'TABLE_INVALID_FORMULA' });
  });
});
