// Consulta tipada sobre linhas já calculadas. PostgreSQL resolve filtros, ordenação e agregação exatos;
// projeção, cursores vinculados e teto UTF-8 permanecem comuns ao dono e às ferramentas.
import { createHash } from 'node:crypto';
import type { TableCell, TableColumn, TableFilter, TableQuery, TableQueryDefinition, TableQueryResult, TableRecord } from '@aion/shared';
import type { Queryable } from '../db/pool';
import { DomainError } from '../errors';
import { queryWithin } from './formulas';
import { scalarType, sqlType, validateScalar, validDecimal } from './scalars';

export const TABLE_QUERY_BYTES = 64 * 1024;
/** Ordem de propriedades não muda identidade da consulta/cursor. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${canonicalJSON(value)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Dependências explícitas de filtro, ordenação, projeção, grupos e totais. */
export function queryColumns(query: TableQueryDefinition & Pick<TableQuery, 'aggregate' | 'groupBy'>, visible: TableColumn[]): Set<string> {
  const ids = new Set(query.columns ?? visible.map((column) => column.id));
  const filter = (node: TableFilter): void => { if ('filters' in node) node.filters.forEach(filter); else ids.add(node.columnId); };
  if (query.filter) filter(query.filter);
  query.sort?.forEach((sort) => ids.add(sort.columnId));
  query.aggregate?.forEach((aggregate) => { if (aggregate.columnId) ids.add(aggregate.columnId); });
  query.groupBy?.forEach((id) => ids.add(id));
  return ids;
}

/**
 * Recusa de consulta com o MOTIVO (`DomainError.fields`: campo e razão), que a ferramenta `table_query` devolve ao modelo. Todas as recusas desta validação eram o mesmo
 * `TABLE_INVALID_VALUE` com a mensagem fixa "Valor inválido para a coluna." e o modelo repetia o filtro (13% das consultas falhavam); agora ele sabe qual regra quebrou. Os
 * motivos nunca citam o valor nem o nome de coluna enviados, só a regra.
 */
const refuse = (field: string, reason: string): DomainError => new DomainError('TABLE_INVALID_VALUE', { fields: [{ field, reason }] });

/** Formato do valor de filtro por tipo escalar, para o motivo de `validateScalar` (a regra é a de `scalars.ts`). */
const VALUE_FORMAT: Readonly<Record<string, string>> = {
  text: 'texto', number: 'texto decimal canônico, até 6 casas ("12.5", nunca "12.50")', money: 'texto decimal canônico, até 2 casas ("12.5", nunca "12.50")', boolean: 'true ou false',
  date: '"AAAA-MM-DD"', time: '"HH:mm"', datetime: 'ISO com fuso ("2026-11-07T14:30:00-03:00")',
};

