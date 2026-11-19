// Compilador único de AST e avaliador vetorizado. Operações decimais/comparações são NUMERIC no PostgreSQL;
// calendário usa os mesmos helpers civis do scheduler. Nenhum nó admite código, SQL ou lookup de relações.
import { tableFormulaSchema, type FormulaNode, type FormulaType, type TableCell, type TableCellError, type TableColumn, type TableRecord } from '@aion/shared';
import type { Queryable } from '../db/pool';
import { DomainError } from '../errors';
import { addCivilDays, addCivilMonths, businessDayOfMonth, civilOrdinal, formatCivilDate, parseCivilDate } from '../routines/civil-date';
import { scalarType, validateScalar, validDecimal } from './scalars';

interface Value { value: TableCell; error?: TableCellError }
interface TypedNode { type: FormulaType; currency?: string; node: FormulaNode; args: TypedNode[] }
export interface FormulaPlan { columns: Map<string, TableColumn>; roots: Map<string, TypedNode>; dependencies: (ids: string[]) => Set<string> }
/** Falha de contrato da estrutura, distinta dos erros por célula durante avaliação. */
const invalid = (): never => { throw new DomainError('TABLE_INVALID_FORMULA'); };
/** Compatibilidade inclui moeda: dinheiro de moedas diferentes nunca se mistura. */
const same = (a: TypedNode, b: TypedNode): boolean => a.type === b.type && a.currency === b.currency;
/** Reconhece os dois domínios numéricos sem convertê-los em Number. */
const numeric = (node: TypedNode): boolean => node.type === 'number' || node.type === 'money';

