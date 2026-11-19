// Transformações puras dos construtores visuais; IDs de referências/opções permanecem estáveis na serialização.
import type { FormulaNode, TableColumn, TableFilter, TableQueryDefinition } from '@aion/shared';
import { decimalInput } from './values';

export const COLUMN_LABELS = { text: 'Texto', number: 'Número', money: 'Dinheiro', boolean: 'Sim/Não', date: 'Data', time: 'Hora', datetime: 'Data com hora', select: 'Seleção', multiselect: 'Seleção múltipla', relation: 'Relação', calculated: 'Calculado' };
/** Metadados de vista nunca entram na entrada estrita da consulta pontual. */
export function queryDefinition(value: TableQueryDefinition): TableQueryDefinition { return { ...(value.columns ? { columns: value.columns } : {}), ...(value.filter !== undefined ? { filter: value.filter } : {}), ...(value.sort ? { sort: value.sort } : {}) }; }
/** Literais decimais usam a mesma normalização exata dos registros, sem cálculo paralelo à prévia. */
export function serializeFormula(node: FormulaNode): FormulaNode {
  if (node.kind === 'call') return { ...node, args: node.args.map(serializeFormula) };
  if (node.kind === 'literal' && (node.type === 'number' || node.type === 'money') && typeof node.value === 'string') return { ...node, value: decimalInput(node.value) };
  return node;
}
/** Limites estruturais medidos sem avaliar a AST; o servidor continua sendo a autoridade de validação. */
export function formulaSize(formula: FormulaNode): { nodes: number; characters: number } {
  const pending = [formula]; let nodes = 0;
  while (pending.length) { const next = pending.pop()!; nodes++; if (next.kind === 'call') pending.push(...next.args); }
  return { nodes, characters: JSON.stringify(formula).length };
}
/** Dependências são exibidas por nome; a decisão sobre conversão continua exclusivamente no servidor. */
export function formulaReferences(node: FormulaNode, columnId: string): boolean { return node.kind === 'ref' ? node.columnId === columnId : node.kind === 'call' && node.args.some((arg) => formulaReferences(arg, columnId)); }
/** Filtros usam a mesma identificação estável para explicar por que uma vista depende de uma coluna. */
export function filterReferences(node: TableFilter | null | undefined, columnId: string): boolean { return !!node && ('filters' in node ? node.filters.some((child) => filterReferences(child, columnId)) : node.columnId === columnId); }

/** Aridade inicial dá ao dono entradas pertinentes a cada operação, sem executar a expressão no navegador. */
export function operationNode(op: Extract<FormulaNode, { kind: 'call' }>['op']): FormulaNode {
  const count = op === 'TODAY' ? 0 : op === 'NOT' ? 1 : op === 'IF' ? 3 : 2;
  return { kind: 'call', op, args: Array.from({ length: count }, () => ({ kind: 'literal', type: 'number', value: '0' })) };
}
/** Movimento explícito serve às colunas da estrutura e à projeção, sem exigir drag ou alterar identidades. */
export function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const result = [...items]; [result[index], result[target]] = [result[target]!, result[index]!]; return result;
}
/** Predicado novo começa em ausência para não inventar valor de um tipo diferente. */
export function emptyPredicate(column: TableColumn): TableFilter { return { op: 'empty', columnId: column.id }; }
/** Conta somente predicados; grupos usam o limite de profundidade separado do contrato. */
export function predicateCount(filter: TableFilter | null): number { return !filter ? 0 : 'filters' in filter ? filter.filters.reduce((total, child) => total + predicateCount(child), 0) : 1; }
/** A lista reflete os operadores realmente admitidos pelo servidor para o tipo efetivo. */
export function filterOperators(column: TableColumn): Extract<TableFilter, { columnId: string }>['op'][] {
  const type = column.type === 'calculated' ? column.resultType : column.type;
  if (type === 'multiselect' || type === 'relation' && column.type === 'relation' && column.cardinality === 'many') return ['empty', 'not_empty', 'includes'];
  return ['empty', 'not_empty', 'eq', 'ne', ...(type === 'text' ? ['contains'] as const : []), ...(['number', 'money', 'date', 'time', 'datetime'].includes(type) ? ['lt', 'lte', 'gt', 'gte'] as const : []), ...(['multiselect', 'relation'].includes(type) ? ['includes'] as const : [])];
}