/** Validação contra o schema autorizado: uma vista não pode ampliar acesso nem remover filtro oculto. */
export function validateQuery(query: TableQueryDefinition & Pick<TableQuery, 'aggregate' | 'groupBy'>, visible: TableColumn[], all: TableColumn[]): void {
  const byId = new Map(visible.map((column) => [column.id, column]));
  for (const id of queryColumns(query, visible)) if (!byId.has(id)) throw all.some((column) => column.id === id) ? new DomainError('TABLE_ACCESS_DENIED') : refuse('columnId', 'a coluna não existe nesta tabela: use os ids de table_get');
  const filter = (node: TableFilter): void => {
    if ('filters' in node) { node.filters.forEach(filter); return; }
    const column = byId.get(node.columnId)!;
    const type = scalarType(column);
    if (node.op === 'empty' || node.op === 'not_empty') return;
    if (node.op === 'contains') { if (type !== 'text' || column.type === 'select' || typeof node.value !== 'string') throw refuse('filter.op', 'contains vale só em coluna de texto livre e leva um texto; em seleção use eq com o id da opção'); return; }
    if (node.op === 'includes') {
      if (!['select', 'multiselect', 'relation'].includes(column.type) || typeof node.value !== 'string') throw refuse('filter.op', 'includes vale só em seleção, multisseleção e relação, e leva um id (da opção ou do registro)');
      if (column.type === 'select' || column.type === 'multiselect') { if (!column.options.some((option) => option.id === node.value)) throw refuse('filter.value', 'em coluna de seleção o value é o ID da opção (de table_get), não o rótulo'); }
      else if (!/^[0-9a-f-]{36}$/i.test(node.value)) throw refuse('filter.value', 'em coluna de relação o value é o UUID do registro de destino');
      return;
    }
    if (type === 'multiselect' || type === 'relation' && column.type === 'relation' && column.cardinality === 'many') throw refuse('filter.op', 'em multisseleção e em relação com vários registros use includes, não ' + node.op);
    try { validateScalar(column, node.value!, true); }
    catch (error) {
      if (!(error instanceof DomainError)) throw error;
      const shape = column.type === 'select' ? 'o ID da opção (de table_get), não o rótulo' : column.type === 'relation' ? 'o UUID do registro de destino' : VALUE_FORMAT[type] ?? type;
      throw refuse('filter.value', 'o value não serve a esta coluna (' + (column.type === 'select' ? 'seleção' : type) + '): use ' + shape);
    }
    if (['lt', 'lte', 'gt', 'gte'].includes(node.op) && type === 'boolean') throw refuse('filter.op', 'comparação de ordem não vale em coluna boolean: use eq com true ou false');
  };
  if (query.filter) filter(query.filter);
  for (const sort of query.sort ?? []) if (sqlType(byId.get(sort.columnId)!) === 'jsonb') throw refuse('sort', 'não se ordena por multisseleção nem por relação com vários registros');
  for (const aggregate of query.aggregate ?? []) {
    if (aggregate.op === 'count') { if (aggregate.columnId) throw refuse('aggregate.columnId', 'count não leva columnId: conta os registros'); continue; }
    if (!aggregate.columnId) throw refuse('aggregate.columnId', aggregate.op + ' exige columnId');
    const type = scalarType(byId.get(aggregate.columnId)!);
    if (['sum', 'avg'].includes(aggregate.op) ? !['number', 'money'].includes(type) : ['relation', 'multiselect', 'boolean'].includes(type)) throw refuse('aggregate.op', aggregate.op + ' não vale nesta coluna (' + type + '): sum e avg exigem number ou money; min e max não valem em relação, multisseleção nem boolean');
  }
  if (query.groupBy?.length && !query.aggregate?.length) throw refuse('groupBy', 'groupBy exige aggregate');
  if (query.groupBy?.some((id) => sqlType(byId.get(id)!) === 'jsonb')) throw refuse('groupBy', 'não se agrupa por multisseleção nem por relação com vários registros');
}

/** Cursor carrega offset e identidade de consulta/schema/dados; nunca substitui reautorização. */
function cursorOffset(cursor: string | undefined, identity: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { query: string; offset: number };
    if (value.query !== identity || Object.keys(value).length !== 2 || !Number.isInteger(value.offset) || value.offset < 0 || value.offset > 10_000) throw new Error('cursor');
    return value.offset;
  } catch { throw new DomainError('TABLE_QUERY_LIMIT'); }
}