/** Compila estrutura inteira para conferir ciclos/tipos antes de persistir; referências guardam IDs estáveis. */
export function compileFormulas(columns: TableColumn[]): FormulaPlan {
  const byId = new Map(columns.map((column) => [column.id, column]));
  const roots = new Map<string, TypedNode>();
  const visiting = new Set<string>();
  /** Coluna referenciada não pode ser relação/multisseleção; ciclos não chegam ao avaliador. */
  const columnRoot = (id: string): TypedNode => {
    const column = byId.get(id);
    if (!column || scalarType(column) === 'relation' || scalarType(column) === 'multiselect') return invalid();
    if (roots.has(id)) return roots.get(id)!;
    if (visiting.has(id)) return invalid();
    visiting.add(id);
    const root = column.type === 'calculated' ? compile(column.formula) : { type: scalarType(column) as FormulaType, currency: 'currency' in column ? column.currency : undefined, node: { kind: 'ref', columnId: id } as FormulaNode, args: [] };
    if (column.type === 'calculated' && (root.type !== column.resultType || root.currency !== column.currency)) return invalid();
    roots.set(id, root);
    visiting.delete(id);
    return root;
  };
  /** Operadores têm aridade e domínio definidos; literais passam pela validação escalar comum. */
  const compile = (raw: FormulaNode): TypedNode => {
    if (!tableFormulaSchema.safeParse(raw).success) return invalid();
    if (raw.kind === 'literal') {
      try { validateScalar({ id: '', name: '', type: 'calculated', formula: raw, resultType: raw.type, currency: raw.currency } as TableColumn, raw.value, true); } catch { return invalid(); }
      return { type: raw.type, currency: raw.currency, node: raw, args: [] };
    }
    if (raw.kind === 'ref') { const ref = columnRoot(raw.columnId); return { ...ref, node: raw, args: [] }; }
    const args = raw.args.map(compile);
    const result = (type: FormulaType, currency?: string): TypedNode => ({ type, currency, node: raw, args });
    const arity = (n: number): void => { if (args.length !== n) invalid(); };
    const types = (...expected: FormulaType[]): void => { if (args.length !== expected.length || args.some((arg, index) => arg.type !== expected[index])) invalid(); };
    switch (raw.op) {
      case 'TODAY': arity(0); return result('date');
      case 'IF': arity(3); if (args[0]!.type !== 'boolean' || !same(args[1]!, args[2]!)) invalid(); return result(args[1]!.type, args[1]!.currency);
      case 'COALESCE': if (args.length < 2 || args.some((arg) => !same(arg, args[0]!))) invalid(); return result(args[0]!.type, args[0]!.currency);
      case 'NOT': types('boolean'); return result('boolean');
      case 'AND': case 'OR': if (args.length < 2 || args.some((arg) => arg.type !== 'boolean')) invalid(); return result('boolean');
      case 'EQ': case 'NE': case 'LT': case 'LTE': case 'GT': case 'GTE': arity(2); if (!same(args[0]!, args[1]!)) invalid(); return result('boolean');
      case 'ADD': case 'SUBTRACT': arity(2); if (!numeric(args[0]!) || !same(args[0]!, args[1]!)) invalid(); return result(args[0]!.type, args[0]!.currency);
      case 'MULTIPLY': arity(2); if (!args.every(numeric) || args.every((arg) => arg.type === 'money')) invalid(); return result(args.some((arg) => arg.type === 'money') ? 'money' : 'number', args.find((arg) => arg.type === 'money')?.currency);
      case 'DIVIDE': arity(2); if (!numeric(args[0]!) || args[1]!.type !== 'number') invalid(); return result(args[0]!.type, args[0]!.currency);
      case 'ROUND': arity(2); if (!numeric(args[0]!) || args[1]!.type !== 'number') invalid(); return result(args[0]!.type, args[0]!.currency);
      case 'ADD_DAYS': case 'ADD_MONTHS': types('date', 'number'); return result('date');
      case 'DAYS_BETWEEN': types('date', 'date'); return result('number');
      case 'BUSINESS_DAY_OF_MONTH':
        arity(2); if (args[0]!.type !== 'date' || !['text', 'number'].includes(args[1]!.type)) invalid();
        if (args[1]!.node.kind === 'literal' && args[1]!.type === 'text' && args[1]!.node.value !== 'last' && args[1]!.node.value !== null) invalid();
        return result('date');
    }
  };
  for (const column of columns.filter((column) => column.type === 'calculated')) columnRoot(column.id);
  for (const column of columns.filter((column) => column.type === 'calculated')) {
    let count = 0;
    /** O teto também cobre cadeias de referências calculadas, para não contornar profundidade via colunas. */
    const expanded = (node: FormulaNode, depth: number): void => {
      if (++count > 100 || depth > 10) invalid();
      if (node.kind === 'call') node.args.forEach((arg) => expanded(arg, depth + 1));
      else if (node.kind === 'ref') {
        const dependency = byId.get(node.columnId)!;
        if (dependency.type === 'calculated') expanded(dependency.formula, depth + 1);
      }
    };
    if (column.type === 'calculated') expanded(column.formula, 1);
  }
  /** Expande só a projeção e as dependências usadas por filtro/ordem/agregação. */
  const dependencies = (ids: string[]): Set<string> => {
    const found = new Set<string>();
    const visit = (id: string): void => {
      if (found.has(id)) return;
      found.add(id);
      const walk = (node: FormulaNode): void => { if (node.kind === 'ref') visit(node.columnId); else if (node.kind === 'call') node.args.forEach(walk); };
      const column = byId.get(id);
      if (column?.type === 'calculated') walk(column.formula);
    };
    ids.forEach(visit);
    return found;
  };
  return { columns: byId, roots, dependencies };
}

/** Prazo compartilhado cobre todas as etapas SQL e os laços JS da consulta, sem completar com parcial. */
export async function queryWithin<T>(tx: Queryable, deadline: number, sql: string, params: unknown[] = []): Promise<T[]> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new DomainError('SERVICE_UNAVAILABLE');
  await tx.query('SELECT set_config(\'statement_timeout\', $1, true)', [`${Math.max(1, Math.floor(remaining))}ms`]);
  return (await tx.query(sql, params)).rows as T[];
}

