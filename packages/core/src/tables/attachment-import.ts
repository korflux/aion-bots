// Importação por referência: o modelo coordena fases pequenas; células/ASTs são lidas, validadas e comparadas no servidor.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TABLE_BODY_LIMIT, tableImportDocumentSchema, tableIdSchema, tableViewCreateSchema, type DataTable, type TableCell, type TableColumn, type TableColumnInput, type TableImportToolInput, type TableViewCreate, type TableWrite } from '@aion/shared';
import { DomainError } from '../errors';
import type { ToolContext } from '../runs/tools';
import { attachmentEvidence } from '../runs/evidence-provenance';
import { TableService, type TableActor } from './service';

interface SourceRecord { id: string; values: Record<string, TableCell> }
interface SourceTable { originId: string; name: string; description: string; columns: TableColumn[]; records: SourceRecord[]; views: Omit<TableViewCreate, 'operationId'>[] }
interface Source { hash: string; tables: SourceTable[] }
type ApplyInput = Extract<TableImportToolInput, { operation: 'apply' }>;
interface Applied { tableId?: string; schemaVersion?: number; skipped?: number | boolean; applied?: number; nextOffset?: number | null; viewId?: string; sourceHash?: string; plannedWrite?: TableWrite }
/** IDs derivados mantêm os payloads de estrutura idênticos na recuperação da mesma chamada. */
function derivedId(seed: string): string { const chars = createHash('sha256').update(seed).digest('hex').slice(0, 32).split(''); chars[12] = '4'; chars[16] = '8'; const hex = chars.join(''); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }
/** Colisões de nomes/IDs impossibilitam remapeamento confiável e são rejeitadas antes de qualquer mutação. */
function unique(values: string[]): boolean { return new Set(values).size === values.length; }
/** Parser limitado e versionado; campos extras como workflow são dados ignorados, nunca executados. */
export function parseTableImport(bytes: Buffer): Source {
  if (bytes.length > TABLE_BODY_LIMIT) throw new DomainError('PAYLOAD_TOO_LARGE');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document = tableImportDocumentSchema.parse(JSON.parse(text));
    if (!unique(document.tables.map((table) => table.originId))) throw new Error();
    const tables: SourceTable[] = document.tables.map((table) => {
      const columns = table.columns as TableColumn[];
      if (columns.some((column) => !column.id) || !unique(columns.map((column) => column.id)) || !unique(columns.map((column) => column.name.toLocaleLowerCase('pt-BR')))) throw new Error();
      if (!unique(columns.flatMap((column) => [column.id, ...((column.type === 'select' || column.type === 'multiselect') ? column.options.map((option) => option.id) : [])]))) throw new Error();
      for (const column of columns) if (column.type === 'select' || column.type === 'multiselect') {
        if (!unique(column.options.map((option) => option.label.toLocaleLowerCase('pt-BR')))) throw new Error();
      }
      if ((table.rows !== undefined) === (table.records !== undefined)) throw new Error();
      const rowColumns = table.rowColumns;
      if (table.rows && (!rowColumns || !unique(rowColumns) || rowColumns.some((id) => !columns.some((column) => column.id === id && column.type !== 'calculated')))) throw new Error();
      const records: SourceRecord[] = table.records ?? table.rows!.map((row) => {
        if (row.length !== rowColumns!.length + 1 || !tableIdSchema.safeParse(row[0]).success) throw new Error();
        return { id: row[0] as string, values: Object.fromEntries(rowColumns!.map((id, index) => [id, row[index + 1] as TableCell])) };
      });
      if (!unique(records.map((record) => record.id))) throw new Error();
      const scalarIds = columns.filter((column) => column.type !== 'calculated').map((column) => column.id);
      for (const record of records) if (!isDeepStrictEqual(Object.keys(record.values).sort(), [...scalarIds].sort())) throw new Error();
      const views = table.views.map((view) => { const { operationId: _operation, ...definition } = tableViewCreateSchema.parse({ ...view, operationId: derivedId('validation') }); return definition; });
      if (!unique(views.map((view) => view.name.toLocaleLowerCase('pt-BR')))) throw new Error();
      return { originId: table.originId, name: table.name, description: table.description, columns, records, views };
    });
    for (const table of tables) for (const column of table.columns) if (column.type === 'relation') {
      const target = tables.find((candidate) => candidate.originId === column.targetTableId);
      if (!target) throw new Error();
      const ids = new Set(target.records.map((record) => record.id));
      for (const record of table.records) {
        const value = record.values[column.id];
        if (value === null) continue;
        if (column.cardinality === 'one') { if (typeof value !== 'string' || !ids.has(value)) throw new Error(); }
        else if (!Array.isArray(value) || !unique(value) || value.some((id) => !ids.has(id))) throw new Error();
      }
    }
    return { hash: createHash('sha256').update(bytes).digest('hex'), tables };
  } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('TABLE_IMPORT_INVALID'); }
}
/** Anexo já ligado à conversa, imutável e não removido; generated aceita somente JSON UTF-8 validado novamente aqui. */
async function readSource(context: ToolContext, attachmentId: string): Promise<Source> {
  const found = await context.pool.query<{ kind: string; format: string | null; extracted_text: string | null; file_bytes: Buffer | null; truncated: boolean; bytes: number }>(
    'SELECT kind, format, CASE WHEN octet_length(extracted_text) <= $3 THEN extracted_text END AS extracted_text, CASE WHEN octet_length(file_bytes) <= $3 THEN file_bytes END AS file_bytes, truncated, coalesce(octet_length(extracted_text),octet_length(file_bytes),0) AS bytes FROM attachments WHERE id = $1 AND conversation_id = $2 AND message_id IS NOT NULL AND removed_at IS NULL', [attachmentId, context.conversationId, TABLE_BODY_LIMIT]);
  const row = found.rows[0];
  if (!row) throw new DomainError('ATTACHMENT_NOT_FOUND');
  if (row.bytes > TABLE_BODY_LIMIT) throw new DomainError('PAYLOAD_TOO_LARGE');
  if (row.truncated || !['document', 'generated'].includes(row.kind) || (row.kind === 'generated' && row.format !== 'json')) throw new DomainError('TABLE_IMPORT_INVALID');
  return parseTableImport(row.kind === 'document' ? Buffer.from(row.extracted_text ?? '', 'utf8') : row.file_bytes ?? Buffer.alloc(0));
}
/**
 * Remapeia apenas campos de identidade declarados; textos e literais que pareçam UUID permanecem intactos. Exceção contextual: numa
 * chamada que compara um `ref` de coluna select/multiselect (ex.: `EQ(Status, "<ID da opção Aberto>")`), o literal de texto irmão que for ID
 * de opção DECLARADA daquela coluna vira o ID remapeado da opção. Sem isso a fórmula importada comparava com uma opção inexistente no destino
 * e o cálculo saía errado em silêncio (registro `.erros-encontrados/2026-10-12-importacao-formula-literal-opcao-sem-remapear.md`).
 */