/** SQL construído só com aliases internos e allowlists; nomes, IDs e valores são parâmetros. */
export async function executeQuery(tx: Queryable, query: TableQuery, columns: TableColumn[], rows: TableRecord[], binding: unknown, deadline: number, envelope: (result: TableQueryResult) => unknown = (result) => result): Promise<TableQueryResult> {
  const byId = new Map(columns.map((column) => [column.id, column]));
  const identity = createHash('sha256').update(canonicalJSON({ ...query, cursor: undefined, binding })).digest('hex');
  const offset = cursorOffset(query.cursor, identity);
  const params: unknown[] = [JSON.stringify(rows)];
  /** Cada etapa usa só os placeholders presentes nela, sem parâmetros órfãos de outras etapas. */
  const run = <T>(sql: string): Promise<T[]> => {
    const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
    return queryWithin<T>(tx, deadline, sql.replace(/\$(\d+)/g, (_, index: string) => `$${used.indexOf(Number(index)) + 1}`), used.map((index) => params[index - 1]));
  };
  /** Toda entrada dinâmica recebe placeholder próprio. */
  const param = (value: unknown): string => { params.push(value); return `$${params.length}`; };
  const expressions = new Map<string, string>();
  /** Expressão de célula tipada, com moeda proveniente do schema e sem coerção entre domínios. */
  const field = (id: string): string => {
    if (!expressions.has(id)) {
      const type = sqlType(byId.get(id)!);
      expressions.set(id, type === 'jsonb' ? `NULLIF(cells -> ${param(id)}::text, 'null'::jsonb)` : type === 'text' ? `(cells ->> ${param(id)}::text)` : `NULLIF(cells ->> ${param(id)}::text, '')::${type}`);
    }
    return expressions.get(id)!;
  };
  /** Predicados só aceitam resultado verdadeiro; SQL mantém a lógica de null e os valores literais. */
  const filter = (node: TableFilter): string => {
    if ('filters' in node) return `(${node.filters.map(filter).join(node.op === 'and' ? ' AND ' : ' OR ')})`;
    const expression = field(node.columnId);
    if (node.op === 'empty' || node.op === 'not_empty') {
      const empty = `(${expression} IS NULL${sqlType(byId.get(node.columnId)!) === 'jsonb' ? ` OR ${expression} = '[]'::jsonb` : ''})`;
      return node.op === 'empty' ? empty : `(NOT ${empty})`;
    }
    if (node.op === 'contains') return `(strpos(${expression}, ${param(node.value)}::text) > 0)`;
    if (node.op === 'includes') return sqlType(byId.get(node.columnId)!) === 'jsonb' ? `(${expression} ? ${param(node.value)}::text)` : `(${expression} = ${param(node.value)}::text)`;
    const operator = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[node.op];
    return `(${expression} ${operator} ${param(node.value)}::${sqlType(byId.get(node.columnId)!)})`;
  };
  const predicate = query.filter ? filter(query.filter) : 'true';
  const neededErrors = new Set<string>();
  const addFilterErrors = (node: TableFilter): void => { if ('filters' in node) node.filters.forEach(addFilterErrors); else neededErrors.add(node.columnId); };
  if (query.filter) addFilterErrors(query.filter);
  query.sort?.forEach((sort) => neededErrors.add(sort.columnId));
  query.groupBy?.forEach((id) => neededErrors.add(id));
  if (rows.some((row) => [...neededErrors].some((id) => row.errors?.[id]))) throw new DomainError('TABLE_CELL_ERROR');
  const base = `WITH source AS (SELECT id::uuid AS id, version, values AS cells, errors FROM jsonb_to_recordset($1::jsonb) AS x(id text, version int, values jsonb, errors jsonb)), filtered AS (SELECT id, version, cells, errors FROM source WHERE (${predicate}) IS TRUE)`;
  const matched = await run<{ count: string }>(`${base} SELECT count(*)::text AS count FROM filtered`);
  const totalCount = Number(matched[0]!.count); // cota de 10.000 registros, somente contagem inteira.
  let aggregate: Record<string, TableCell> | undefined;
  let groups: TableQueryResult['groups'];
  let selected: TableRecord[] = [];
  let pageTotal = totalCount;
  if (query.aggregate?.length) {
    const aggregateIds = query.aggregate.flatMap((item) => item.columnId ? [item.columnId] : []);
    const errorConditions = aggregateIds.map((id) => `errors ? ${param(id)}::text`);
    if (errorConditions.length) {
      const errored = await run<{ count: string }>(`${base} SELECT count(*)::text AS count FROM filtered WHERE ${errorConditions.join(' OR ')}`);
      if (errored[0]!.count !== '0') throw new DomainError('TABLE_CELL_ERROR');
    }
    const aggregates = query.aggregate.map((item, index) => {
      const column = item.columnId ? byId.get(item.columnId)! : undefined;
      const expression = item.op === 'count' ? 'count(*)' : `${item.op}(${field(item.columnId!)})`;
      const numeric = column && ['number', 'money'].includes(scalarType(column));
      const result = numeric ? `trim_scale(round(${expression}, ${scalarType(column) === 'money' ? 2 : 6}))::text` : item.op === 'count' ? `(${expression})::text` : `(${expression})::text`;
      return `${result} AS a${index}`;
    });
    const groupIds = query.groupBy ?? [];
    const groupFields = groupIds.map((id, index) => `${field(id)} AS g${index}`);
    const groupExpressions = groupIds.map(field);
    const select = `${groupFields.length ? `${groupFields.join(',')},` : ''} ${aggregates.join(',')}`;
    const grouped = `${base}, grouped AS (SELECT ${select} FROM filtered ${groupExpressions.length ? `GROUP BY ${groupExpressions.join(',')}` : ''})`;
    if (groupFields.length) pageTotal = Number((await run<{ count: string }>(`${grouped} SELECT count(*)::text AS count FROM grouped`))[0]!.count);
    const result = await run<Record<string, string | null>>(`${grouped} SELECT ${groupIds.map((_, index) => `g${index}::text AS g${index},`).join('')} ${query.aggregate.map((_, index) => `a${index}`).join(',')} FROM grouped ${groupFields.length ? `ORDER BY ${groupIds.map((_, index) => `g${index} ASC NULLS LAST`).join(',')} LIMIT ${param(query.limit)} OFFSET ${param(offset)}` : ''}`);
    /** Totais e grupos preservam o domínio de cada agregado, recusando overflow em vez de truncar. */
    const totals = (row: Record<string, string | null>): Record<string, TableCell> => Object.fromEntries(query.aggregate!.map((item, index) => {
      const value = row[`a${index}`] ?? null;
      if (item.columnId && value !== null) {
        const type = scalarType(byId.get(item.columnId)!);
        if (['money', 'number'].includes(type) && !validDecimal(value, type === 'money' ? 14 : 18, type === 'money' ? 2 : 6)) throw new DomainError('TABLE_CELL_ERROR');
      }
      return [item.alias, item.columnId ? canonicalResult(value, byId.get(item.columnId)!) : value];
    }));
    if (groupIds.length) groups = result.map((row) => ({ values: Object.fromEntries(groupIds.map((id, index) => [id, canonicalResult(row[`g${index}`] ?? null, byId.get(id)!)])), aggregate: totals(row) }));
    else aggregate = totals(result[0]!);
  }
  if (!groups && (query.columns?.length !== 0 || !query.aggregate?.length)) {
    const order = [...(query.sort ?? []).map((sort) => `${field(sort.columnId)} ${sort.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`), 'id ASC'];
    const fetched = await run<{ id: string; version: number; cells: Record<string, TableCell>; errors: TableRecord['errors'] | null }>(`${base} SELECT id, version, cells, errors FROM filtered ORDER BY ${order.join(',')} LIMIT ${param(query.limit)} OFFSET ${param(offset)}`);
    const projected = query.columns ?? columns.map((column) => column.id);
    selected = fetched.map((row) => ({ id: row.id, version: row.version, values: Object.fromEntries(projected.map((id) => [id, row.cells[id] ?? null])), ...(row.errors ? { errors: Object.fromEntries(Object.entries(row.errors).filter(([id]) => projected.includes(id))) as TableRecord['errors'] } : {}) }));
  }
  const page = groups ?? selected;
  if (!groups && query.columns?.length === 0 && query.aggregate?.length) pageTotal = 0;
  /** Reserva bytes do envelope e só pagina em fronteiras de linhas/grupos completos. `envelope` é o que será de fato serializado (a ferramenta de tabelas grava o
   * resultado mais as colunas mostradas): o teto de bytes vale para ele, não só para o resultado cru, e o cursor continua apontando para depois da página que coube. */
  const result: TableQueryResult = { records: selected, ...(aggregate ? { aggregate } : {}), ...(groups ? { groups } : {}), nextCursor: null, hasMore: false, totalCount };
  const cursor = (next: number): string => Buffer.from(JSON.stringify({ query: identity, offset: next })).toString('base64url');
  for (;;) {
    result.hasMore = offset + page.length < pageTotal;
    result.nextCursor = result.hasMore ? cursor(offset + page.length) : null;
    if (Buffer.byteLength(JSON.stringify(envelope(result)), 'utf8') <= TABLE_QUERY_BYTES) break;
    if (page.length <= 1) throw new DomainError('TABLE_QUERY_LIMIT');
    page.pop();
  }
  if (performance.now() > deadline) throw new DomainError('SERVICE_UNAVAILABLE');
  return result;
}

/** PostgreSQL retorna datas/horas como texto SQL; a borda volta ao mesmo escalar canônico da escrita. */
function canonicalResult(value: string | null, column: TableColumn): TableCell {
  if (value === null) return null;
  const type = scalarType(column);
  if (type === 'boolean') return value === 'true';
  if (type === 'datetime') return new Date(value).toISOString();
  if (type === 'time') return value.slice(0, 5);
  if (type === 'number' || type === 'money') return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return value;
}
