// Contratos das tabelas: IDs estáveis e entrada estrita compartilhada pela API e pelas futuras ferramentas.
// Regras dependentes do schema/acesso vivem em TableService, nunca em callers.
import { z } from 'zod';
import { CONTROL_CHARS_EXCEPT_WHITESPACE } from './bots';

export const TABLE_BODY_LIMIT = 1024 * 1024;
export const TABLE_LIMITS = { tables: 100, columns: 50, records: 10_000, batch: 100 } as const;
export const tableIdSchema = z.uuid();
export const tableVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Texto externo sem controles que o banco/renderização não possam representar. */
const text = (max: number) => z.string().max(max).refine((value) => !CONTROL_CHARS_EXCEPT_WHITESPACE.test(value));
const name = z.string().trim().normalize('NFC').min(1).max(80).regex(/^[^\p{Cc}]*$/u);
const identity = { id: tableIdSchema.optional(), name };
const option = z.strictObject({ id: tableIdSchema, label: name });
const options = z.array(option).min(1).max(100).refine((items) => new Set(items.map((item) => item.id)).size === items.length);

export const FORMULA_OPERATORS = ['ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'AND', 'OR', 'NOT', 'IF', 'COALESCE', 'ROUND', 'TODAY', 'ADD_DAYS', 'ADD_MONTHS', 'DAYS_BETWEEN', 'BUSINESS_DAY_OF_MONTH'] as const;
export const FORMULA_TYPES = ['text', 'number', 'money', 'boolean', 'date', 'time', 'datetime'] as const;
export type FormulaType = typeof FORMULA_TYPES[number];
export type FormulaNode = { kind: 'literal'; type: FormulaType; value: string | boolean | null; currency?: string }
  | { kind: 'ref'; columnId: string } | { kind: 'call'; op: typeof FORMULA_OPERATORS[number]; args: FormulaNode[] };

/** Validação iterativa antes da recursão do compilador: entradas profundas não podem estourar a pilha. */
function validFormula(input: unknown): input is FormulaNode {
  const pending = [{ node: input, depth: 1 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 100 || depth > 10 || node === null || typeof node !== 'object' || Array.isArray(node)) return false;
    const value = node as Record<string, unknown>;
    const keys = Object.keys(value);
    if (value.kind === 'ref') {
      if (keys.length !== 2 || !tableIdSchema.safeParse(value.columnId).success) return false;
    } else if (value.kind === 'literal') {
      if (keys.some((key) => !['kind', 'type', 'value', 'currency'].includes(key)) || !keys.includes('value') || !FORMULA_TYPES.includes(value.type as FormulaType)) return false;
      if (value.value !== null && typeof value.value !== 'string' && typeof value.value !== 'boolean') return false;
      if (value.currency !== undefined && (value.type !== 'money' || typeof value.currency !== 'string' || !Intl.supportedValuesOf('currency').includes(value.currency))) return false;
      if (value.type === 'money' && value.currency === undefined) return false;
    } else if (value.kind === 'call') {
      if (keys.length !== 3 || !FORMULA_OPERATORS.includes(value.op as typeof FORMULA_OPERATORS[number]) || !Array.isArray(value.args) || value.args.length > 100) return false;
      pending.push(...value.args.map((node) => ({ node, depth: depth + 1 })));
    } else return false;
  }
  // Somente uma árvore já limitada é serializada; ciclos/profundidade hostil não chegam ao JSON.stringify.
  const encoded = JSON.stringify(input);
  return typeof encoded === 'string' && encoded.length <= 4000;
}
/** Estrutura recursiva publicada como JSON Schema; a guarda iterativa roda antes de qualquer parse recursivo. */
const formulaNodeSchema: z.ZodType<FormulaNode> = z.lazy(() => z.union([
  z.strictObject({ kind: z.literal('literal'), type: z.enum(FORMULA_TYPES.filter((type) => type !== 'money')), value: z.union([z.string(), z.boolean(), z.null()]).describe('Decimais de number são strings exatas, por exemplo "1", nunca números JSON. Datas usam YYYY-MM-DD.') }),
  z.strictObject({ kind: z.literal('literal'), type: z.literal('money'), value: z.union([z.string(), z.boolean(), z.null()]), currency: z.string().describe('Código ISO da moeda, por exemplo BRL; valor decimal em string.') }),
  z.strictObject({ kind: z.literal('ref'), columnId: tableIdSchema }),
  z.strictObject({ kind: z.literal('call'), op: z.enum(FORMULA_OPERATORS), args: z.array(formulaNodeSchema).max(100) }),
]));
export const tableFormulaSchema = z.preprocess((input, ctx) => {
  if (!validFormula(input)) { ctx.addIssue({ code: 'custom', message: 'Fórmula inválida ou acima dos limites.' }); return z.NEVER; }
  return input;
}, formulaNodeSchema).describe('AST literal/ref/call; até 10 níveis, 100 nós e 4000 caracteres. Não é um filtro de consulta.');

/** Refinamento aplicado depois dos campos tipados; o genérico da identidade não altera a moeda. */
function validCalculatedCurrency(input: unknown): boolean {
  const column = input as { resultType: FormulaType; currency?: string };
  return column.resultType === 'money' ? column.currency !== undefined : column.currency === undefined;
}
/** Reutiliza configuração e refinamentos de cada tipo nos contratos de criação e atualização. */
function columnInputSchema<T extends { name: typeof name; id?: typeof identity.id }>(identity: T) {
  return z.discriminatedUnion('type', [
    z.strictObject({ ...identity, type: z.literal('text') }),
    z.strictObject({ ...identity, type: z.literal('number') }),
    z.strictObject({ ...identity, type: z.literal('money'), currency: z.string().regex(/^[A-Z]{3}$/).refine((value) => Intl.supportedValuesOf('currency').includes(value)) }),
    z.strictObject({ ...identity, type: z.literal('boolean') }),
    z.strictObject({ ...identity, type: z.literal('select'), options }),
    z.strictObject({ ...identity, type: z.literal('multiselect'), options }),
    z.strictObject({ ...identity, type: z.literal('date') }),
    z.strictObject({ ...identity, type: z.literal('time') }),
    z.strictObject({ ...identity, type: z.literal('datetime') }),
    z.strictObject({ ...identity, type: z.literal('relation'), targetTableId: tableIdSchema, cardinality: z.enum(['one', 'many']) }),
    z.strictObject({ ...identity, type: z.literal('calculated'), formula: tableFormulaSchema, resultType: z.enum(FORMULA_TYPES), currency: z.string().refine((value) => Intl.supportedValuesOf('currency').includes(value)).optional() }).refine(validCalculatedCurrency),
  ]);
}
/** Cada tipo aceita somente sua configuração; dinheiro calculado também declara sua moeda. */
export const tableColumnInputSchema = columnInputSchema(identity);
/** Colunas novas recebem identidade do servidor; IDs do export continuam no contrato de importação. */
export const tableColumnCreateSchema = columnInputSchema({ name });
export type TableColumnInput = z.infer<typeof tableColumnInputSchema>;
export type TableColumn = TableColumnInput & { id: string };
const columns = z.array(tableColumnInputSchema).max(TABLE_LIMITS.columns)
  .refine((items) => new Set(items.map((item) => item.name.toLocaleLowerCase('pt-BR'))).size === items.length)
  .refine((items) => new Set(items.filter((item) => item.id).map((item) => item.id)).size === items.filter((item) => item.id).length);
const operationId = tableIdSchema;
const createColumns = z.array(tableColumnCreateSchema).max(TABLE_LIMITS.columns)
  .refine((items) => new Set(items.map((item) => item.name.toLocaleLowerCase('pt-BR'))).size === items.length)
  .describe('Colunas novas sem id: o servidor gera e devolve seus IDs. IDs das opções select/multiselect continuam obrigatórios.');
export const tableCreateSchema = z.strictObject({ name, description: text(1000).default(''), columns: createColumns.default([]), operationId });
export const tableUpdateSchema = z.strictObject({ name: name.optional(), description: text(1000).optional(), columns: columns.describe('Lista COMPLETA das colunas visíveis: preserve IDs/definições de table_get e acrescente novas. Não é patch. O servidor preserva ocultas; exclusões/conversões exigem operação destrutiva.').optional(), expectedSchemaVersion: tableVersionSchema, operationId });
export const tableShareSchema = z.strictObject({ botIds: z.array(tableIdSchema).max(100).refine((ids) => new Set(ids).size === ids.length), expectedVersion: tableVersionSchema, operationId });
/** Escalares JSON somente; arrays servem a seleções/relações. Nenhum objeto executável ou campo interno é aceito. */
export const tableCellSchema = z.union([text(8000), z.boolean(), z.array(text(8000)).max(100), z.null()]);
export type TableCell = z.infer<typeof tableCellSchema>;
export const tableValuesSchema = z.record(tableIdSchema, tableCellSchema).refine((values) => Object.keys(values).length <= TABLE_LIMITS.columns)
  .describe('Objeto {columnId UUID: valor}; use IDs retornados por table_create/table_get, nunca nomes. number/money exigem strings decimais canônicas sem zeros fracionários finais: "1.20"→"1.2", "0.00"→"0". Preserve texto e null.');
export const tableRecordCreateSchema = z.strictObject({ values: tableValuesSchema, deduplicationKey: text(200).min(1).optional() });
export const tableRecordUpdateSchema = z.strictObject({ id: tableIdSchema, expectedVersion: tableVersionSchema, values: tableValuesSchema });
export const tableWriteSchema = z.strictObject({
  operationId, expectedSchemaVersion: tableVersionSchema,
  creates: z.array(tableRecordCreateSchema).max(100).default([]), updates: z.array(tableRecordUpdateSchema).max(100).default([]),
}).refine((input) => input.creates.length + input.updates.length > 0 && input.creates.length + input.updates.length <= 100)
  .refine((input) => new Set(input.updates.map((item) => item.id)).size === input.updates.length);
export const tableParamsSchema = z.strictObject({ tableId: tableIdSchema });
/** Leitura individual do dono vincula o registro à tabela, sem aceitar projeção ou identidade de bot. */
export const tableRecordParamsSchema = tableParamsSchema.extend({ recordId: tableIdSchema });
export const botTableParamsSchema = z.strictObject({ botId: tableIdSchema });
export const tablePageSchema = z.strictObject({ cursor: tableIdSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(100) });
export type TableCreate = z.infer<typeof tableCreateSchema>;
export type TableUpdate = z.infer<typeof tableUpdateSchema>;
export type TableWrite = z.infer<typeof tableWriteSchema>;
export type TableShare = z.infer<typeof tableShareSchema>;
/** Alvos concretos e revisão inteira da tabela, incluindo dados e acessos. Preparações não concedem permissão. */
export const tableDestructiveSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('delete_table'), expectedVersion: tableVersionSchema }),
  z.strictObject({ kind: z.literal('delete_records'), expectedVersion: tableVersionSchema, records: z.array(z.strictObject({ id: tableIdSchema, expectedVersion: tableVersionSchema })).min(1).max(100).refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length) }),
  z.strictObject({ kind: z.literal('delete_column'), expectedVersion: tableVersionSchema, columnId: tableIdSchema }),
  z.strictObject({ kind: z.literal('convert_column'), expectedVersion: tableVersionSchema, column: tableColumnInputSchema.refine((column) => column.id !== undefined) }),
]);
export const tableConfirmSchema = z.strictObject({ preparationId: tableIdSchema, operationId, confirmation: z.literal(true) });
export type TableDestructive = z.infer<typeof tableDestructiveSchema>;
/** Catálogo local compartilhado: navegador e executor usam as mesmas categorias, sem consultar o conector. */
export const TABLE_ACTIONS = {
  delete_table: { slug: 'aion_table_delete', label: 'Excluir tabela', appSlug: 'aion_tables', appName: 'Tabelas do Aion' },
  delete_records: { slug: 'aion_table_records_delete', label: 'Excluir registros', appSlug: 'aion_tables', appName: 'Tabelas do Aion' },
  delete_column: { slug: 'aion_table_column_delete', label: 'Excluir coluna', appSlug: 'aion_tables', appName: 'Tabelas do Aion' },
  convert_column: { slug: 'aion_table_column_convert', label: 'Converter coluna', appSlug: 'aion_tables', appName: 'Tabelas do Aion' },
} as const;
/** Impedimentos do portão são metadados autorizados, nunca conteúdo dos registros. */
export const tableDependencySchema = z.strictObject({ kind: z.enum(['relation', 'formula', 'view']), tableId: tableIdSchema, tableName: name, name });
export type TableDependency = z.infer<typeof tableDependencySchema>;
export const tableDependenciesRequestSchema = z.strictObject({ operation: tableDestructiveSchema, cursor: z.number().int().min(0).max(5000).optional(), limit: z.number().int().min(1).max(100).default(20) });
export type TableDependenciesRequest = z.infer<typeof tableDependenciesRequestSchema>;
export interface TableDependencies { dependencies: TableDependency[]; nextCursor: number | null }
export type TableConfirm = z.infer<typeof tableConfirmSchema>;
export interface TableImpact { kind: TableDestructive['kind']; tableId: string; tableName: string; expectedVersion: number; recordCount: number; columnId?: string; columnName?: string; recordIds?: string[] }
export interface TablePreparation { preparationId: string; impact: TableImpact }
/** Impacto completo é metadata, sem valores de células; a UI pode renderizá-lo sem interpretar argumentos. */
export const tableImpactSchema = z.strictObject({ kind: z.enum(['delete_table', 'delete_records', 'delete_column', 'convert_column']), tableId: tableIdSchema, tableName: name, expectedVersion: tableVersionSchema, recordCount: z.number().int().nonnegative(), columnId: tableIdSchema.optional(), columnName: name.optional(), recordIds: z.array(tableIdSchema).max(100).optional() });
export interface TableRecord { id: string; version: number; values: Record<string, TableCell>; errors?: Record<string, TableCellError> }
export interface DataTable { id: string; name: string; description: string; version: number; schemaVersion: number; columns: TableColumn[]; botIds: string[] }