function formulaIds(node: unknown, ids: Map<string, string>, columns: readonly TableColumn[] = []): unknown {
  if (typeof node !== 'object' || node === null) return node;
  const value = node as { kind: string; columnId?: string; args?: unknown[]; type?: string; value?: unknown };
  if (value.kind === 'ref') return { ...value, columnId: ids.get(value.columnId!) ?? value.columnId };
  if (value.kind !== 'call') return node;
  const args = value.args!;
  // Opções declaradas das colunas de seleção referidas diretamente nesta chamada.
  const options = new Set(args.flatMap((arg) => {
    const ref = arg as { kind?: string; columnId?: string };
    const column = ref.kind === 'ref' ? columns.find((candidate) => candidate.id === ref.columnId) : undefined;
    return column && (column.type === 'select' || column.type === 'multiselect') ? column.options.map((option) => option.id) : [];
  }));
  return { ...value, args: args.map((child) => {
    const literal = child as { kind?: string; type?: string; value?: unknown };
    if (literal.kind === 'literal' && literal.type === 'text' && typeof literal.value === 'string' && options.has(literal.value)) return { ...literal, value: ids.get(literal.value) ?? literal.value };
    return formulaIds(child, ids, columns);
  }) };
}
/** Um binding mapeia somente tabelas; colunas/opções são reconciliadas de modo não ambíguo pelo schema completo. */
function columnBindings(source: SourceTable, target: DataTable, seed: string): Map<string, string> {
  if (!unique(target.columns.map((column) => column.name.toLocaleLowerCase('pt-BR')))) throw new DomainError('TABLE_IMPORT_BINDING');
  for (const column of target.columns) if ((column.type === 'select' || column.type === 'multiselect') && !unique(column.options.map((option) => option.label.toLocaleLowerCase('pt-BR')))) throw new DomainError('TABLE_IMPORT_BINDING');
  const ids = new Map<string, string>();
  for (const column of source.columns) {
    const actual = target.columns.find((item) => item.name === column.name);
    if (actual && actual.type !== column.type) throw new DomainError('TABLE_IMPORT_BINDING');
    ids.set(column.id, actual?.id ?? derivedId(`${seed}:${column.id}`));
    if (column.type === 'select' || column.type === 'multiselect') for (const option of column.options) {
      const existing = actual?.type === column.type ? actual.options.find((item) => item.label === option.label) : undefined;
      ids.set(option.id, existing?.id ?? derivedId(`${seed}:${option.id}`));
    }
  }
  return ids;
}
/** Definição de coluna completa, inclusive opções e fórmula, preserva tudo que não é referência. */
function mappedColumns(source: SourceTable, ids: Map<string, string>, tables: Map<string, string>): TableColumnInput[] {
  return source.columns.map((column) => {
    if (column.type === 'select' || column.type === 'multiselect') return { ...column, id: ids.get(column.id)!, options: column.options.map((option) => ({ ...option, id: ids.get(option.id)! })) };
    if (column.type === 'relation') { const targetTableId = tables.get(column.targetTableId); if (!targetTableId) throw new DomainError('TABLE_IMPORT_BINDING'); return { ...column, id: ids.get(column.id)!, targetTableId }; }
    if (column.type === 'calculated') return { ...column, id: ids.get(column.id)!, formula: formulaIds(column.formula, ids, source.columns) as typeof column.formula };
    return { ...column, id: ids.get(column.id)! };
  });
}
/** Seleções aceitam ID de origem ou rótulo; ambos devem corresponder exatamente a uma opção declarada. */
function optionValue(column: TableColumn, value: TableCell, ids: Map<string, string>): TableCell {
  if (value === null) return null;
  if (column.type !== 'select' && column.type !== 'multiselect') return value;
  const map = (entry: string): string => { const options = column.options.filter((candidate) => candidate.id === entry || candidate.label === entry); if (options.length !== 1) throw new DomainError('TABLE_IMPORT_INVALID'); return ids.get(options[0]!.id)!; };
  if (column.type === 'select' && typeof value === 'string') return map(value);
  if (column.type === 'multiselect' && Array.isArray(value)) return value.map(map);
  throw new DomainError('TABLE_IMPORT_INVALID');
}
/** Vistas remapeiam projeção/ordem/filtros declarados; literais de texto não são remapeados globalmente. */
function mappedView(view: Omit<TableViewCreate, 'operationId'>, source: SourceTable, ids: Map<string, string>, recordId: (tableId: string, id: string) => string): Omit<TableViewCreate, 'operationId'> {
  const filter = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node;
    const item = node as { filters?: unknown[]; columnId?: string; value?: TableCell };
    if (item.filters) return { ...item, filters: item.filters.map(filter) };
    const column = source.columns.find((candidate) => candidate.id === item.columnId);
    let value = item.value;
    if (column && 'value' in item) {
      if ((column.type === 'select' || column.type === 'multiselect') && typeof value === 'string') {
        const options = column.options.filter((candidate) => candidate.id === value || candidate.label === value);
        if (options.length !== 1) throw new DomainError('TABLE_IMPORT_INVALID');
        value = ids.get(options[0]!.id)!;
      } else if (column.type === 'relation') {
        if (typeof value === 'string') value = recordId(column.targetTableId, value);
        else if (Array.isArray(value)) value = value.map((id) => recordId(column.targetTableId, id));
      } else value = optionValue(column, value!, ids);
    }
    return { ...item, ...(item.columnId ? { columnId: ids.get(item.columnId)! } : {}), ...('value' in item ? { value } : {}) };
  };
  return { ...view, ...(view.columns ? { columns: view.columns.map((id) => ids.get(id)!) } : {}), ...(view.sort ? { sort: view.sort.map((sort) => ({ ...sort, columnId: ids.get(sort.columnId)! })) } : {}), ...(view.filter ? { filter: filter(view.filter) as typeof view.filter } : {}) };
}
/** Compara conjuntos de relações sem mascarar duplicatas; ordem da lista não altera o vínculo. */
function sameCell(column: TableColumn, left: TableCell, right: TableCell): boolean {
  if (column.type === 'relation' && Array.isArray(left) && Array.isArray(right)) return unique(left) && unique(right) && isDeepStrictEqual([...left].sort(), [...right].sort());
  return isDeepStrictEqual(left, right);
}
/** Único dispatcher: phases são explícitas, cada mutação mantém recibos/revisões/lease do serviço existente. */
export async function importAttachment(input: TableImportToolInput, context: ToolContext): Promise<unknown> {
  if (!context.botId) throw new DomainError('TABLE_ACCESS_DENIED');
  const source = await readSource(context, input.attachmentId);
  const evidence = await attachmentEvidence(context.pool, context.conversationId, context.botId, [input.attachmentId]);
  if (!evidence) throw new DomainError('ATTACHMENT_NOT_FOUND');
  context.captureEvidence?.(evidence);
  await context.recordEvidence?.(evidence);
  if (input.operation === 'inspect') return { sourceHash: source.hash, tables: source.tables.map((table) => ({ sourceTableId: table.originId, name: table.name, records: table.records.length, columns: table.columns.length, columnTypes: table.columns.reduce<Record<string, number>>((counts, column) => ({ ...counts, [column.type]: (counts[column.type] ?? 0) + 1 }), {}), formulas: table.columns.filter((column) => column.type === 'calculated').length, views: table.views.length })), phases: ['create', 'schema', 'records', 'relations', 'view', 'verify'] };
  if (source.hash !== input.sourceHash) throw new DomainError('TABLE_IMPORT_SOURCE_CHANGED');
  if (!unique(input.bindings.map((binding) => binding.sourceTableId)) || !unique(input.bindings.map((binding) => binding.tableId))) throw new DomainError('TABLE_IMPORT_BINDING');
  const service = new TableService({ pool: context.pool, now: context.now, onEvidence: context.captureEvidence, execution: { runId: context.runId, signal: context.signal, leaseOwner: context.leaseOwner } });
  /** Namespace de IDs gerado internamente: novas colunas continuam sem id no contrato público. */
  const structureService = (table: SourceTable, ids: Map<string, string>) => new TableService({ pool: context.pool, now: context.now, onEvidence: context.captureEvidence, execution: { runId: context.runId, signal: context.signal, leaseOwner: context.leaseOwner }, importColumnIds: new Map(table.columns.map((column) => [column.name, ids.get(column.id)!])) });
  const actor: TableActor = { kind: 'bot', botId: context.botId };
  const bindings = new Map(input.bindings.map((binding) => [binding.sourceTableId, binding.tableId]));
  const targets = new Map<string, DataTable>();
  for (const binding of input.bindings) { if (!source.tables.some((table) => table.originId === binding.sourceTableId)) throw new DomainError('TABLE_IMPORT_BINDING'); targets.set(binding.sourceTableId, await service.get(binding.tableId, actor)); }
  const snapshot = new Map<string, Awaited<ReturnType<TableService['importSnapshot']>>>();
  for (const [id, target] of targets) snapshot.set(id, await service.importSnapshot(target.id, actor));
  /** Referências de registros são resolvidas pela dedup persistida, nunca por nome ou ordem dos registros. */
  const recordId = (tableId: string, id: string): string => { const found = snapshot.get(tableId)?.deduplication.find((item) => item.key === id); if (!found) throw new DomainError('TABLE_IMPORT_BINDING'); return found.recordId; };
  /** A comparação trata referência ausente como divergência; uma escrita exige todos os destinos existentes. */
  const cell = (column: TableColumn, value: TableCell, ids: Map<string, string>): TableCell => column.type === 'relation' && typeof value === 'string' ? recordId(column.targetTableId, value) : column.type === 'relation' && Array.isArray(value) ? value.map((id) => recordId(column.targetTableId, id)) : optionValue(column, value, ids);
  const values = (table: SourceTable, record: SourceRecord, ids: Map<string, string>, relations: boolean): Record<string, TableCell> => Object.fromEntries(table.columns.filter((column) => column.type !== 'calculated' && (relations ? column.type === 'relation' : column.type !== 'relation')).map((column) => [ids.get(column.id)!, cell(column, record.values[column.id]!, ids)]));
  if (input.operation === 'verify') {
    const checks = [];
    for (const table of source.tables) {
      const target = targets.get(table.originId); if (!target) throw new DomainError('TABLE_IMPORT_BINDING');
      const ids = columnBindings(table, target, `${source.hash}:${target.id}`), records = snapshot.get(table.originId)!;
      let missing = 0, differentCells = 0;
      for (const record of table.records) {
        const dedup = records.deduplication.find((item) => item.key === record.id), actual = records.records.find((item) => item.id === dedup?.recordId);
        if (!actual) { missing++; continue; }
        for (const column of table.columns.filter((item) => item.type !== 'calculated')) {
          try { if (!Object.hasOwn(actual.values, ids.get(column.id)!) || !sameCell(column, cell(column, record.values[column.id]!, ids), actual.values[ids.get(column.id)!]!)) differentCells++; }
          catch (error) { if (error instanceof DomainError && error.code === 'TABLE_IMPORT_BINDING') differentCells++; else throw error; }
        }
      }
      const expectedColumns = mappedColumns(table, ids, bindings);
      const actualViews = (await service.views(target.id, actor)).views.map(({ id: _id, version: _version, ...view }) => view);
      let expectedViews: Omit<TableViewCreate, 'operationId'>[] | null;
      try { expectedViews = table.views.map((view) => mappedView(view, table, ids, recordId)); }
      catch (error) { if (error instanceof DomainError && error.code === 'TABLE_IMPORT_BINDING') expectedViews = null; else throw error; }
      const extra = records.records.length - (table.records.length - missing);
      const schemaExact = target.name === table.name && target.description === table.description && isDeepStrictEqual(target.columns, expectedColumns);
      const viewsExact = expectedViews !== null && actualViews.length === expectedViews.length && expectedViews.every((view) => actualViews.some((actual) => isDeepStrictEqual(actual, view)));
      checks.push({ sourceTableId: table.originId, expected: table.records.length, actual: records.records.length, missing, extra, differentCells, schemaExact, viewsExact });
    }
    // Uma edição concorrente durante a comparação invalida a prova em vez de certificar um snapshot misturado.
    for (const target of targets.values()) if ((await service.get(target.id, actor)).version !== target.version) throw new DomainError('TABLE_CONFLICT');
    return { sourceHash: source.hash, passed: checks.every((check) => check.missing === 0 && check.extra === 0 && check.differentCells === 0 && check.schemaExact && check.viewsExact), tables: checks };
  }
  /** Revalida fonte e parada antes de cada efeito; o serviço revalida posse/acesso também dentro do commit. */
  const beforeEffect = async () => { if (context.signal.aborted) throw new DomainError('TABLE_CONFLICT'); if ((await readSource(context, input.attachmentId)).hash !== source.hash) throw new DomainError('TABLE_IMPORT_SOURCE_CHANGED'); };
  /** Mesma operação individual para chamadas antigas e sublotes de uma fase global. */
  const applyTable = async (input: ApplyInput, dryRun = false): Promise<Applied> => {
  const table = source.tables.find((item) => item.originId === input.sourceTableId); if (!table) throw new DomainError('TABLE_IMPORT_BINDING');
  const target = targets.get(table.originId);
  if (input.phase === 'create') {
    if (target) return { tableId: target.id, schemaVersion: target.schemaVersion, skipped: true };
    const ids = new Map<string, string>(); for (const column of table.columns) { ids.set(column.id, derivedId(`${input.operationId}:${column.id}`)); if (column.type === 'select' || column.type === 'multiselect') for (const option of column.options) ids.set(option.id, derivedId(`${input.operationId}:${option.id}`)); }
    const columns = mappedColumns({ ...table, columns: table.columns.filter((column) => !['relation', 'calculated'].includes(column.type)) }, ids, bindings).map(({ id: _id, ...column }) => column);
    await beforeEffect();
    const created = await structureService(table, ids).create({ name: table.name, description: table.description, columns, operationId: input.operationId }, actor);
    return { tableId: created.id, schemaVersion: created.schemaVersion };
  }
  if (!target) throw new DomainError('TABLE_IMPORT_BINDING');
  /** Recibos/skip permitem retomar partes corretas com revisão anterior; qualquer NOVO efeito exige a revisão atual. */
  const assertRevision = () => { if (input.expectedSchemaVersion === undefined || target.schemaVersion !== input.expectedSchemaVersion) throw new DomainError('TABLE_CONFLICT'); };
  const ids = columnBindings(table, target, `${source.hash}:${target.id}`);
  if (input.phase === 'schema') {
    const columns = mappedColumns(table, ids, bindings);
    if (isDeepStrictEqual(target.columns, columns) && target.name === table.name && target.description === table.description) return { tableId: target.id, schemaVersion: target.schemaVersion, skipped: true };
    assertRevision();
    const inputColumns = columns.map((column) => { if (target.columns.some((existing) => existing.id === column.id)) return column; const { id: _id, ...newColumn } = column; return newColumn; });
    await beforeEffect();
    const updated = await structureService(table, ids).update(target.id, { columns: inputColumns, name: table.name, description: table.description, operationId: input.operationId, expectedSchemaVersion: input.expectedSchemaVersion! }, actor);
    return { tableId: updated.id, schemaVersion: updated.schemaVersion };
  }
  if (!isDeepStrictEqual(target.columns, mappedColumns(table, ids, bindings))) throw new DomainError('TABLE_IMPORT_BINDING');
  if (input.phase === 'view') {
    const sourceView = table.views[input.offset]; if (!sourceView) throw new DomainError('TABLE_IMPORT_INVALID');
    const nextOffset = input.offset + 1 < table.views.length ? input.offset + 1 : null;
    const view = mappedView(sourceView, table, ids, recordId), existing = (await service.views(target.id, actor)).views.filter((item) => item.name === view.name);
    if (existing.length > 1) throw new DomainError('TABLE_IMPORT_BINDING');
    const actual = existing[0];
    if (actual) { const { id: _id, version: _version, ...definition } = actual; if (isDeepStrictEqual(definition, view)) return { skipped: true, nextOffset }; throw new DomainError('TABLE_IMPORT_BINDING'); }
    assertRevision(); await beforeEffect();
    const saved = await service.saveView(target.id, { ...view, operationId: input.operationId }, actor);
    return { viewId: saved.id, nextOffset };
  }
  const records = table.records.slice(input.offset, input.offset + input.limit); if (!records.length) throw new DomainError('TABLE_IMPORT_INVALID');
  const current = snapshot.get(table.originId)!;
  const creates = [], updates = []; let skipped = 0;
  for (const record of records) {
    const patch = values(table, record, ids, input.phase === 'relations');
    const found = current.deduplication.find((item) => item.key === record.id), actual = current.records.find((item) => item.id === found?.recordId);
    if (actual) {
      if (Object.entries(patch).every(([id, value]) => Object.hasOwn(actual.values, id) && sameCell(table.columns.find((column) => ids.get(column.id) === id)!, value, actual.values[id]!))) { skipped++; continue; }
      if (input.phase !== 'relations') throw new DomainError('TABLE_IMPORT_BINDING');
      updates.push({ id: actual.id, expectedVersion: actual.version, values: patch });
    } else if (input.phase === 'records') creates.push({ deduplicationKey: record.id, values: patch });
    else throw new DomainError('TABLE_IMPORT_BINDING');
  }
  const write = { operationId: input.operationId, expectedSchemaVersion: input.expectedSchemaVersion!, creates, updates };
  if (Buffer.byteLength(JSON.stringify(write), 'utf8') > TABLE_BODY_LIMIT) throw new DomainError('PAYLOAD_TOO_LARGE');
  if (creates.length + updates.length) { assertRevision(); if (dryRun) return { plannedWrite: write }; await beforeEffect(); await service.write(target.id, write, actor); }
  return { applied: creates.length + updates.length, skipped, nextOffset: input.offset + records.length < table.records.length ? input.offset + records.length : null, sourceHash: source.hash };
  };
  if (input.sourceTableId !== undefined) return applyTable(input);

  // Fase global com cursor único: até 100 itens somados. Atomicidade é da suboperação existente: lote/estrutura por tabela, vista individual.
  const itemCount = (table: SourceTable): number => input.phase === 'view' ? table.views.length : ['records', 'relations'].includes(input.phase) ? table.records.length : 1;
  const total = source.tables.reduce((sum, table) => sum + itemCount(table), 0);
  if (input.offset > total) throw new DomainError('TABLE_IMPORT_INVALID');
  const jobs: { input: ApplyInput; count: number }[] = []; let start = 0, remaining = input.limit;
  for (const table of source.tables) {
    const count = itemCount(table), offset = Math.max(0, input.offset - start);
    if (input.offset < start + count && remaining > 0) {
      const take = Math.min(remaining, count - offset), binding = input.bindings.find((item) => item.sourceTableId === table.originId);
      const revision = binding?.expectedSchemaVersion ?? input.expectedSchemaVersion;
      if (input.phase === 'view') for (let index = offset; index < offset + take; index++) jobs.push({ input: { ...input, sourceTableId: table.originId, offset: index, limit: 1, expectedSchemaVersion: revision, operationId: derivedId(`${input.operationId}:${source.hash}:${input.phase}:${table.originId}:${index}`) }, count: 1 });
      else jobs.push({ input: { ...input, sourceTableId: table.originId, offset: ['create', 'schema'].includes(input.phase) ? 0 : offset, limit: take, expectedSchemaVersion: revision, operationId: derivedId(`${input.operationId}:${source.hash}:${input.phase}:${table.originId}:${offset}`) }, count: take });
      remaining -= take;
    }
    start += count;
  }
  if (input.phase === 'records' || input.phase === 'relations') {
    const planned = []; for (const job of jobs) { const result = await applyTable(job.input, true); if (result.plannedWrite) planned.push(result.plannedWrite); }
    // Todos os sublotes são planejados antes do primeiro commit: expansão de matrizes/IDs não pode exceder 1 MiB no grupo.
    if (Buffer.byteLength(JSON.stringify(planned), 'utf8') > TABLE_BODY_LIMIT) throw new DomainError('PAYLOAD_TOO_LARGE');
  }
  let applied = 0, skipped = 0, processed = 0;
  for (const job of jobs) {
    try {
      const result = await applyTable(job.input);
      if (result.tableId) { const target = await service.get(result.tableId, actor); targets.set(job.input.sourceTableId!, target); bindings.set(job.input.sourceTableId!, target.id); }
      applied += result.applied ?? (result.skipped ? 0 : job.count);
      skipped += typeof result.skipped === 'number' ? result.skipped : result.skipped ? job.count : 0;
      processed += job.count;
    } catch (error) { if (processed > 0) throw new DomainError('TABLE_IMPORT_PARTIAL', { cause: error }); throw error; }
  }
  const updatedBindings = [];
  for (const [sourceTableId, tableId] of bindings) updatedBindings.push({ sourceTableId, tableId, expectedSchemaVersion: (await service.get(tableId, actor)).schemaVersion });
  return { sourceHash: source.hash, applied, skipped, processed, nextOffset: input.offset + processed < total ? input.offset + processed : null, bindings: updatedBindings, atomicity: 'per-operation' };
}
