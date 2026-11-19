// Paginação de linhas/grupos, totais completos, projeção e envelope UTF-8 em banco real.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableQuerySchema } from '@aion/shared';
import type { TableCell } from '@aion/shared';
import { queryWithin } from './formulas';
import { TABLE_QUERY_BYTES } from './queries';
import { createTablesWorld, owner } from './test-support';

let world: Awaited<ReturnType<typeof createTablesWorld>>;
beforeAll(async () => { world = await createTablesWorld(); });
afterAll(async () => { await world.cleanup(); });

describe('tables consulta e vistas', () => {
  it('ordena numericamente com ID e nulls last, pagina sem duplicar e totaliza todo filtro, não só página', async () => {
    const table = await world.create([{ name: 'Valor', type: 'number' }, { name: 'Grupo', type: 'text' }, { name: 'BRL', type: 'money', currency: 'BRL' }, { name: 'USD', type: 'money', currency: 'USD' }]);
    const [number, group, brl, usd] = table.columns.map((column) => column.id) as [string, string, string, string];
    const values = Array.from({ length: 240 }, (_, index) => ({ [number]: String(index % 20), [group]: `Grupo ${index % 5}`, [brl]: '0.1', [usd]: '0.2' }));
    for (let offset = 0; offset < values.length; offset += 100) await world.write(table, values.slice(offset, offset + 100));
    await world.write(table, [{ [number]: null, [group]: null, [brl]: null, [usd]: null }]);
    const query = { columns: [number], sort: [{ columnId: number, direction: 'asc' as const }], limit: 37, aggregate: [{ alias: 'BRL', op: 'sum' as const, columnId: brl }, { alias: 'USD', op: 'sum' as const, columnId: usd }, { alias: 'Count', op: 'count' as const }] };
    const ids: string[] = []; const numbers: TableCell[] = [];
    let cursor: string | undefined;
    do {
      const result = await world.tables.query(table.id, { ...query, ...(cursor ? { cursor } : {}) }, owner);
      expect(result.aggregate).toEqual({ BRL: '24', USD: '48', Count: '241' });
      expect(result.totalCount).toBe(241);
      result.records.forEach((row) => { expect(Object.keys(row.values)).toEqual([number]); ids.push(row.id); numbers.push(row.values[number]!); });
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(ids).size).toBe(241);
    expect(numbers.slice(0, 12)).toEqual(Array(12).fill('0'));
    expect(numbers.slice(24, 36)).toEqual(Array(12).fill('2'));
    expect(numbers.at(-1)).toBeNull();
    const first = await world.tables.query(table.id, query, owner);
    await expect(world.tables.query(table.id, { ...query, columns: [brl], cursor: first.nextCursor! }, owner)).rejects.toMatchObject({ code: 'TABLE_QUERY_LIMIT' });
    const filtered = await world.tables.query(table.id, { columns: [], filter: { op: 'and', filters: [{ op: 'gte', columnId: number, value: '10' }, { op: 'not_empty', columnId: number }] }, aggregate: [{ alias: 'Count', op: 'count' }, { alias: 'Average', op: 'avg', columnId: number }] }, owner);
    expect(filtered).toMatchObject({ records: [], aggregate: { Count: '120', Average: '14.5' }, totalCount: 120, hasMore: false, nextCursor: null });
    const empty = await world.tables.query(table.id, { columns: [], filter: { op: 'gt', columnId: number, value: '100' }, aggregate: [{ alias: 'Count', op: 'count' }, { alias: 'Sum', op: 'sum', columnId: number }, { alias: 'Min', op: 'min', columnId: number }, { alias: 'Max', op: 'max', columnId: number }] }, owner);
    expect(empty.aggregate).toEqual({ Count: '0', Sum: null, Min: null, Max: null });
    const grouped = { columns: [], groupBy: [group], aggregate: [{ alias: 'Sum', op: 'sum' as const, columnId: brl }], limit: 2 };
    const collected: unknown[] = [];
    cursor = undefined;
    do {
      const result = await world.tables.query(table.id, { ...grouped, ...(cursor ? { cursor } : {}) }, owner);
      expect(result.totalCount).toBe(241);
      collected.push(...result.groups!);
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(collected).toEqual([...Array.from({ length: 5 }, (_, index) => ({ values: { [group]: `Grupo ${index}` }, aggregate: { Sum: '4.8' } })), { values: { [group]: null }, aggregate: { Sum: null } }]);
  });

  it('vistas têm revisão, cota, replay e remoção só da definição; renomear não rompe dependências', async () => {
    let table = await world.create([{ name: 'Texto', type: 'text' }, { name: 'Número', type: 'number' }]);
    const [text, number] = table.columns.map((column) => column.id) as [string, string];
    await world.write(table, [{ [text]: 'SQL; DROP TABLE bots', [number]: '2' }, { [text]: 'Outro', [number]: '10' }]);
    const input = { operationId: randomUUID(), name: 'Vista', columns: [text], filter: { op: 'contains' as const, columnId: text, value: 'DROP TABLE' }, sort: [{ columnId: number, direction: 'desc' as const }] };
    const view = await world.tables.saveView(table.id, input, owner);
    expect(await world.tables.saveView(table.id, input, owner)).toEqual(view);
    expect((await world.tables.query(table.id, { viewId: view.id }, owner)).records.map((row) => row.values)).toEqual([{ [text]: 'SQL; DROP TABLE bots' }]);
    await expect(world.tables.saveView(table.id, { ...input, operationId: randomUUID(), expectedVersion: 9 }, owner, view.id)).rejects.toMatchObject({ code: 'TABLE_CONFLICT' });
    const updated = await world.tables.saveView(table.id, { ...input, filter: null, expectedVersion: 1, operationId: randomUUID() }, owner, view.id);
    expect(updated.version).toBe(2);
    expect((await world.tables.query(table.id, { viewId: view.id }, owner)).records[0]!.values[text]).toBe('Outro');
    table = await world.tables.update(table.id, { expectedSchemaVersion: table.schemaVersion, operationId: randomUUID(), columns: table.columns.map((column) => ({ ...column, name: `Novo ${column.name}` })) }, owner);
    expect((await world.tables.views(table.id, owner)).views).toHaveLength(1);
    await expect(world.tables.update(table.id, { expectedSchemaVersion: table.schemaVersion, operationId: randomUUID(), columns: table.columns.map((column) => column.id === number ? { id: column.id, name: column.name, type: 'text' } : column) }, owner)).rejects.toMatchObject({ code: 'TABLE_DEPENDENCY' });
    const remove = { operationId: randomUUID(), expectedVersion: 2 };
    expect(await world.tables.removeView(table.id, view.id, remove, owner)).toEqual({ id: view.id, removed: true });
    expect(await world.tables.removeView(table.id, view.id, remove, owner)).toEqual({ id: view.id, removed: true });
    expect((await world.tables.records(table.id, owner)).records).toHaveLength(2);
    for (let index = 0; index < 20; index++) await world.tables.saveView(table.id, { operationId: randomUUID(), name: `Vista ${index}` }, owner);
    await expect(world.tables.saveView(table.id, { operationId: randomUUID(), name: 'Acima da cota' }, owner)).rejects.toMatchObject({ code: 'TABLE_LIMIT_EXCEEDED' });
  });

  it('UTF-8 limita envelope completo por linhas inteiras; linha/grupo isolado grande pede projeção menor', async () => {
    const table = await world.create(Array.from({ length: 3 }, (_, index) => ({ name: `Texto ${index}`, type: 'text' as const })));
    const columns = table.columns.map((column) => column.id);
    const values = Object.fromEntries(columns.map((id) => [id, '漢'.repeat(8000)]));
    await world.write(table, [values, values, values]);
    const first = await world.tables.query(table.id, { columns: [columns[0]!] }, owner);
    expect(first.records).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(TABLE_QUERY_BYTES);
    expect(first.records.every((row) => row.values[columns[0]!] === values[columns[0]!])).toBe(true);
    const second = await world.tables.query(table.id, { columns: [columns[0]!], cursor: first.nextCursor! }, owner);
    expect(second.records).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    await expect(world.tables.query(table.id, {}, owner)).rejects.toMatchObject({ code: 'TABLE_QUERY_LIMIT' });
    await expect(world.tables.query(table.id, { columns: [], groupBy: columns, aggregate: [{ alias: 'Count', op: 'count' }] }, owner)).rejects.toMatchObject({ code: 'TABLE_QUERY_LIMIT' });
  });

  it('agregados/grupos de instantes, horas e números mantêm representação tipada e nulos', async () => {
    const table = await world.create([{ name: 'Instante', type: 'datetime' }, { name: 'Hora', type: 'time' }, { name: 'Número', type: 'number' }]);
    const [instant, time, number] = table.columns.map((column) => column.id) as [string, string, string];
    await world.write(table, [{ [instant]: '2027-01-01T09:00:00-03:00', [time]: '09:00', [number]: '1.2' }, {}]);
    const totals = await world.tables.query(table.id, { columns: [], aggregate: [{ alias: 'Min', op: 'min', columnId: instant }, { alias: 'Max', op: 'max', columnId: time }] }, owner);
    expect(totals.aggregate).toEqual({ Min: '2027-01-01T12:00:00.000Z', Max: '09:00' });
    const groups = await world.tables.query(table.id, { columns: [], groupBy: [instant, time, number], aggregate: [{ alias: 'Count', op: 'count' }] }, owner);
    expect(groups.groups).toEqual([{ values: { [instant]: '2027-01-01T12:00:00.000Z', [time]: '09:00', [number]: '1.2' }, aggregate: { Count: '1' } }, { values: { [instant]: null, [time]: null, [number]: null }, aggregate: { Count: '1' } }]);
  });

  it('limites/entrada tipada e prazo inteiro falham sem apresentar parcial como completo', async () => {
    const table = await world.create([{ name: 'Número', type: 'number' }]);
    const id = table.columns[0]!.id;
    for (const query of [{ limit: 101 }, { sort: Array(4).fill({ columnId: id, direction: 'asc' }) }, { aggregate: Array.from({ length: 11 }, (_, index) => ({ alias: `A${index}`, op: 'count' })) }, { filter: { op: 'and', filters: Array(21).fill({ op: 'eq', columnId: id, value: '1' }) } }, { filter: { op: 'and', filters: [{ op: 'and', filters: [{ op: 'and', filters: [{ op: 'eq', columnId: id, value: '1' }] }] }] } }]) expect(tableQuerySchema.safeParse(query).success).toBe(false);
    await expect(world.tables.query(table.id, { filter: { op: 'eq', columnId: id, value: true } }, owner)).rejects.toMatchObject({ code: 'TABLE_INVALID_VALUE' });
    await expect(world.tables.query(table.id, { filter: { op: 'contains', columnId: id, value: '1' } }, owner)).rejects.toMatchObject({ code: 'TABLE_INVALID_VALUE' });
    await expect(world.tables.query(table.id, { aggregate: [{ alias: 'Erro', op: 'sum' }] }, owner)).rejects.toMatchObject({ code: 'TABLE_INVALID_VALUE' });
    const client = await world.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(queryWithin(client, performance.now() - 1, 'SELECT 1')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      await expect(queryWithin(client, performance.now() + 20, 'SELECT pg_sleep(1)')).rejects.toMatchObject({ code: '57014' });
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('agregado monetário que ultrapassa precisão é recusado em vez de produzir valor truncado', async () => {
    const table = await world.create([{ name: 'Dinheiro', type: 'money', currency: 'BRL' }]);
    const id = table.columns[0]!.id;
    await world.write(table, [{ [id]: '999999999999.99' }, { [id]: '999999999999.99' }]);
    await expect(world.tables.query(table.id, { columns: [], aggregate: [{ alias: 'Total', op: 'sum', columnId: id }] }, owner)).rejects.toMatchObject({ code: 'TABLE_CELL_ERROR' });
  });
});
