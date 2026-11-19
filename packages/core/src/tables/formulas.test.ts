// Valores esperados provam precisão, calendário, nulidade e erros no compilador comum da API/leitura/agregação.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FormulaNode, FormulaType } from '@aion/shared';
import { compileFormulas } from './formulas';
import { call, createTablesWorld, literal, owner, ref } from './test-support';

let world: Awaited<ReturnType<typeof createTablesWorld>>;
let clock = new Date('2027-03-01T01:00:00Z');
beforeAll(async () => { world = await createTablesWorld(() => clock); });
afterAll(async () => { await world.cleanup(); });

describe('tables fórmulas exatas', () => {
  it('preview, escrita, filtro e agregação têm o mesmo valor, moeda, arredondamento e IDs após renomear', async () => {
    let table = await world.create([{ name: 'Valor', type: 'money', currency: 'BRL' }, { name: 'Fator', type: 'number' }]);
    const money = table.columns[0]!.id; const factor = table.columns[1]!.id;
    const formula = call('MULTIPLY', ref(money), ref(factor));
    const sample = { [money]: '-1.01', [factor]: '0.5' };
    expect(await world.tables.previewFormula(table.id, { formula, resultType: 'money', currency: 'BRL', values: sample }, owner)).toEqual({ value: '-0.51' });
    table = await world.add(table, [{ name: 'Resultado', type: 'calculated', formula, resultType: 'money', currency: 'BRL' }]);
    const calculated = table.columns[2]!.id;
    const written = await world.write(table, [sample, { [money]: '0.1', [factor]: '3' }, {}]);
    expect(written.records.map((row) => row.values[calculated])).toEqual(['-0.51', '0.3', null]);
    const result = await world.tables.query(table.id, { columns: [calculated], filter: { op: 'gt', columnId: calculated, value: '0' }, aggregate: [{ alias: 'Total', op: 'sum', columnId: calculated }] }, owner);
    expect(result.aggregate).toEqual({ Total: '0.3' });
    expect(result.records.map((row) => row.values)).toEqual([{ [calculated]: '0.3' }]);
    table = await world.tables.update(table.id, { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, columns: table.columns.map((column) => ({ ...column, name: `Novo ${column.name}` })) }, owner);
    expect((await world.tables.records(table.id, owner)).records.find((row) => row.id === written.records[0]!.id)?.values[calculated]).toBe('-0.51');
    await expect(world.tables.write(table.id, { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: { [calculated]: '1' } }], updates: [] }, owner)).rejects.toMatchObject({ code: 'TABLE_INVALID_VALUE' });
  });

  it('aritmética, comparação, lógica de três valores, COALESCE e IF avaliam somente o ramo escolhido', async () => {
    const table = await world.create();
    const preview = (formula: FormulaNode, resultType: FormulaType = 'number') => world.tables.previewFormula(table.id, { formula, resultType }, owner);
    const zero = call('DIVIDE', literal('1'), literal('0'));
    expect(await preview(call('ADD', literal('0.1'), literal('0.2')))).toEqual({ value: '0.3' });
    expect(await preview(call('SUBTRACT', literal('1'), literal('0.3')))).toEqual({ value: '0.7' });
    expect(await preview(call('DIVIDE', literal('2'), literal('3')))).toEqual({ value: '0.666667' });
    expect(await preview(call('ROUND', literal('-1.005'), literal('2')))).toEqual({ value: '-1.01' });
    expect(await preview(call('IF', literal(true, 'boolean'), literal('4'), zero))).toEqual({ value: '4' });
    expect(await preview(call('IF', literal(null, 'boolean'), zero, literal('5')))).toEqual({ value: '5' });
    expect(await preview(call('COALESCE', literal('0'), zero))).toEqual({ value: '0' });
    expect(await preview(call('COALESCE', literal(null), literal('3')))).toEqual({ value: '3' });
    expect(await preview(call('ADD', literal(null), literal('1')))).toEqual({ value: null });
    for (const [op, expected] of [['EQ', false], ['NE', true], ['LT', true], ['LTE', true], ['GT', false], ['GTE', false]] as const) expect(await preview(call(op, literal('2'), literal('10')), 'boolean')).toEqual({ value: expected });
    expect(await preview(call('EQ', literal(null), literal('0')), 'boolean')).toEqual({ value: null });
    expect(await preview(call('AND', literal(null, 'boolean'), literal(false, 'boolean')), 'boolean')).toEqual({ value: false });
    expect(await preview(call('OR', literal(null, 'boolean'), literal(true, 'boolean')), 'boolean')).toEqual({ value: true });
    expect(await preview(call('NOT', literal(null, 'boolean')), 'boolean')).toEqual({ value: null });
  });

  it('TODAY muda com dia do dono, enquanto operações civis mantêm origem, bissextos e dias úteis', async () => {
    const table = await world.create();
    const preview = (formula: FormulaNode, resultType: FormulaType = 'date') => world.tables.previewFormula(table.id, { formula, resultType }, owner);
    expect(await preview(call('TODAY'))).toEqual({ value: '2027-02-28' });
    clock = new Date('2027-03-01T04:00:00Z');
    expect(await preview(call('TODAY'))).toEqual({ value: '2027-03-01' });
    expect(await preview(call('ADD_MONTHS', literal('2027-01-31', 'date'), literal('1')))).toEqual({ value: '2027-02-28' });
    expect(await preview(call('ADD_MONTHS', literal('2027-01-31', 'date'), literal('2')))).toEqual({ value: '2027-03-31' });
    expect(await preview(call('ADD_DAYS', literal('2028-02-28', 'date'), literal('1')))).toEqual({ value: '2028-02-29' });
    expect(await preview(call('ADD_DAYS', literal('2028-03-01', 'date'), literal('-1')))).toEqual({ value: '2028-02-29' });
    expect(await preview(call('DAYS_BETWEEN', literal('2028-02-28', 'date'), literal('2028-03-01', 'date')), 'number')).toEqual({ value: '2' });
    expect(await preview(call('BUSINESS_DAY_OF_MONTH', literal('2027-01-15', 'date'), literal('1')))).toEqual({ value: '2027-01-01' });
    expect(await preview(call('BUSINESS_DAY_OF_MONTH', literal('2027-02-01', 'date'), literal('last', 'text')))).toEqual({ value: '2027-02-26' });
    expect(await preview(call('BUSINESS_DAY_OF_MONTH', literal('2027-02-01', 'date'), literal('20')))).toEqual({ value: '2027-02-26' });
  });

  it('erros por célula permanecem visíveis e impedem total enganoso; campos não relacionados continuam consultáveis', async () => {
    let table = await world.create([{ name: 'Denominador', type: 'number' }, { name: 'Texto', type: 'text' }]);
    const denominator = table.columns[0]!.id; const text = table.columns[1]!.id;
    table = await world.add(table, [
      { name: 'Divisão', type: 'calculated', resultType: 'number', formula: call('DIVIDE', literal('1'), ref(denominator)) },
      { name: 'Overflow', type: 'calculated', resultType: 'number', formula: call('MULTIPLY', literal('999999999999999999'), literal('2')) },
      { name: 'Data impossível', type: 'calculated', resultType: 'date', formula: call('ADD_DAYS', literal('9999-12-31', 'date'), literal('1')) },
    ]);
    const division = table.columns[2]!.id; const overflow = table.columns[3]!.id; const invalidDate = table.columns[4]!.id;
    const written = await world.write(table, [{ [denominator]: '0', [text]: 'Seguro' }]);
    expect(written.records[0]!.errors).toEqual({ [division]: 'DIVISION_BY_ZERO', [overflow]: 'OVERFLOW', [invalidDate]: 'INVALID_DATE' });
    expect((await world.tables.query(table.id, { columns: [division] }, owner)).records[0]!.errors).toEqual({ [division]: 'DIVISION_BY_ZERO' });
    await expect(world.tables.query(table.id, { columns: [], aggregate: [{ alias: 'Total', op: 'sum', columnId: division }] }, owner)).rejects.toMatchObject({ code: 'TABLE_CELL_ERROR' });
    expect((await world.tables.query(table.id, { columns: [text] }, owner)).records[0]!.values).toEqual({ [text]: 'Seguro' });
    expect(await world.tables.previewFormula(table.id, { formula: call('DIVIDE', literal('1'), literal('0')), resultType: 'number' }, owner)).toEqual({ value: null, error: 'DIVISION_BY_ZERO' });
  });

  it('TODAY é lido uma vez por consulta e referências calculadas compartilham o mesmo dia', async () => {
    let calls = 0;
    const { TableService } = await import('./service');
    const service = new TableService({ pool: world.pool, now: () => { calls++; return new Date(calls === 1 ? '2027-03-01T02:59:59Z' : '2027-03-01T03:00:01Z'); } });
    let table = await world.create();
    table = await world.add(table, [{ name: 'Hoje A', type: 'calculated', resultType: 'date', formula: call('TODAY') }, { name: 'Hoje B', type: 'calculated', resultType: 'date', formula: call('TODAY') }]);
    table = await world.add(table, [{ name: 'Amanhã', type: 'calculated', resultType: 'date', formula: call('ADD_DAYS', ref(table.columns[0]!.id), literal('1')) }]);
    await world.write(table, [{}, {}]);
    calls = 0;
    const result = await service.query(table.id, {}, owner);
    expect(calls).toBe(1);
    expect(result.records.map((row) => Object.values(row.values))).toEqual([['2027-02-28', '2027-02-28', '2027-03-01'], ['2027-02-28', '2027-02-28', '2027-03-01']]);
  });

  it('recusa ciclos, lookup, tipos, moedas e AST fora de limites, sem executar SQL/JS como código', async () => {
    let table = await world.create([{ name: 'BRL', type: 'money', currency: 'BRL' }, { name: 'USD', type: 'money', currency: 'USD' }]);
    const brl = ref(table.columns[0]!.id); const usd = ref(table.columns[1]!.id);
    for (const formula of [call('ADD', brl, usd), call('MULTIPLY', brl, usd), call('DIVIDE', brl, usd), call('ADD', literal('1'), literal('1', 'text')), ref(randomUUID())]) await expect(world.tables.previewFormula(table.id, { formula, resultType: 'money', currency: 'BRL' }, owner)).rejects.toMatchObject({ code: 'TABLE_INVALID_FORMULA' });
    for (const formula of [{ kind: 'call', op: 'eval', args: [] }, { kind: 'literal', type: 'number', value: 'SELECT 1' }, { kind: 'ref', columnId: table.columns[0]!.id, sql: 'DROP TABLE bots' }]) await expect(world.tables.previewFormula(table.id, { formula, resultType: 'number' }, owner)).rejects.toHaveProperty('code');
    let deep: FormulaNode = literal('1');
    for (let index = 0; index < 10; index++) deep = call('ADD', deep, literal('1'));
    await expect(world.tables.previewFormula(table.id, { formula: deep, resultType: 'number' }, owner)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    table = await world.add(table, [{ name: 'A', type: 'calculated', resultType: 'number', formula: literal('1') }, { name: 'B', type: 'calculated', resultType: 'number', formula: literal('2') }]);
    const a = table.columns[2]!.id; const b = table.columns[3]!.id;
    const columns = table.columns.map((column) => column.type !== 'calculated' ? column : { ...column, formula: ref(column.id === a ? b : a) });
    await expect(world.tables.update(table.id, { expectedSchemaVersion: table.schemaVersion, operationId: randomUUID(), columns }, owner)).rejects.toMatchObject({ code: 'TABLE_INVALID_FORMULA' });
    expect(() => compileFormulas([{ id: randomUUID(), name: 'Código literal', type: 'calculated', resultType: 'text', formula: literal('globalThis.process.exit(); DROP TABLE bots;', 'text') }])).not.toThrow();
    expect((await world.pool.query('SELECT count(*) FROM bots')).rows[0].count).not.toBe('0');
    // Texto é dado, não código, tanto em fórmula quanto em registro.
    const text = await world.create([{ name: 'Texto', type: 'text' }]);
    const sample = 'globalThis.process.exit(); DROP TABLE bots;';
    await world.write(text, [{ [text.columns[0]!.id]: sample }]);
    expect((await world.tables.query(text.id, { filter: { op: 'contains', columnId: text.columns[0]!.id, value: 'DROP TABLE' } }, owner)).records[0]!.values[text.columns[0]!.id]).toBe(sample);
  });
});