/** Avalia somente campos necessários. IF/COALESCE escolhem os índices antes de avaliar seus ramos. */
export async function evaluateFormulas(tx: Queryable, plan: FormulaPlan, records: TableRecord[], ids: string[], today: string, deadline: number): Promise<TableRecord[]> {
  const indices = records.map((_, index) => index);
  const cache = new Map<string, Map<number, Value>>();
  /** Cache por coluna/registro evita repetir referências compartilhadas e respeita ramos lazily selecionados. */
  const columnValues = async (id: string, selected: number[]): Promise<Value[]> => {
    const column = plan.columns.get(id)!;
    const memo = cache.get(id) ?? new Map<number, Value>();
    cache.set(id, memo);
    const missing = selected.filter((index) => !memo.has(index));
    if (missing.length) {
      const values = column.type === 'calculated' ? await evaluate(plan.roots.get(id)!, missing) : missing.map((index) => ({ value: records[index]!.values[id] ?? null }));
      const normalized = column.type === 'calculated' && ['number', 'money'].includes(column.resultType)
        ? await normalize(values, column.resultType) : values;
      missing.forEach((index, offset) => memo.set(index, normalized[offset]!));
    }
    return selected.map((index) => memo.get(index)!);
  };
  /** Arredondamento NUMERIC metade para longe de zero e limites canônicos no resultado da coluna. */
  const normalize = async (values: Value[], type: FormulaType): Promise<Value[]> => {
    const items = values.flatMap((cell, i) => cell.error || cell.value === null ? [] : [{ i, v: cell.value }]);
    if (!items.length) return values;
    const rounded = await queryWithin<{ i: number; v: string }>(tx, deadline, 'SELECT i, trim_scale(round(v::numeric, $2))::text AS v FROM jsonb_to_recordset($1::jsonb) AS x(i int, v text)', [JSON.stringify(items), type === 'money' ? 2 : 6]);
    const output = [...values];
    for (const row of rounded) output[row.i] = validDecimal(row.v, type === 'money' ? 14 : 18, type === 'money' ? 2 : 6) ? { value: row.v } : { value: null, error: 'OVERFLOW' };
    return output;
  };
  /** Nó já tipado só contém operações permitidas; dados entram em parâmetros, jamais em trechos SQL. */
  const evaluate = async (node: TypedNode, selected: number[]): Promise<Value[]> => {
    if (performance.now() > deadline) throw new DomainError('SERVICE_UNAVAILABLE');
    if (!selected.length) return [];
    const raw = node.node;
    if (raw.kind === 'literal') return selected.map(() => ({ value: raw.value }));
    if (raw.kind === 'ref') return columnValues(raw.columnId, selected);
    if (raw.op === 'TODAY') return selected.map(() => ({ value: today }));
    if (raw.op === 'IF') {
      const condition = await evaluate(node.args[0]!, selected);
      const output: Value[] = condition.map((cell) => cell.error ? cell : { value: null });
      for (const [truth, branch] of [[true, 1], [false, 2]] as const) {
        const offsets = condition.flatMap((cell, i) => !cell.error && (cell.value === true) === truth ? [i] : []);
        const chosen = await evaluate(node.args[branch]!, offsets.map((i) => selected[i]!));
        offsets.forEach((i, offset) => { output[i] = chosen[offset]!; });
      }
      return output;
    }
    if (raw.op === 'COALESCE') {
      const output: Value[] = selected.map(() => ({ value: null }));
      for (const arg of node.args) {
        const offsets = output.flatMap((cell, i) => cell.value === null && !cell.error ? [i] : []);
        const values = await evaluate(arg, offsets.map((i) => selected[i]!));
        offsets.forEach((i, offset) => { output[i] = values[offset]!; });
      }
      return output;
    }
    const args: Value[][] = [];
    for (const arg of node.args) args.push(await evaluate(arg, selected));
    const output: Value[] = selected.map((_, i) => {
      const error = args.find((values) => values[i]!.error)?.[i]!.error;
      return { value: null, ...(error ? { error } : {}) };
    });
    if (['AND', 'OR', 'NOT'].includes(raw.op)) return output.map((cell, i) => {
      if (cell.error) return cell;
      const values = args.map((arg) => arg[i]!.value);
      return { value: raw.op === 'NOT' ? values[0] === null ? null : !values[0] : raw.op === 'AND' ? values.includes(false) ? false : values.includes(null) ? null : true : values.includes(true) ? true : values.includes(null) ? null : false };
    });
    if (['ADD_DAYS', 'ADD_MONTHS', 'DAYS_BETWEEN', 'BUSINESS_DAY_OF_MONTH'].includes(raw.op)) return output.map((cell, i) => {
      if (cell.error || args.some((arg) => arg[i]!.value === null)) return cell;
      try {
        const date = parseCivilDate(args[0]![i]!.value as string);
        const second = args[1]![i]!.value as string;
        if (raw.op === 'DAYS_BETWEEN') return { value: String(civilOrdinal(parseCivilDate(second)) - civilOrdinal(date)) };
        if (raw.op === 'BUSINESS_DAY_OF_MONTH') {
          if (node.args[1]!.type === 'text' && second !== 'last') throw new RangeError('posição textual inválida');
          return { value: formatCivilDate(businessDayOfMonth(date.year, date.month, second === 'last' ? 'last' : integerOffset(second))) };
        }
        return { value: formatCivilDate(raw.op === 'ADD_DAYS' ? addCivilDays(date, integerOffset(second)) : addCivilMonths(date, integerOffset(second))) };
      } catch { return { value: null, error: 'INVALID_DATE' }; }
    });
    const operands = selected.flatMap((_, i) => output[i]!.error || args.some((arg) => arg[i]!.value === null) ? [] : [{ i, a: args[0]![i]!.value, b: args[1]![i]!.value }]);
    if (!operands.length) return output;
    const operations: Record<string, string> = { ADD: 'a::numeric + b::numeric', SUBTRACT: 'a::numeric - b::numeric', MULTIPLY: 'a::numeric * b::numeric', DIVIDE: `round(a::numeric / NULLIF(b::numeric, 0), ${node.type === 'money' ? 2 : 6})`, ROUND: 'CASE WHEN b::numeric = trunc(b::numeric) AND b::numeric BETWEEN 0 AND 6 THEN round(a::numeric, b::int) END' };
    const comparison: Record<string, string> = { EQ: '=', NE: '<>', LT: '<', LTE: '<=', GT: '>', GTE: '>=' };
    const cast = { number: 'numeric', money: 'numeric', boolean: 'boolean', date: 'date', time: 'time', datetime: 'timestamptz', text: 'text' }[node.args[0]!.type];
    const expression = comparison[raw.op] ? `a::${cast} ${comparison[raw.op]} b::${cast}` : operations[raw.op]!;
    const rows = await queryWithin<{ i: number; v: string | boolean | null; zero: boolean; bad_round: boolean }>(tx, deadline, `SELECT i, ${node.type === 'boolean' ? `(${expression})` : `trim_scale((${expression}))::text`} AS v, ${raw.op === 'DIVIDE' ? 'b::numeric = 0' : 'false'} AS zero, ${raw.op === 'ROUND' ? 'b::numeric <> trunc(b::numeric) OR b::numeric NOT BETWEEN 0 AND 6' : 'false'} AS bad_round FROM jsonb_to_recordset($1::jsonb) AS x(i int, a text, b text)`, [JSON.stringify(operands)]);
    for (const row of rows) output[row.i] = row.zero ? { value: null, error: 'DIVISION_BY_ZERO' } : row.bad_round ? { value: null, error: 'OVERFLOW' } : { value: row.v };
    return output;
  };
  for (const id of ids) if (plan.columns.get(id)?.type === 'calculated') await columnValues(id, indices);
  return records.map((record, index) => {
    const errors = { ...record.errors };
    const values = { ...record.values };
    for (const id of ids) {
      const cell = cache.get(id)?.get(index);
      if (cell) { values[id] = cell.value; if (cell.error) errors[id] = cell.error; }
    }
    return { ...record, values, ...(Object.keys(errors).length ? { errors } : {}) };
  });
}

/** Só offsets civis inteiros e seguros viram Number; valores financeiros nunca seguem este caminho. */
function integerOffset(value: string): number {
  if (!/^-?\d+$/.test(value) || value.length > 8) throw new RangeError('inteiro civil inválido');
  return Number(value);
}
