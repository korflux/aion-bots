// Provas de serialização usadas pelos construtores, sem calcular valores de fórmula no navegador.
import { tableFormulaSchema, tableQueryDefinitionSchema, type DataTable, type FormulaNode, type TableColumn, type TableFilter } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { filterOperators, formulaSize, moveItem, operationNode, queryDefinition, serializeFormula } from './configuration';
import { changeColumnType } from './structure-editor';
import { presentFilter, serializeFilter } from './view-editor';

const id = '11111111-1111-4111-8111-111111111111';
const datetime: TableColumn = { id, name: 'Entrega', type: 'datetime' };
const number: TableColumn = { ...datetime, id: '22222222-2222-4222-8222-222222222222', type: 'number' };
const table: DataTable = { id, name: 'Tabela', description: '', columns: [datetime, number], version: 1, schemaVersion: 1, botIds: [] };

describe('tables configuração visual', () => {
  it('reabre filtro datetime no fuso e preserva o instante ao aplicar novamente', () => {
    const filter: TableFilter = { op: 'and', filters: [{ op: 'gte', columnId: id, value: '2026-10-10T15:30:00.120Z' }] };
    const local = presentFilter(filter, table, 'America/Sao_Paulo');
    expect(local).toMatchObject({ filters: [{ value: '2026-10-10T12:30:00.12' }] });
    expect(serializeFilter(local, table, 'America/Sao_Paulo')).toEqual(filter);
    expect(filter).toMatchObject({ filters: [{ value: '2026-10-10T15:30:00.120Z' }] });
  });
  it('serializa decimal por dígitos e mantém includes escalar e nulo sem coerção', () => {
    const optionId = '33333333-3333-4333-8333-333333333333';
    const many: TableColumn = { id: optionId, name: 'Tags', type: 'multiselect', options: [{ id, label: 'A' }] };
    const columns = { ...table, columns: [...table.columns, many] };
    const filter: TableFilter = { op: 'or', filters: [{ op: 'eq', columnId: number.id, value: '0012,300' }, { op: 'includes', columnId: optionId, value: id }] };
    expect(serializeFilter(filter, columns, 'UTC')).toMatchObject({ filters: [{ value: '12.3' }, { value: id }] });
    expect(filterOperators(many)).toEqual(['empty', 'not_empty', 'includes']);
    expect(tableQueryDefinitionSchema.safeParse({ filter: serializeFilter(filter, columns, 'UTC'), columns: [optionId, id] }).success).toBe(true);
  });
  it('constrói AST restrita e mantém referências e ordem ao mover colunas', () => {
    const expression: FormulaNode = { kind: 'call', op: 'IF', args: [{ kind: 'call', op: 'GT', args: [{ kind: 'ref', columnId: number.id }, { kind: 'literal', type: 'number', value: '0' }] }, { kind: 'literal', type: 'money', currency: 'BRL', value: '12.3' }, { kind: 'literal', type: 'money', currency: 'BRL', value: '0' }] };
    expect(tableFormulaSchema.safeParse(JSON.parse(JSON.stringify(expression))).success).toBe(true);
    expect(serializeFormula({ kind: 'literal', type: 'money', currency: 'BRL', value: '0012,300' })).toEqual({ kind: 'literal', type: 'money', currency: 'BRL', value: '12.3' });
    expect(formulaSize(expression).nodes).toBe(6);
    expect(operationNode('IF')).toMatchObject({ args: [{}, {}, {}] });
    expect(moveItem(table.columns, 1, -1).map((column) => column.id)).toEqual([number.id, id]);
    expect(changeColumnType({ ...datetime, type: 'money', currency: 'BRL' }, 'number')).toEqual({ id, name: datetime.name, type: 'number' });
    const view = { id, version: 2, name: 'Salva', columns: [number.id, id], filter: null };
    expect(tableQueryDefinitionSchema.parse(queryDefinition(view))).toEqual({ columns: view.columns, filter: null });
  });
});