export type TableCellError = 'DIVISION_BY_ZERO' | 'OVERFLOW' | 'INVALID_DATE' | 'DEPENDENCY_ERROR';
export type TableFilter = { op: 'and' | 'or'; filters: TableFilter[] }
  | { op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'includes' | 'empty' | 'not_empty'; columnId: string; value?: TableCell };
/** Limites de árvore de filtro independentes de callers e sem coerção de tipos de célula. */
function validFilter(input: unknown): input is TableFilter {
  const pending = [{ node: input, depth: 1 }];
  let predicates = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (depth > 3 || node === null || typeof node !== 'object' || Array.isArray(node)) return false;
    const item = node as Record<string, unknown>;
    if (item.op === 'and' || item.op === 'or') {
      if (Object.keys(item).length !== 2 || !Array.isArray(item.filters) || !item.filters.length || item.filters.length > 20) return false;
      pending.push(...item.filters.map((node) => ({ node, depth: depth + 1 })));
    } else {
      if (++predicates > 20 || !['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'includes', 'empty', 'not_empty'].includes(String(item.op)) || !tableIdSchema.safeParse(item.columnId).success || Object.keys(item).some((key) => !['op', 'columnId', 'value'].includes(key))) return false;
      if (item.op === 'empty' || item.op === 'not_empty') { if (Object.hasOwn(item, 'value')) return false; }
      else if (!Object.hasOwn(item, 'value') || !tableCellSchema.safeParse(item.value).success) return false;
    }
  }
  return true;
}
/** Filtros têm operadores minúsculos e grupos filters; compartilham o contrato com API, vistas e ferramentas. */
const filterNodeSchema: z.ZodType<TableFilter> = z.lazy(() => z.union([
  z.strictObject({ op: z.enum(['and', 'or']), filters: z.array(filterNodeSchema).min(1).max(20) }),
  z.strictObject({ op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'includes']), columnId: tableIdSchema, value: tableCellSchema }),
  z.strictObject({ op: z.enum(['empty', 'not_empty']), columnId: tableIdSchema }),
]));
export const tableFilterSchema = z.preprocess((input, ctx) => {
  if (!validFilter(input)) { ctx.addIssue({ code: 'custom', message: 'Filtro inválido ou acima dos limites.' }); return z.NEVER; }
  return input;
}, filterNodeSchema).describe('Até 3 níveis e 20 predicados. Exemplo: {"op":"and","filters":[{"op":"eq","columnId":"UUID","value":"ID da opção"},{"op":"lt","columnId":"UUID","value":"2026-11-01"}]}. Não usa kind/call.');
const uniqueIds = z.array(tableIdSchema).max(50).refine((ids) => new Set(ids).size === ids.length);
const sort = z.array(z.strictObject({ columnId: tableIdSchema, direction: z.enum(['asc', 'desc']) })).max(3).refine((items) => new Set(items.map((item) => item.columnId)).size === items.length);
const recordIds = z.array(tableIdSchema).min(1).max(100).refine((ids) => new Set(ids).size === ids.length);
const queryPage = { cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).default(100) };
/** Lookup de seleções existentes usa a mesma projeção e paginação de consulta, sem filtros/vistas implícitos. */
export const tableRecordLookupSchema = z.strictObject({ ids: recordIds, columns: uniqueIds.optional(), ...queryPage });
export type TableRecordLookup = z.infer<typeof tableRecordLookupSchema>;
export const tableQueryDefinitionSchema = z.strictObject({ columns: uniqueIds.optional(), filter: tableFilterSchema.nullable().optional(), sort: sort.optional() });
export const tableQuerySchema = tableQueryDefinitionSchema.extend({
  ...queryPage, viewId: tableIdSchema.optional(), recordIds: recordIds.optional(),
  aggregate: z.array(z.strictObject({ alias: name, op: z.enum(['count', 'sum', 'avg', 'min', 'max']), columnId: tableIdSchema.optional() })).max(10).refine((items) => new Set(items.map((item) => item.alias)).size === items.length).optional(),
  groupBy: z.array(tableIdSchema).max(3).refine((ids) => new Set(ids).size === ids.length).optional(),
});
export type TableQuery = z.infer<typeof tableQuerySchema>;
export type TableQueryDefinition = z.infer<typeof tableQueryDefinitionSchema>;
export const tableViewCreateSchema = tableQueryDefinitionSchema.extend({ name, operationId });
export const tableViewUpdateSchema = tableViewCreateSchema.extend({ expectedVersion: tableVersionSchema });
export const tableViewRemoveSchema = z.strictObject({ expectedVersion: tableVersionSchema, operationId });
export const tableViewParamsSchema = tableParamsSchema.extend({ viewId: tableIdSchema });
export type TableView = TableQueryDefinition & { id: string; name: string; version: number };
export type TableViewCreate = z.infer<typeof tableViewCreateSchema>;
export type TableViewUpdate = z.infer<typeof tableViewUpdateSchema>;
export const tableFormulaPreviewSchema = z.strictObject({ columnId: tableIdSchema.optional(), formula: tableFormulaSchema, resultType: z.enum(FORMULA_TYPES), currency: z.string().optional(), values: tableValuesSchema.default({}) });
export interface TableQueryResult { records: TableRecord[]; aggregate?: Record<string, TableCell>; groups?: { values: Record<string, TableCell>; aggregate: Record<string, TableCell> }[]; nextCursor: string | null; hasMore: boolean; totalCount: number }
