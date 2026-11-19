// Fonte única de autorização, revisão, cotas e escrita das tabelas. API/ferramentas só fornecem entrada validada.
// Actor é contexto interno confiável: a borda HTTP usa owner; as ferramentas `table_*` (`runs/table-tools.ts`) derivam o bot da execução, nunca dos argumentos do modelo.
import { createHash, randomUUID } from 'node:crypto';
import { tableDependenciesRequestSchema, type TableDependenciesRequest, type TableDependencies, type TableDependency, tableDestructiveSchema, tableConfirmSchema, tableRecordLookupSchema, type TableRecordLookup, type TableDestructive, type TableImpact, type TablePreparation, type TableConfirm, TABLE_BODY_LIMIT, TABLE_LIMITS, tableCreateSchema, tableIdSchema, tableUpdateSchema, tableWriteSchema, tableShareSchema, tableQuerySchema, tableViewCreateSchema, tableViewUpdateSchema, tableViewRemoveSchema, tableFormulaPreviewSchema, type DataTable, type TableCell, type TableColumn, type TableColumnInput, type TableCreate, type TableRecord, type TableShare, type TableUpdate, type TableWrite, type TableQuery, type TableQueryResult, type TableView, type TableViewCreate, type TableViewUpdate } from '@aion/shared';
import { recordAudit } from '../audit';
import { withTransaction, type Pool, type PoolClient, type Queryable } from '../db/pool';
import { DomainError } from '../errors';
import { validateScalar } from './scalars';
import { compileFormulas, evaluateFormulas, queryWithin } from './formulas';
import { canonicalJSON, executeQuery, queryColumns, validateQuery } from './queries';
import { cellDisplay, clipUnits } from './model-format';
import { isFullRecordId, isRecordRef, normalizeRecordRef, RECORD_ID_CHARS, resolveRecordRefs } from './record-prefix';
import { readAppSettings } from '../settings/service';
import { formatCivilDate } from '../routines/civil-date';
import { localDateOf } from '../routines/zoned-time';
import { requireApprovalProof, type ApprovalProof } from '../approvals/proof';
import { TABLE_ACTIONS } from './actions';
import type { EvidenceProvenance } from '../runs/evidence-provenance';


export type TableActor = { kind: 'owner' } | { kind: 'bot'; botId: string } | { kind: 'chat' };
export interface TableOrigin { ip?: string; userAgent?: string }
interface TableRow { id: string; name: string; description: string; version: number; schema_version: number; access_version: number }
interface RecordRow { id: string; version: number; values: Record<string, TableCell> }
const TABLE_FIELDS = 'id, name, description, version, schema_version, access_version';
/** Serialização única para cotas globais e mutações que atravessam tabelas, inclusive exclusão de bots.
 * ponytail: lock global adequado ao dono único, trocar por trava de cota e locks por tabela se escritas concorrentes causarem espera relevante.
 */
export const TABLE_MUTATION_LOCK = 7_265_341_030;

/** Hash estável de JSON: ordem das propriedades não torna replay/deduplicação incompatível. */
const canonical = canonicalJSON;
/** O recibo guarda somente hash da entrada; nenhum nome ou célula vai à auditoria. */
const hashOf = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
/** Identidade de recibo não aponta por FK ao bot, para sobreviver à exclusão dele. */
const actorKey = (actor: TableActor): string => actor.kind === 'bot' ? `bot:${actor.botId}` : actor.kind;
/** Textos de uma célula (valor único ou lista), na ordem; nulo, booleano e item que não é texto não têm id a resolver. Serve às células de relação (`resolveRelationRefs`). */
const cellTexts = (cell: unknown): string[] => typeof cell === 'string' ? [cell] : Array.isArray(cell) ? cell.filter((item): item is string => typeof item === 'string') : [];
/** A célula de relação com cada id curto trocado pelo UUID completo de `resolved` (chave: prefixo normalizado); UUID completo e o que não está no mapa ficam como vieram. */
const withResolvedIds = (cell: TableCell, resolved: ReadonlyMap<string, string> | undefined): TableCell => {
  if (!resolved) return cell;
  const swap = (text: string): string => resolved.get(normalizeRecordRef(text)) ?? text;
  return typeof cell === 'string' ? swap(cell) : Array.isArray(cell) ? cell.map(swap) : cell;
};
/** Deadline único também cobre metadata, autorização, locks e auditoria, além do cálculo vetorizado. */
function deadlineClient(tx: PoolClient, deadline: number): PoolClient {
  return new Proxy(tx, {
    /** A conexão original configura o tempo restante antes de cada statement, sem criar recursão no proxy. */
    get(target, property) {
      if (property !== 'query') return Reflect.get(target, property, target);
      return async (sql: string, params?: unknown[]) => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new DomainError('SERVICE_UNAVAILABLE');
        await target.query('SELECT set_config(\'statement_timeout\', $1, true)', [`${Math.max(1, Math.floor(remaining))}ms`]);
        return target.query(sql, params);
      };
    },
  });
}
/** Valida também o caller interno, incluindo o teto que HTTP aplica antes da desserialização. */
function parseInput<T>(schema: { safeParse: (input: unknown) => { success: boolean; data?: T } }, input: unknown): T {
  if (Buffer.byteLength(JSON.stringify(input)) > TABLE_BODY_LIMIT) throw new DomainError('PAYLOAD_TOO_LARGE');
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  return parsed.data as T;
}

export class TableService {
  /** Injeta apenas o pool; estado e autorização permanecem no banco, comuns à API e ao worker. */
  constructor(private readonly options: { pool: Pool; now?: () => Date; execution?: { runId: string; signal: AbortSignal; leaseOwner?: string }; /** Metadata capturada no mesmo snapshot autorizado; nunca entra no envelope público. */ onEvidence?: (evidence: EvidenceProvenance) => void; /** Apenas o importador interno gera este namespace; nunca é campo de entrada HTTP/ferramenta. */ importColumnIds?: ReadonlyMap<string, string> }) {}

  /** Resolve alvos/impacto no servidor, sem guardar células ou conceder acesso. A revisão total invalida qualquer alteração posterior. */
  async prepareDestructive(tableId: string, raw: TableDestructive, actor: TableActor): Promise<TablePreparation> {
    const input = parseInput<TableDestructive>(tableDestructiveSchema, raw);
    const deadline = performance.now() + 5000;
    return withTransaction(this.options.pool, async (tx) => {
      tx = deadlineClient(tx, deadline);
      await tx.query('SELECT pg_advisory_xact_lock($1)', [TABLE_MUTATION_LOCK]);
      const impact = await this.destructiveImpact(tx, tableId, input, actor, deadline);
      const existing = (await tx.query<{ id: string }>('SELECT id FROM table_operation_preparations WHERE actor = $1 AND table_id = $2 AND definition = $3::jsonb', [actorKey(actor), tableId, JSON.stringify(input)])).rows[0];
      if (existing) return { preparationId: existing.id, impact };
      const preparationId = randomUUID();
      await tx.query('INSERT INTO table_operation_preparations (id, actor, table_id, definition, impact) VALUES ($1,$2,$3,$4,$5)', [preparationId, actorKey(actor), tableId, JSON.stringify(input), JSON.stringify(impact)]);
      return { preparationId, impact };
    });
  }

  /** Somente a preparação do mesmo ator/tabela serve ao cartão e à confirmação; campos de impacto enviados pelo caller não são aceitos. */
  async preparedOperation(tableId: string, preparationId: string, actor: TableActor): Promise<TablePreparation> {
    return this.read(async (tx, deadline) => {
      await this.authorize(tx, tableId, actor);
      const row = await this.preparationIn(tx, tableId, preparationId, actor);
      return { preparationId, impact: await this.destructiveImpact(tx, tableId, row.definition, actor, deadline) };
    });
  }

  /** Confirmação direta exige owner; ferramenta exige prova emitida pelo executor para a categoria preparada. Efeito e recibo são atômicos. */
  async confirmDestructive(tableId: string, raw: TableConfirm, actor: TableActor, proof?: ApprovalProof, origin: TableOrigin = {}): Promise<{ removed?: true; tableId: string; kind: TableDestructive['kind'] }> {
    const input = parseInput<TableConfirm>(tableConfirmSchema, raw);
    return this.mutate(actor, input.operationId, 'table.destructive', input, tableId, origin, async (tx, deadline) => {
      const prepared = await this.preparationIn(tx, tableId, input.preparationId, actor);
      if (actor.kind === 'bot') {
        try { requireApprovalProof(proof, TABLE_ACTIONS[prepared.definition.kind].slug); }
        catch { throw new DomainError('APPROVAL_REQUIRED'); }
      }
      await this.destructiveImpact(tx, tableId, prepared.definition, actor, deadline);
      const operation = prepared.definition;
      if (operation.kind === 'delete_table') {
        // Só vínculos originados na própria tabela são removidos; qualquer referência externa já bloqueou a operação.
        await tx.query('DELETE FROM table_links WHERE table_id = $1', [tableId]);
        await tx.query('DELETE FROM table_columns WHERE table_id = $1', [tableId]);
        await tx.query('DELETE FROM data_tables WHERE id = $1', [tableId]);
      } else if (operation.kind === 'delete_records') {
        const ids = operation.records.map((row) => row.id);
        await tx.query('DELETE FROM table_links WHERE table_id = $1 AND record_id = ANY($2::uuid[])', [tableId, ids]);
        await tx.query('DELETE FROM table_records WHERE table_id = $1 AND id = ANY($2::uuid[])', [tableId, ids]);
        await this.bump(tx, tableId);
      } else {
        const columnId = operation.kind === 'delete_column' ? operation.columnId : operation.column.id!;
        if (operation.kind === 'delete_column') {
          await tx.query('DELETE FROM table_links WHERE table_id = $1 AND column_id = $2', [tableId, columnId]);
          await tx.query('UPDATE table_records SET values = values - $2::text, version = version + 1 WHERE table_id = $1 AND values ? $2', [tableId, columnId]);
          await tx.query('DELETE FROM table_columns WHERE table_id = $1 AND id = $2', [tableId, columnId]);
        } else {
          // Materializa somente a coluna convertida. Formas one/many preservam os mesmos IDs, sem coerção de escalares.
          const current = await this.authorize(tx, tableId, actor);
          const columns = (await this.hydrateMany(tx, [current], { kind: 'owner' }))[0]!.columns;
          const previous = columns.find((column) => column.id === columnId)!;
          const rows = (await tx.query<RecordRow>('SELECT id, version, values FROM table_records WHERE table_id = $1', [tableId])).rows;
          const projected = await this.projectRecords(tx, tableId, rows, columns, deadline);
          const values = projected.map((row) => ({ id: row.id, value: this.conversionValue(previous, operation.column as TableColumn, row.values[columnId] ?? null) }));
          await tx.query('DELETE FROM table_links WHERE table_id = $1 AND column_id = $2', [tableId, columnId]);
          await tx.query('UPDATE table_columns SET definition = $3, target_table_id = $4 WHERE table_id = $1 AND id = $2', [tableId, columnId, JSON.stringify(operation.column), operation.column.type === 'relation' ? operation.column.targetTableId : null]);
          if (operation.column.type === 'relation' || operation.column.type === 'calculated') {
            await tx.query('UPDATE table_records SET values = values - $2::text, version = version + 1 WHERE table_id = $1', [tableId, columnId]);
            if (operation.column.type === 'relation') {
              const links = values.flatMap((row) => row.value == null ? [] : (typeof row.value === 'string' ? [row.value] : row.value as string[]).map((targetId) => ({ record_id: row.id, target_record_id: targetId })));
              if (links.length) await tx.query('INSERT INTO table_links (table_id, record_id, column_id, target_table_id, target_record_id) SELECT $1, x.record_id, $2, $3, x.target_record_id FROM jsonb_to_recordset($4::jsonb) x(record_id uuid, target_record_id uuid)', [tableId, columnId, operation.column.targetTableId, JSON.stringify(links)]);
            }
          } else {
            await tx.query('UPDATE table_records r SET values = jsonb_set(r.values, ARRAY[$2::text], x.value), version = version + 1 FROM jsonb_to_recordset($3::jsonb) x(id uuid, value jsonb) WHERE r.table_id = $1 AND r.id = x.id', [tableId, columnId, JSON.stringify(values)]);
          }
        }
        await tx.query('UPDATE data_tables SET schema_version = schema_version + 1 WHERE id = $1', [tableId]);
        await this.bump(tx, tableId);
      }
      // Snapshots de células não sobrevivem à exclusão. Identidade/hash permanecem e impedem replay de recriar dados.
      if (operation.kind === 'delete_table') await tx.query("UPDATE table_mutation_receipts SET result = '{\"resourceRemoved\":true}'::jsonb WHERE table_id = $1", [tableId]);
      else if (operation.kind === 'delete_records') await tx.query("UPDATE table_mutation_receipts r SET result = '{\"resourceRemoved\":true}'::jsonb WHERE table_id = $1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r.result->'records','[]'::jsonb)) item WHERE item->>'id' = ANY($2::text[]))", [tableId, operation.records.map((row) => row.id)]);
      else if (operation.kind === 'delete_column') await tx.query("UPDATE table_mutation_receipts r SET result = '{\"resourceRemoved\":true}'::jsonb WHERE table_id = $1 AND (EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r.result->'records','[]'::jsonb)) item WHERE (item->'values') ? $2) OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r.result->'columns','[]'::jsonb)) item WHERE item->>'id' = $2))", [tableId, operation.columnId]);
      return { ...(operation.kind === 'convert_column' ? {} : { removed: true as const }), tableId, kind: operation.kind };
    });
  }

  /** Carrega preparação por identidade do ator; bot não pode usar preparação do dono ou de outro bot. */
  private async preparationIn(tx: Queryable, tableId: string, id: string, actor: TableActor): Promise<{ definition: TableDestructive; impact: TableImpact }> {
    if (!tableIdSchema.safeParse(id).success) throw new DomainError('VALIDATION_FAILED');
    const row = (await tx.query<{ definition: TableDestructive; impact: TableImpact }>('SELECT definition, impact FROM table_operation_preparations WHERE id = $1 AND table_id = $2 AND actor = $3', [id, tableId, actorKey(actor)])).rows[0];
    if (!row) throw new DomainError('TABLE_NOT_FOUND');
    return row;
  }

  /** Leitura exclusiva do dono: o mesmo portão fornece impedimentos, paginados, sem valores ou autoridade para confirmar. */
  async dependencies(tableId: string, raw: Partial<TableDependenciesRequest>, actor: TableActor): Promise<TableDependencies> {
    if (actor.kind !== 'owner') throw new DomainError('TABLE_ACCESS_DENIED');
    const input = parseInput<TableDependenciesRequest>(tableDependenciesRequestSchema, raw);
    return this.read(async (tx) => {
      const current = await this.authorize(tx, tableId, actor);
      if (current.version !== input.operation.expectedVersion) throw new DomainError('TABLE_CONFLICT');
      const table = (await this.hydrateMany(tx, [current], actor))[0]!;
      const dependencies = await this.blockingDependencies(tx, table, input.operation);
      const cursor = input.cursor ?? 0; let end = Math.min(dependencies.length, cursor + input.limit);
      while (end > cursor && Buffer.byteLength(JSON.stringify({ dependencies: dependencies.slice(cursor, end), nextCursor: dependencies.length > end ? end : null }), 'utf8') > 64 * 1024) end--;
      return { dependencies: dependencies.slice(cursor, end), nextCursor: dependencies.length > end ? end : null };
    });
  }

  /** Fonte única dos impedimentos do preparo/commit e da apresentação do dono. Não inclui células nem consulta registros em lote. */
  private async blockingDependencies(tx: Queryable, table: DataTable, input: TableDestructive): Promise<TableDependency[]> {
    if (input.kind === 'delete_table' || input.kind === 'delete_records') {
      const rows = input.kind === 'delete_table'
        ? await tx.query<{ table_id: string; table_name: string; name: string }>("SELECT c.table_id, t.name AS table_name, c.definition->>'name' AS name FROM table_columns c JOIN data_tables t ON t.id = c.table_id WHERE c.target_table_id = $1 AND c.table_id <> $1 ORDER BY c.table_id, c.id", [table.id])
        : await tx.query<{ table_id: string; table_name: string; name: string }>("SELECT DISTINCT c.table_id, t.name AS table_name, c.definition->>'name' AS name FROM table_links l JOIN table_columns c ON c.table_id = l.table_id AND c.id = l.column_id JOIN data_tables t ON t.id = c.table_id WHERE l.target_table_id = $1 AND l.target_record_id = ANY($2::uuid[]) AND NOT (l.table_id = $1 AND l.record_id = ANY($2::uuid[])) ORDER BY c.table_id, table_name, name", [table.id, input.records.map((row) => row.id)]);
      return rows.rows.map((row) => ({ kind: 'relation', tableId: row.table_id, tableName: row.table_name, name: row.name }));
    }
    const columnId = input.kind === 'delete_column' ? input.columnId : input.column.id!;
    if (!table.columns.some((column) => column.id === columnId)) throw new DomainError('TABLE_ACCESS_DENIED');
    const plan = compileFormulas(table.columns);
    const dependencies: TableDependency[] = table.columns.filter((column) => column.id !== columnId && column.type === 'calculated' && plan.dependencies([column.id]).has(columnId)).map((column) => ({ kind: 'formula', tableId: table.id, tableName: table.name, name: column.name }));
    const next = input.kind === 'delete_column' ? table.columns.filter((column) => column.id !== columnId) : table.columns.map((column) => column.id === columnId ? input.column as TableColumn : column);
    if (dependencies.length === 0) compileFormulas(next);
    const views = (await tx.query<{ name: string; definition: TableView }>('SELECT name, definition FROM table_views WHERE table_id = $1 ORDER BY id', [table.id])).rows;
    for (const view of views) {
      try { validateQuery(view.definition, next, next); }
      catch { dependencies.push({ kind: 'view', tableId: table.id, tableName: table.name, name: view.name }); }
    }
    return dependencies;
  }

  /** Dependências e validade são a mesma regra em preparação e commit; não há cascata em recursos alheios. */
  private async destructiveImpact(tx: PoolClient, tableId: string, input: TableDestructive, actor: TableActor, deadline: number): Promise<TableImpact> {
    const current = await this.authorize(tx, tableId, actor);
    if (current.version !== input.expectedVersion) throw new DomainError('TABLE_CONFLICT');
    const table = (await this.hydrateMany(tx, [current], { kind: 'owner' }))[0]!;
    const recordCount = Number((await tx.query<{ count: string }>('SELECT count(*) FROM table_records WHERE table_id = $1', [tableId])).rows[0]!.count);
    const impact: TableImpact = { kind: input.kind, tableId, tableName: table.name, expectedVersion: current.version, recordCount };
    if ((await this.blockingDependencies(tx, table, input)).length) throw new DomainError('TABLE_DEPENDENCY');
    if (input.kind === 'delete_table') {
      await this.authorizeTargets(tx, table.columns.flatMap((column) => column.type === 'relation' ? [column.targetTableId] : []), actor);
    } else if (input.kind === 'delete_records') {
      const ids = input.records.map((row) => row.id);
      const outgoing = (await tx.query<{ target_table_id: string }>('SELECT DISTINCT target_table_id FROM table_links WHERE table_id = $1 AND record_id = ANY($2::uuid[])', [tableId, ids])).rows;
      await this.authorizeTargets(tx, outgoing.map((row) => row.target_table_id), actor);
      const found = (await tx.query<{ id: string; version: number }>('SELECT id, version FROM table_records WHERE table_id = $1 AND id = ANY($2::uuid[])', [tableId, ids])).rows;
      if (found.length !== ids.length) throw new DomainError('TABLE_NOT_FOUND');
      if (input.records.some((row) => found.find((item) => item.id === row.id)?.version !== row.expectedVersion)) throw new DomainError('TABLE_CONFLICT');
      impact.recordIds = ids; impact.recordCount = ids.length;
    } else {
      const columnId = input.kind === 'delete_column' ? input.columnId : input.column.id!;
      const previous = table.columns.find((column) => column.id === columnId);
      if (!previous) throw new DomainError('TABLE_ACCESS_DENIED');
      if (previous.type === 'relation') await this.authorizeTargets(tx, [previous.targetTableId], actor);
      impact.columnId = columnId; impact.columnName = previous.name;
      // Referência direta ou transitiva em fórmula impede remoção e mudança de significado do tipo/configuração.
      const next = input.kind === 'delete_column' ? table.columns.filter((column) => column.id !== columnId) : table.columns.map((column) => column.id === columnId ? input.column as TableColumn : column);
      compileFormulas(next);
      if (input.kind === 'convert_column') {
        if (new Set(next.map((column) => column.name.toLocaleLowerCase('pt-BR'))).size !== next.length) throw new DomainError('TABLE_INVALID_SCHEMA');
        const replacement = input.column as TableColumn;
        const rows = (await tx.query<RecordRow>('SELECT id, version, values FROM table_records WHERE table_id = $1', [tableId])).rows;
        const projected = await this.projectRecords(tx, tableId, rows, table.columns, deadline);
        const values = projected.map((row) => {
          if (row.errors?.[columnId]) throw new DomainError('TABLE_INVALID_VALUE');
          return { [columnId]: this.conversionValue(previous, replacement, row.values[columnId] ?? null) };
        });
        if (replacement.type === 'calculated') {
          const computed = await this.projectRecords(tx, tableId, rows, next, deadline);
          if (computed.some((row, index) => row.errors?.[columnId] || canonical(row.values[columnId]) !== canonical(values[index]![columnId]))) throw new DomainError('TABLE_INVALID_VALUE');
        } else await this.validateValues(tx, [replacement], values, actor);
      }
    }
    return impact;
  }

  /** Conversão explícita só muda representação de cardinalidade; escalares mantêm valor/tipo sem parsing ou arredondamento. */
  private conversionValue(previous: TableColumn, next: TableColumn, value: TableCell): TableCell {
    if (value === null) return null;
    const previousMoney = previous.type === 'money' || previous.type === 'calculated' && previous.resultType === 'money';
    const nextMoney = next.type === 'money' || next.type === 'calculated' && next.resultType === 'money';
    if (previousMoney && nextMoney && 'currency' in previous && 'currency' in next && previous.currency !== next.currency) throw new DomainError('TABLE_INVALID_VALUE');
    const previousMany = previous.type === 'multiselect' || previous.type === 'relation' && previous.cardinality === 'many';
    const nextMany = next.type === 'multiselect' || next.type === 'relation' && next.cardinality === 'many';
    if (previousMany && !nextMany) {
      if (!Array.isArray(value) || value.length > 1) throw new DomainError('TABLE_INVALID_VALUE');
      return value[0] ?? null;
    }
    if (!previousMany && nextMany) return typeof value === 'string' ? [value] : value;
    return value;
  }

  /** Catálogo paginado: owner vê tudo; bot vê somente associações, Chat geral é recusado. */
  async list(actor: TableActor, page: { cursor?: string; limit?: number } = {}, botId?: string): Promise<{ tables: DataTable[]; nextCursor: string | null }> {
    this.assertActor(actor);
    if (page.cursor !== undefined && !tableIdSchema.safeParse(page.cursor).success) throw new DomainError('VALIDATION_FAILED');
    return this.read(async (tx) => {
      const effectiveBot = actor.kind === 'bot' ? actor.botId : botId ?? null;
      if (effectiveBot && !(await tx.query('SELECT 1 FROM bots WHERE id = $1', [effectiveBot])).rowCount) throw new DomainError('BOT_NOT_FOUND');
      const limit = this.pageLimit(page.limit);
      const found = await tx.query<TableRow>(`SELECT ${TABLE_FIELDS} FROM data_tables t WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM table_bot_access a WHERE a.table_id = t.id AND a.bot_id = $1)) AND ($2::uuid IS NULL OR t.id > $2) ORDER BY t.id LIMIT $3`, [effectiveBot, page.cursor ?? null, limit + 1]);
      const rows = found.rows.slice(0, limit);
      return { tables: await this.hydrateMany(tx, rows, actor), nextCursor: found.rows.length > limit ? rows.at(-1)!.id : null };
    });
  }

  /** Lê metadados sob o mesmo snapshot de associações/colunas, sem revelar relações inacessíveis. */
  async get(tableId: string, actor: TableActor): Promise<DataTable> {
    return this.read(async (tx) => {
      return (await this.hydrateMany(tx, [await this.authorize(tx, tableId, actor)], actor))[0]!;
    });
  }

  /** Registros escalares e vínculos acessíveis; nulos de colunas novas são derivados, sem reescrever linhas. */
  async records(tableId: string, actor: TableActor, page: { cursor?: string; limit?: number } = {}): Promise<{ records: TableRecord[]; nextCursor: string | null }> {
    if (page.cursor !== undefined && !tableIdSchema.safeParse(page.cursor).success) throw new DomainError('VALIDATION_FAILED');
    return this.read(async (tx, deadline) => {
      const table = (await this.hydrateMany(tx, [await this.authorize(tx, tableId, actor)], actor))[0]!;
      const limit = this.pageLimit(page.limit);
      const rows = (await tx.query<RecordRow>('SELECT id, version, values FROM table_records WHERE table_id = $1 AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3', [tableId, page.cursor ?? null, limit + 1])).rows;
      const visible = rows.slice(0, limit);
      const records = await this.projectRecords(tx, tableId, visible, table.columns, deadline);
      return { records, nextCursor: rows.length > limit ? visible.at(-1)!.id : null };
    });
  }

  /** Formulário do dono lê um único registro completo no snapshot atual; consultas e ferramentas mantêm o teto próprio de 64 KiB. */
  async readRecord(tableId: string, recordId: string, actor: TableActor): Promise<TableRecord> {
    if (actor.kind !== 'owner') throw new DomainError('TABLE_ACCESS_DENIED');
    if (!tableIdSchema.safeParse(recordId).success) throw new DomainError('VALIDATION_FAILED');
    return this.read(async (tx, deadline) => {
      const table = (await this.hydrateMany(tx, [await this.authorize(tx, tableId, actor)], actor))[0]!;
      const rows = await queryWithin<RecordRow>(tx, deadline, 'SELECT id, version, values FROM table_records WHERE table_id = $1 AND id = $2', [tableId, recordId]);
      if (!rows.length) throw new DomainError('TABLE_NOT_FOUND');
      return (await this.projectRecords(tx, tableId, rows, table.columns, deadline))[0]!;
    });
  }

  /** Resolve apenas IDs da tabela autorizada. Ausentes/removidos ficam fora do resultado, sem revelar outra tabela. */
  async lookupRecords(tableId: string, raw: Partial<TableRecordLookup>, actor: TableActor): Promise<TableQueryResult> {
    const input = parseInput<TableRecordLookup>(tableRecordLookupSchema, raw);
    return this.query(tableId, { recordIds: [...input.ids].sort(), columns: input.columns, cursor: input.cursor, limit: input.limit }, actor);
  }

  /** Projeção/dependências mínimas; autoriza tabela e vínculos de toda consulta/vista no snapshot atual. O envelope devolvido é o contrato da API e não muda. */
  async query(tableId: string, raw: Partial<TableQuery>, actor: TableActor): Promise<TableQueryResult> {
    return this.queryShaped(tableId, raw, actor, (result) => result);
  }

  /**
   * A mesma consulta, com o envelope escolhido por quem chama: `shape` recebe o resultado e as colunas visíveis ao ator no MESMO snapshot, e o teto de 64 KiB vale
   * para o envelope que ela devolve (uma página que não cabe perde linhas do fim, com o cursor coerente). É como a ferramenta `table_query` grava, junto do
   * resultado, os nomes das colunas e os rótulos das opções (`model-format.ts`) sem mudar o que a API devolve.
   * ponytail: materializa até 10.000 registros projetados para avaliar AST em vetores, compilar a AST diretamente em SQL se o teto de 5s se tornar insuficiente no uso real.
   */
  async queryShaped<T extends object>(tableId: string, raw: Partial<TableQuery>, actor: TableActor, shape: (result: TableQueryResult, visible: TableColumn[]) => T): Promise<T> {
    const input = parseInput<TableQuery>(tableQuerySchema, raw);
    return this.read(async (tx, deadline) => {
      const current = await this.authorize(tx, tableId, actor);
      const instant = this.options.now?.() ?? new Date();
      const settings = await readAppSettings(tx);
      const today = formatCivilDate(localDateOf(instant.getTime(), settings.timeZone));
      const all = (await this.hydrateMany(tx, [current], { kind: 'owner' }))[0]!;
      const visible = (await this.hydrateMany(tx, [current], actor))[0]!;
      let query = input;
      let viewVersion: number | null = null;
      if (input.viewId) {
        const view = await this.viewIn(tx, tableId, input.viewId);
        viewVersion = view.version;
        // Dependências da vista são validadas antes de qualquer override explícito do caller.
        validateQuery(view, visible.columns, all.columns);
        query = { ...view, ...input };
      }
      validateQuery(query, visible.columns, all.columns);
      const plan = compileFormulas(all.columns);
      const requested = [...queryColumns(query, visible.columns)];
      const needed = [...plan.dependencies(requested)];
      const projected = all.columns.filter((column) => needed.includes(column.id));
      const stored = projected.filter((column) => column.type !== 'calculated' && column.type !== 'relation').map((column) => column.id);
      // Lookup restringe pela chave primária antes de projetar/calcular: nunca materializa a tabela inteira para achar uma seleção.
      const rows = await queryWithin<RecordRow>(tx, deadline, `SELECT id, version, COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(r.values) WHERE key = ANY($2::text[])), '{}'::jsonb) AS values FROM table_records r WHERE table_id = $1${query.recordIds ? ' AND id = ANY($3::uuid[])' : ''}`, query.recordIds ? [tableId, stored, query.recordIds] : [tableId, stored]);
      const records = await this.projectRecords(tx, tableId, rows, projected, deadline, plan, today);
      const result = await executeQuery(tx, query, visible.columns, records, { tableId, actor: actorKey(actor), version: current.version, schema: current.schema_version, viewVersion, today }, deadline, (page) => shape(page, visible.columns));
      return shape(result, visible.columns);
    });
  }

  /**
   * Troca ids curtos de registro (prefixo de UUID, TAB-03) pelos UUIDs completos desta tabela, para a ferramenta entregar ao serviço só ids completos.
   *
   * Lista só com UUID completo volta como veio, SEM consulta e SEM checar acesso: a autorização de tabela e de registro acontece no consumidor do id (a escrita, a
   * consulta e a preparação já autorizam), como sempre aconteceu com o id completo. Com algum id curto, autoriza a tabela ANTES de resolver (um bot sem acesso
   * nunca descobre se o prefixo existe: a resposta é a mesma de tabela inexistente) e só procura dentro dela. Ambiguidade vira `AmbiguousRecordError` com os
   * candidatos, o nome de cada um (a primeira célula com valor entre as colunas visíveis; sem nenhuma, o id completo) e quantos candidatos ficaram de fora.
   *
   * Replay: `operationId` é o da escrita que usa a lista. O replay com id curto precisa terminar como terminaria com o id completo, e o id curto pode ter deixado
   * de resolver desde o commit (outro registro passou a começar igual, ou o registro foi removido). Por isso, se esse ator já gravou um recibo `table.write`
   * nesta tabela sob o mesmo `operationId`: (1) cada prefixo que identifica um único registro do próprio recibo resolve para ele, sem olhar a tabela, e a
   * mutação então compara o hash da entrada completa com o do recibo (entrada diferente continua sendo `TABLE_CONFLICT`, nada é gravado); (2) se o recibo já
   * marca o recurso como removido, a resposta é `TABLE_RESOURCE_REMOVED`, a mesma do replay com id completo. A autorização não é afrouxada: a tabela é autorizada
   * antes, o recibo só é lido do próprio ator, e quem devolve o recibo é a mutação, que autoriza de novo.
   * ponytail: a resolução roda numa leitura própria, antes da mutação; um registro criado ou excluído entre as duas só muda a resposta de uma escrita nova (a
   * mutação revalida o id completo e o acesso), então o intervalo não abre brecha; trazer a resolução para dentro da transação da mutação só se esse intervalo
   * causar falha real.
   */
  async resolveRecordRefs(tableId: string, refs: readonly string[], actor: TableActor, operationId?: string): Promise<string[]> {
    const normalized = refs.map((ref) => normalizeRecordRef(ref));
    if (!normalized.every(isRecordRef)) throw new DomainError('VALIDATION_FAILED');
    if (normalized.every((ref) => ref.length === RECORD_ID_CHARS)) return normalized;
    if (operationId !== undefined && !tableIdSchema.safeParse(operationId).success) throw new DomainError('VALIDATION_FAILED');
    return this.read(async (tx) => {
      const current = await this.authorize(tx, tableId, actor);
      const prior = operationId === undefined ? null : await this.priorWrite(tx, tableId, operationId, actor);
      if (prior?.removed) throw new DomainError('TABLE_RESOURCE_REMOVED');
      if (prior) {
        const priorIds = prior.records.map((record) => record.id);
        const own = normalized.map((ref) => {
          if (ref.length === RECORD_ID_CHARS) return ref;
          const hits = new Set(priorIds.filter((id) => id.startsWith(ref)));
          return hits.size === 1 ? [...hits][0]! : null;
        });
        if (own.every((id): id is string => id !== null)) return own;
      }
      return resolveRecordRefs(tx, tableId, normalized, (ids) => this.recordNames(tx, current, ids, actor));
    });
  }

  /**
   * Troca ids curtos de registro (TAB-03) nas células de RELAÇÃO de `creates[].values` e `updates[].values` de um `table_write` pelo UUID completo do registro de
   * DESTINO, para `write` receber, gravar em `table_links` e guardar no recibo só ids completos. É o par de `resolveRecordRefs` para o que o `table_query` mostra
   * como id curto e a escrita de relação precisa do inteiro.
   *
   * O destino vem da COLUNA (`column.targetTableId`), nunca do id: o prefixo só é procurado na tabela de destino daquela coluna, com a mesma consulta parametrizada
   * e os mesmos erros de `resolveRecordRefs` (ambíguo com os candidatos e nomes do DESTINO, inexistente `TABLE_NOT_FOUND`). Ordem do fluxo:
   *   1. lote sem nenhum texto que não seja UUID completo: volta como veio, sem consulta;
   *   2. autoriza a tabela escrita e lê as colunas na visão do dono (a mesma de `write`); célula de coluna desconhecida ou que não é relação fica como veio e
   *      `write` decide como sempre;
   *   3. em coluna de relação, texto que não é prefixo canônico de UUID é `VALIDATION_FAILED` (o mesmo formato do id curto das demais ferramentas);
   *   4. com algum prefixo: recibo já removido é `TABLE_RESOURCE_REMOVED`, os destinos são autorizados em lote (`authorizeTargets`: bot sem acesso ao destino recebe
   *      `TABLE_NOT_FOUND`, a resposta de qualquer id de relação para esse destino, e nunca descobre se o prefixo existe) e só então o prefixo é resolvido.
   * UUID completo passa exatamente como veio: a escrita confere existência e acesso, como sempre.
   *
   * Replay (mesma regra de `resolveRecordRefs`): com recibo `table.write` do mesmo ator e `operationId`, cada prefixo que identifica um único alvo entre os valores
   * da MESMA coluna no resultado gravado resolve para ele sem olhar a tabela de destino (o registro de destino pode ter sumido ou ganhado um vizinho de prefixo igual
   * desde o commit); a mutação compara depois o hash da entrada completa com o do recibo, então entrada diferente continua sendo `TABLE_CONFLICT`. Basta um prefixo
   * sem correspondência no recibo para o lote inteiro ser resolvido pela tabela de destino.
   * ponytail: lote com qualquer texto (toda escrita com célula de texto) paga uma leitura a mais para saber quais colunas são relação, mover a resolução para dentro
   * da transação da mutação, que já lê as colunas, se esse custo aparecer; o intervalo entre as duas leituras tem a mesma justificativa da ponytail de `resolveRecordRefs`.
   */
  async resolveRelationRefs<C extends { values: Record<string, TableCell> }, U extends { values: Record<string, TableCell> }>(tableId: string, batch: { creates: readonly C[]; updates: readonly U[] }, actor: TableActor, operationId?: string): Promise<{ creates: C[]; updates: U[] }> {
    const records = [...batch.creates, ...batch.updates];
    const unchanged = { creates: [...batch.creates], updates: [...batch.updates] };
    if (!records.some((record) => Object.values(record.values).some((cell) => cellTexts(cell).some((text) => !isFullRecordId(text))))) return unchanged;
    if (operationId !== undefined && !tableIdSchema.safeParse(operationId).success) throw new DomainError('VALIDATION_FAILED');
    return this.read(async (tx) => {
      const current = await this.authorize(tx, tableId, actor);
      const targetOf = new Map((await this.hydrateMany(tx, [current], { kind: 'owner' }))[0]!.columns.flatMap((column) => column.type === 'relation' ? [[column.id, column.targetTableId] as const] : []));
      // Prefixos pedidos por coluna de relação, normalizados e sem repetição.
      const wanted = new Map<string, Set<string>>();
      for (const record of records) {
        for (const [columnId, cell] of Object.entries(record.values)) {
          if (!targetOf.has(columnId)) continue;
          for (const text of cellTexts(cell)) {
            if (isFullRecordId(text)) continue;
            if (!isRecordRef(text)) throw new DomainError('VALIDATION_FAILED');
            wanted.set(columnId, (wanted.get(columnId) ?? new Set<string>()).add(normalizeRecordRef(text)));
          }
        }
      }
      if (wanted.size === 0) return unchanged;
      const prior = operationId === undefined ? null : await this.priorWrite(tx, tableId, operationId, actor);
      if (prior?.removed) throw new DomainError('TABLE_RESOURCE_REMOVED');
      await this.authorizeTargets(tx, [...wanted.keys()].map((columnId) => targetOf.get(columnId)!), actor);

      /** Coluna de relação -> (prefixo normalizado -> UUID completo). */
      const resolved = new Map<string, Map<string, string>>();
      const settle = (columnId: string, ref: string, id: string): void => { resolved.set(columnId, (resolved.get(columnId) ?? new Map<string, string>()).set(ref, id)); };
      let complete = prior !== null;
      if (prior) {
        for (const [columnId, refs] of wanted) {
          const known = [...new Set(prior.records.flatMap((record) => cellTexts(record.values[columnId])))];
          for (const ref of refs) {
            const hits = known.filter((id) => id.startsWith(ref));
            if (hits.length === 1) settle(columnId, ref, hits[0]!); else complete = false;
          }
        }
      }
      if (!complete) {
        resolved.clear();
        for (const [columnId, refs] of wanted) {
          const targetTableId = targetOf.get(columnId)!;
          const ordered = [...refs];
          // O nome dos candidatos de uma ambiguidade vem da tabela de DESTINO, já autorizada acima, na visão do bot.
          const ids = await resolveRecordRefs(tx, targetTableId, ordered, async (candidates) => this.recordNames(tx, await this.authorize(tx, targetTableId, actor), candidates, actor));
          ordered.forEach((ref, index) => settle(columnId, ref, ids[index]!));
        }
      }
      const swap = <T extends { values: Record<string, TableCell> }>(record: T): T => ({ ...record, values: Object.fromEntries(Object.entries(record.values).map(([columnId, cell]) => [columnId, withResolvedIds(cell, resolved.get(columnId))])) }) as T;
      return { creates: batch.creates.map(swap), updates: batch.updates.map(swap) };
    });
  }

  /**
   * O que a escrita já gravada sob este `operationId` deixou (recibo do mesmo ator, da mesma tabela, ação `table.write`): os registros do resultado (id e células, as de
   * relação com o UUID completo do destino) e se o recurso já foi removido. É a fonte do replay com id curto, tanto de `updates[].id` quanto de célula de relação.
   */
  private async priorWrite(tx: Queryable, tableId: string, operationId: string, actor: TableActor): Promise<{ records: { id: string; values: Record<string, unknown> }[]; removed: boolean } | null> {
    const rows = (await tx.query<{ records: { id: string; values: Record<string, unknown> }[]; removed: boolean }>(
      `SELECT COALESCE(result->'records', '[]'::jsonb) AS records,
              COALESCE((result->>'resourceRemoved')::boolean, false) AS removed
         FROM table_mutation_receipts WHERE actor = $1 AND operation_id = $2 AND table_id = $3 AND action = 'table.write'`,
      [actorKey(actor), operationId, tableId],
    )).rows;
    return rows[0] ?? null;
  }

  /**
   * Nome de cada registro, para o modelo escolher entre candidatos: a primeira célula COM valor entre as colunas visíveis ao ator, na ordem das colunas (relação e
   * calculada ficam de fora; seleção mostra o rótulo; célula vazia, em branco ou lista vazia é pulada), com no máximo 60 caracteres. Registro sem nenhuma célula
   * com valor fica com o id completo como nome, para o candidato nunca vir sem nome.
   */
  private async recordNames(tx: Queryable, table: TableRow, ids: string[], actor: TableActor): Promise<Map<string, string>> {
    const columns = (await this.hydrateMany(tx, [table], actor))[0]!.columns
      .filter((candidate) => candidate.type !== 'relation' && candidate.type !== 'calculated')
      .map((column) => ({ id: column.id, labels: column.type === 'select' || column.type === 'multiselect' ? Object.fromEntries(column.options.map((option) => [option.id, option.label])) : undefined }));
    const rows = (await tx.query<{ id: string; values: Record<string, TableCell> }>(
      `SELECT id::text AS id, COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(r.values) WHERE key = ANY($3::text[])), '{}'::jsonb) AS values FROM table_records r WHERE table_id = $1 AND id = ANY($2::uuid[])`,
      [table.id, ids, columns.map((column) => column.id)],
    )).rows;
    return new Map(rows.map((row) => {
      for (const column of columns) {
        const text = cellDisplay(row.values[column.id], column.labels).trim();
        if (text) return [row.id, text.length > 60 ? `${clipUnits(text, 59)}…` : text] as const;
      }
      return [row.id, row.id] as const;
    }));
  }

  /** Preview executa o mesmo compilador/normalização de consulta, sem persistir coluna ou células. */
  async previewFormula(tableId: string, raw: unknown, actor: TableActor): Promise<{ value: TableCell; error?: import('@aion/shared').TableCellError }> {
    const input = parseInput<import('zod').infer<typeof tableFormulaPreviewSchema>>(tableFormulaPreviewSchema, raw);
    return this.read(async (tx, deadline) => {
      const table = (await this.hydrateMany(tx, [await this.authorize(tx, tableId, actor)], actor))[0]!;
      await this.validateValues(tx, table.columns, [input.values], actor);
      const existing = input.columnId ? table.columns.find((column) => column.id === input.columnId) : undefined;
      if (input.columnId && !existing) throw new DomainError('TABLE_INVALID_SCHEMA');
      const id = input.columnId ?? randomUUID();
      // Substitui hipoteticamente a coluna autorizada, inclusive em conversão para calculada; não grava schema nem concede aprovação.
      const columns = [...table.columns.filter((column) => column.id !== id), { id, name: existing?.name ?? 'Prévia', type: 'calculated', formula: input.formula, resultType: input.resultType, currency: input.currency } as TableColumn];
      const settings = await readAppSettings(tx);
      const result = await evaluateFormulas(tx, compileFormulas(columns), [{ id: randomUUID(), version: 1, values: input.values }], [id], formatCivilDate(localDateOf((this.options.now?.() ?? new Date()).getTime(), settings.timeZone)), deadline);
      return { value: result[0]!.values[id]!, ...(result[0]!.errors?.[id] ? { error: result[0]!.errors![id] } : {}) };
    });
  }

  /** Vistas guardam só definições revisadas; listar não revela dependências de uma relação revogada. */
  async views(tableId: string, actor: TableActor): Promise<{ views: TableView[] }> {
    return this.read(async (tx) => {
      const current = await this.authorize(tx, tableId, actor);
      const all = (await this.hydrateMany(tx, [current], { kind: 'owner' }))[0]!;
      const visible = (await this.hydrateMany(tx, [current], actor))[0]!;
      const rows = await tx.query<{ id: string; name: string; version: number; definition: TableView }>('SELECT id, name, version, definition FROM table_views WHERE table_id = $1 ORDER BY id', [tableId]);
      const views = rows.rows.map((row) => ({ ...row.definition, id: row.id, name: row.name, version: row.version }));
      views.forEach((view) => validateQuery(view, visible.columns, all.columns));
      return { views };
    });
  }

  /** Cria/edita vista atomicamente com revisão, cota e recibo, sem duplicar registros. */
  async saveView(tableId: string, raw: TableViewCreate | TableViewUpdate, actor: TableActor, viewId?: string, origin: TableOrigin = {}): Promise<TableView> {
    const input = parseInput<TableViewCreate | TableViewUpdate>(viewId ? tableViewUpdateSchema : tableViewCreateSchema, raw);
    if (viewId && !tableIdSchema.safeParse(viewId).success) throw new DomainError('VALIDATION_FAILED');
    return this.mutate(actor, input.operationId, viewId ? 'table.view.update' : 'table.view.create', input, tableId, origin, async (tx) => {
      const current = await this.authorize(tx, tableId, actor);
      const all = (await this.hydrateMany(tx, [current], { kind: 'owner' }))[0]!;
      const visible = (await this.hydrateMany(tx, [current], actor))[0]!;
      const definition = { ...(input.columns ? { columns: input.columns } : {}), ...(input.filter !== undefined ? { filter: input.filter } : {}), ...(input.sort ? { sort: input.sort } : {}) };
      validateQuery(definition, visible.columns, all.columns);
      let version = 1;
      if (viewId) {
        const previous = await this.viewIn(tx, tableId, viewId);
        validateQuery(previous, visible.columns, all.columns);
        if (!('expectedVersion' in input) || input.expectedVersion !== previous.version) throw new DomainError('TABLE_CONFLICT');
        version = previous.version + 1;
        await tx.query('UPDATE table_views SET name = $3, definition = $4, version = $5 WHERE table_id = $1 AND id = $2', [tableId, viewId, input.name, JSON.stringify(definition), version]);
      } else {
        if (Number((await tx.query<{ count: string }>('SELECT count(*) FROM table_views WHERE table_id = $1', [tableId])).rows[0]!.count) >= 20) throw new DomainError('TABLE_LIMIT_EXCEEDED');
        viewId = randomUUID();
        await tx.query('INSERT INTO table_views (table_id, id, name, definition) VALUES ($1, $2, $3, $4)', [tableId, viewId, input.name, JSON.stringify(definition)]);
      }
      await this.bump(tx, tableId);
      return { ...definition, id: viewId, name: input.name, version };
    }, { viewId });
  }

  /** Remover vista exige revisão e acesso, mas não é exclusão de dados da tabela (portão T4). */
  async removeView(tableId: string, viewId: string, raw: unknown, actor: TableActor, origin: TableOrigin = {}): Promise<{ id: string; removed: true }> {
    const input = parseInput<import('zod').infer<typeof tableViewRemoveSchema>>(tableViewRemoveSchema, raw);
    if (!tableIdSchema.safeParse(viewId).success) throw new DomainError('VALIDATION_FAILED');
    return this.mutate(actor, input.operationId, 'table.view.remove', input, tableId, origin, async (tx) => {
      const view = await this.viewIn(tx, tableId, viewId);
      const table = (await this.hydrateMany(tx, [await this.authorize(tx, tableId, actor)], actor))[0]!;
      validateQuery(view, table.columns, table.columns);
      if (view.version !== input.expectedVersion) throw new DomainError('TABLE_CONFLICT');
      await tx.query('DELETE FROM table_views WHERE table_id = $1 AND id = $2', [tableId, viewId]);
      await this.bump(tx, tableId);
      return { id: viewId, removed: true };
    }, { viewId });
  }

  /** A vista sempre pertence à tabela autorizada; ID externo não procura em outra tabela. */
  private async viewIn(tx: Queryable, tableId: string, viewId: string): Promise<TableView> {
    const row = (await tx.query<{ id: string; name: string; version: number; definition: TableView }>('SELECT id, name, version, definition FROM table_views WHERE table_id = $1 AND id = $2', [tableId, viewId])).rows[0];
    if (!row) throw new DomainError('TABLE_NOT_FOUND');
    return { ...row.definition, id: row.id, name: row.name, version: row.version };
  }

  /** Cria tabela e associação ao bot criador atomicamente; o bot vem do contexto ou URL confiável do dono. */
  async create(raw: TableCreate, actor: TableActor, ownerBotId?: string, origin: TableOrigin = {}): Promise<DataTable> {
    const input = parseInput<TableCreate>(tableCreateSchema, raw);
    this.assertActor(actor);
    const botId = actor.kind === 'bot' ? actor.botId : ownerBotId;
    if (!botId) throw new DomainError('BOT_NOT_FOUND');
    return this.mutate(actor, input.operationId, 'table.create', input, null, origin, async (tx) => {
      if (!(await tx.query('SELECT 1 FROM bots WHERE id = $1', [botId])).rowCount) throw new DomainError('BOT_NOT_FOUND');
      if (Number((await tx.query<{ count: string }>('SELECT count(*) FROM data_tables')).rows[0]!.count) >= TABLE_LIMITS.tables) throw new DomainError('TABLE_LIMIT_EXCEEDED');
      const id = randomUUID();
      await tx.query('INSERT INTO data_tables (id, name, description) VALUES ($1, $2, $3)', [id, input.name, input.description]);
      await tx.query('INSERT INTO table_bot_access (table_id, bot_id) VALUES ($1, $2)', [id, botId]);
      await this.saveColumns(tx, id, input.columns, [], actor);
      return (await this.hydrateMany(tx, [await this.authorize(tx, id, actor)], actor))[0]!;
    }, { botId });
  }

  /** Organização e alterações sem perda preservam IDs; conversões/exclusões exigem o portão destrutivo separado. */
  async update(tableId: string, raw: TableUpdate, actor: TableActor, origin: TableOrigin = {}): Promise<DataTable> {
    const input = parseInput<TableUpdate>(tableUpdateSchema, raw);
    return this.mutate(actor, input.operationId, 'table.update', input, tableId, origin, async (tx) => {
      const current = await this.authorize(tx, tableId, actor);
      if (current.schema_version !== input.expectedSchemaVersion) throw new DomainError('TABLE_CONFLICT');
      const old = (await this.hydrateMany(tx, [current], { kind: 'owner' }))[0]!.columns;
      if (input.columns) {
        const visible = (await this.hydrateMany(tx, [current], actor))[0]!.columns;
        const hidden = old.filter((column) => !visible.some((item) => item.id === column.id));
        if (input.columns.some((column) => hidden.some((item) => item.id === column.id))) throw new DomainError('TABLE_ACCESS_DENIED');
        await this.saveColumns(tx, tableId, [...input.columns, ...hidden], old, actor, new Set(hidden.map((column) => column.id)));
      }
      await tx.query('UPDATE data_tables SET name = COALESCE($2, name), description = COALESCE($3, description), version = version + 1, schema_version = schema_version + 1, updated_at = now() WHERE id = $1', [tableId, input.name ?? null, input.description ?? null]);
      return (await this.hydrateMany(tx, [await this.authorize(tx, tableId, actor)], actor))[0]!;
    });
  }

  /** Somente o dono modifica associações; a revisão da tabela inclui registros, schema e acessos. */
  async share(tableId: string, raw: TableShare, actor: TableActor, origin: TableOrigin = {}): Promise<DataTable> {
    const input = parseInput<TableShare>(tableShareSchema, raw);
    if (actor.kind !== 'owner') throw new DomainError('TABLE_ACCESS_DENIED');
    return this.mutate(actor, input.operationId, 'table.share', input, tableId, origin, async (tx) => {
      const current = await this.authorize(tx, tableId, actor);
      if (current.version !== input.expectedVersion) throw new DomainError('TABLE_CONFLICT');
      const bots = await tx.query('SELECT id FROM bots WHERE id = ANY($1::uuid[])', [input.botIds]);
      if (bots.rowCount !== input.botIds.length) throw new DomainError('BOT_NOT_FOUND');
      const previous = (await tx.query<{ bot_id: string }>('SELECT bot_id FROM table_bot_access WHERE table_id=$1 ORDER BY bot_id', [tableId])).rows.map((row) => row.bot_id);
      // Compartilhamento igual é no-op; dados/células não alteram a revisão de autorização.
      if (JSON.stringify(previous) === JSON.stringify([...input.botIds].sort())) return (await this.hydrateMany(tx, [current], actor))[0]!;
      await tx.query('DELETE FROM table_bot_access WHERE table_id = $1', [tableId]);
      await tx.query('INSERT INTO table_bot_access (table_id, bot_id) SELECT $1, unnest($2::uuid[])', [tableId, input.botIds]);
      await tx.query('UPDATE data_tables SET access_version=access_version+1 WHERE id=$1', [tableId]);
      await this.bump(tx, tableId);
      return (await this.hydrateMany(tx, [await this.authorize(tx, tableId, actor)], actor))[0]!;
    });
  }

  /** Lote tudo-ou-nada; patches preservam campos omitidos e deduplicação compara a criação original. */
  async write(tableId: string, raw: TableWrite, actor: TableActor, origin: TableOrigin = {}): Promise<{ records: TableRecord[] }> {
    const input = parseInput<TableWrite>(tableWriteSchema, raw);
    return this.mutate(actor, input.operationId, 'table.write', input, tableId, origin, async (tx, deadline) => {
      const current = await this.authorize(tx, tableId, actor);
      if (current.schema_version !== input.expectedSchemaVersion) throw new DomainError('TABLE_CONFLICT');
      const columns = (await this.hydrateMany(tx, [current], { kind: 'owner' }))[0]!.columns;
      await this.validateValues(tx, columns, [...input.creates, ...input.updates].map((record) => record.values), actor);
      // Leitura do lote em conjunto: dedup, revisão de registros e cota não repetem SELECT por item.
      const deduplications = (await tx.query<{ key: string; payload_hash: string; record_id: string }>('SELECT key, payload_hash, record_id FROM table_deduplication WHERE table_id = $1 AND key = ANY($2::text[])', [tableId, input.creates.flatMap((record) => record.deduplicationKey ? [record.deduplicationKey] : [])])).rows;
      const dedupByKey = new Map(deduplications.map((row) => [row.key, row]));
      const existingIds = [...new Set([...input.updates.map((row) => row.id), ...deduplications.map((row) => row.record_id)])];
      const existing = (await tx.query<RecordRow>('SELECT id, version, values FROM table_records WHERE table_id = $1 AND id = ANY($2::uuid[])', [tableId, existingIds])).rows;
      const byId = new Map(existing.map((row) => [row.id, row]));
      let recordCount = Number((await tx.query<{ count: string }>('SELECT count(*) FROM table_records WHERE table_id = $1', [tableId])).rows[0]!.count);
      const results: TableRecord[] = [];
      let changed = false;
      for (const create of input.creates) {
        const payloadHash = hashOf(create.values);
        const dedup = create.deduplicationKey ? dedupByKey.get(create.deduplicationKey) : undefined;
        if (dedup) {
          if (dedup.payload_hash !== payloadHash) throw new DomainError('TABLE_CONFLICT');
          const record = byId.get(dedup.record_id);
          if (!record) throw new DomainError('TABLE_RESOURCE_REMOVED');
          results.push(record);
          continue;
        }
        if (recordCount >= TABLE_LIMITS.records) throw new DomainError('TABLE_LIMIT_EXCEEDED');
        const id = randomUUID();
        const values = this.scalarValues(columns, create.values);
        await tx.query('INSERT INTO table_records (table_id, id, values) VALUES ($1, $2, $3)', [tableId, id, JSON.stringify(values)]);
        await this.saveLinks(tx, tableId, id, columns, create.values);
        if (create.deduplicationKey) {
          await tx.query('INSERT INTO table_deduplication (table_id, key, payload_hash, record_id) VALUES ($1, $2, $3, $4)', [tableId, create.deduplicationKey, payloadHash, id]);
          dedupByKey.set(create.deduplicationKey, { key: create.deduplicationKey, payload_hash: payloadHash, record_id: id });
        }
        byId.set(id, { id, version: 1, values });
        recordCount++;
        results.push({ id, version: 1, values });
        changed = true;
      }
      for (const update of input.updates) {
        const row = byId.get(update.id);
        if (!row) throw new DomainError('TABLE_NOT_FOUND');
        if (row.version !== update.expectedVersion) throw new DomainError('TABLE_CONFLICT');
        const values = { ...row.values, ...this.scalarValues(columns, update.values) };
        await tx.query('UPDATE table_records SET values = $3, version = version + 1 WHERE table_id = $1 AND id = $2', [tableId, row.id, JSON.stringify(values)]);
        await this.saveLinks(tx, tableId, row.id, columns, update.values);
        results.push({ ...row, version: row.version + 1, values });
        changed = true;
      }
      if (changed) await this.bump(tx, tableId);
      const visible = (await this.hydrateMany(tx, [current], actor))[0]!.columns;
      return { records: await this.projectRecords(tx, tableId, results, visible, deadline) };
    });
  }

  /** Snapshot interno para comparar importação sem devolver células ao modelo. Mesma autorização/projeção das leituras normais. */
  async importSnapshot(tableId: string, actor: TableActor): Promise<{ records: TableRecord[]; deduplication: { key: string; recordId: string }[] }> {
    return this.read(async (tx, deadline) => {
      const current = await this.authorize(tx, tableId, actor);
      const columns = (await this.hydrateMany(tx, [current], actor))[0]!.columns.filter((column) => column.type !== 'calculated');
      const rows = (await tx.query<RecordRow>('SELECT id, version, values FROM table_records WHERE table_id = $1 ORDER BY id', [tableId])).rows;
      const deduplication = (await tx.query<{ key: string; recordId: string }>('SELECT key, record_id AS "recordId" FROM table_deduplication WHERE table_id = $1', [tableId])).rows;
      return { records: await this.projectRecords(tx, tableId, rows, columns, deadline), deduplication };
    });
  }

  /** Snapshot único nas leituras e timeout comum, para não devolver estrutura/acesso de instantes diferentes. */
  private async read<T>(query: (tx: PoolClient, deadline: number) => Promise<T>): Promise<T> {
    const deadline = performance.now() + 5000;
    return withTransaction(this.options.pool, async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const result = await query(deadlineClient(tx, deadline), deadline);
      if (performance.now() > deadline) throw new DomainError('SERVICE_UNAVAILABLE');
      return result;
    }).catch((error: unknown) => {
      if ((error as { code?: string })?.code === '57014') throw new DomainError('SERVICE_UNAVAILABLE');
      throw error;
    });
  }

  /** Serializa o efeito, revalida acesso ANTES do replay e grava auditoria/recibo no mesmo commit. */
  private async mutate<T>(actor: TableActor, operationId: string, action: string, input: unknown, tableId: string | null, origin: TableOrigin, apply: (tx: PoolClient, deadline: number) => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> {
    this.assertActor(actor);
    const deadline = performance.now() + 5000;
    return withTransaction(this.options.pool, async (tx) => {
      tx = deadlineClient(tx, deadline);
      await tx.query('SELECT pg_advisory_xact_lock($1)', [TABLE_MUTATION_LOCK]);
      const payloadHash = hashOf({ tableId, input, extra });
      const receipt = (await tx.query<{ table_id: string; action: string; payload_hash: string; result: T }>('SELECT table_id, action, payload_hash, result FROM table_mutation_receipts WHERE actor = $1 AND operation_id = $2', [actorKey(actor), operationId])).rows[0];
      if (receipt) {
        if (receipt.action !== action || receipt.payload_hash !== payloadHash) throw new DomainError('TABLE_CONFLICT');
        const exists = (await tx.query('SELECT 1 FROM data_tables WHERE id = $1', [receipt.table_id])).rowCount;
        if (exists) await this.authorize(tx, receipt.table_id, actor);
        if ((receipt.result as { resourceRemoved?: boolean }).resourceRemoved || receipt.action === 'table.destructive' && (receipt.result as { removed?: boolean }).removed) throw new DomainError('TABLE_RESOURCE_REMOVED');
        await this.authorize(tx, receipt.table_id, actor);
        // Relações podem perder acesso desde o resultado original. Nunca devolver snapshot de vínculo revogado.
        await this.validateReplayRelations(tx, receipt.table_id, actor, receipt.result);
        if (receipt.action.startsWith('table.view.') && actor.kind === 'bot' && receipt.action !== 'table.view.remove') {
          const row = await this.authorize(tx, receipt.table_id, actor);
          const all = (await this.hydrateMany(tx, [row], { kind: 'owner' }))[0]!;
          const visible = (await this.hydrateMany(tx, [row], actor))[0]!;
          validateQuery(receipt.result as TableView, visible.columns, all.columns);
        }
        return receipt.result;
      }
      if (tableId) await this.authorize(tx, tableId, actor);
      await this.assertExecution(tx);
      const result = await apply(tx, deadline);
      await this.assertExecution(tx);
      if (performance.now() > deadline) throw new DomainError('SERVICE_UNAVAILABLE');
      const target = tableId ?? (result as DataTable).id;
      await tx.query('INSERT INTO table_mutation_receipts (actor, operation_id, table_id, action, payload_hash, result) VALUES ($1, $2, $3, $4, $5, $6)', [actorKey(actor), operationId, target, action, payloadHash, JSON.stringify(result)]);
      const revision = (await tx.query<{ version: number }>('SELECT version FROM data_tables WHERE id = $1', [target])).rows[0]?.version ?? null;
      await recordAudit(tx, { action, actor: actor.kind === 'owner' ? 'owner' : 'system', outcome: 'success', target, ip: origin.ip, userAgent: origin.userAgent, details: { actor: actorKey(actor), revision, count: (result as { records?: unknown[] }).records?.length ?? 1 } }, new Date());
      return result;
    }).catch((error: unknown) => {
      if ((error as { code?: string })?.code === '57014') throw new DomainError('SERVICE_UNAVAILABLE');
      throw error;
    });
  }

  /** Cancelamento/queda da posse impede commit local, inclusive após espera pelo lock global. */
  private async assertExecution(tx: Queryable): Promise<void> {
    const execution = this.options.execution;
    if (!execution) return;
    if (execution.signal.aborted || !(await tx.query("SELECT 1 FROM runs WHERE id = $1 AND status = 'running' AND stop_requested_at IS NULL AND lease_until > now() AND ($2::uuid IS NULL OR lease_owner = $2)", [execution.runId, execution.leaseOwner ?? null])).rowCount) throw new DomainError('TABLE_CONFLICT');
  }

  /** Chat nunca ganha acesso por assinatura; bot inexistente/revogado é indistinguível de tabela invisível. */
  private assertActor(actor: TableActor): void {
    if (actor.kind !== 'owner' && actor.kind !== 'bot') throw new DomainError('TABLE_ACCESS_DENIED');
    if (actor.kind === 'bot' && !tableIdSchema.safeParse(actor.botId).success) throw new DomainError('TABLE_ACCESS_DENIED');
  }
  /** Autoriza recurso em cada chamada e após espera por lock; nenhum vínculo concede acesso. */
  private async authorize(tx: Queryable, tableId: string, actor: TableActor): Promise<TableRow> {
    this.assertActor(actor);
    if (!tableIdSchema.safeParse(tableId).success) throw new DomainError('VALIDATION_FAILED');
    const found = await tx.query<TableRow>(`SELECT ${TABLE_FIELDS} FROM data_tables t WHERE t.id = $1 AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM table_bot_access a WHERE a.table_id = t.id AND a.bot_id = $2))`, [tableId, actor.kind === 'bot' ? actor.botId : null]);
    if (!found.rows[0]) throw new DomainError('TABLE_NOT_FOUND');
    this.captureEvidence(found.rows, actor);
    return found.rows[0];
  }
  /** Collector síncrono conserva revisão lida sob a transação, sem consulta posterior sujeita a revogação. */
  private captureEvidence(rows: readonly Pick<TableRow, 'id' | 'access_version'>[], actor: TableActor): void {
    if (actor.kind === 'bot') this.options.onEvidence?.({ attachments: [], tables: rows.map((row) => ({ tableId: row.id, botId: actor.botId, accessVersion: row.access_version })), docs: [] });
  }
  /** Monta catálogo em duas consultas em lote, sem N+1, omitindo colunas de relação invisíveis ao bot. */
  private async hydrateMany(tx: Queryable, rows: TableRow[], actor: TableActor): Promise<DataTable[]> {
    if (!rows.length) return [];
    this.captureEvidence(rows, actor);
    const ids = rows.map((row) => row.id);
    const columns = (await tx.query<{ table_id: string; definition: TableColumn }>(`SELECT c.table_id, c.definition FROM table_columns c WHERE c.table_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR c.target_table_id IS NULL OR EXISTS (SELECT 1 FROM table_bot_access a WHERE a.table_id = c.target_table_id AND a.bot_id = $2)) ORDER BY c.table_id, c.position`, [ids, actor.kind === 'bot' ? actor.botId : null])).rows;
    if (actor.kind === 'bot') await this.authorizeTargets(tx, columns.flatMap((column) => column.definition.type === 'relation' ? [column.definition.targetTableId] : []), actor);
    const access = actor.kind === 'owner' ? (await tx.query<{ table_id: string; bot_id: string }>('SELECT table_id, bot_id FROM table_bot_access WHERE table_id = ANY($1::uuid[]) ORDER BY bot_id', [ids])).rows : [];
    return rows.map((row) => ({ id: row.id, name: row.name, description: row.description, version: row.version, schemaVersion: row.schema_version, columns: columns.filter((column) => column.table_id === row.id).map((column) => column.definition), botIds: access.filter((entry) => entry.table_id === row.id).map((entry) => entry.bot_id) }));
  }
  /** Persiste IDs gerados pelo servidor e exige que os IDs enviados já pertençam à tabela. */
  private async saveColumns(tx: PoolClient, tableId: string, inputs: TableColumnInput[], old: TableColumn[], actor: TableActor, preservedHidden = new Set<string>()): Promise<void> {
    if (inputs.length > TABLE_LIMITS.columns || new Set(inputs.map((column) => column.name.toLocaleLowerCase('pt-BR'))).size !== inputs.length) throw new DomainError('TABLE_INVALID_SCHEMA');
    if (old.some((column) => !inputs.some((input) => input.id === column.id))) throw new DomainError('TABLE_COLUMNS_INCOMPLETE');
    await this.authorizeTargets(tx, inputs.filter((column) => column.type === 'relation' && !preservedHidden.has(column.id ?? '')).map((column) => column.type === 'relation' ? column.targetTableId : ''), actor);
    const prepared = inputs.map((input) => ({ ...input, id: input.id ?? this.options.importColumnIds?.get(input.name) ?? randomUUID() })) as TableColumn[];
    if (new Set(prepared.map((column) => column.id)).size !== prepared.length || prepared.some((column, index) => !tableIdSchema.safeParse(column.id).success || !inputs[index]!.id && old.some((previous) => previous.id === column.id))) throw new DomainError('TABLE_INVALID_SCHEMA');
    compileFormulas(prepared);
    const views = (await tx.query<{ definition: TableView }>('SELECT definition FROM table_views WHERE table_id = $1', [tableId])).rows;
    views.forEach((view) => validateQuery(view.definition, prepared, prepared));
    for (const [position, input] of inputs.entries()) {
      const previous = old.find((column) => column.id === input.id);
      if (input.id && !previous) throw new DomainError('TABLE_INVALID_SCHEMA');
      if (previous) {
        const { name: _oldName, ...configuration } = previous;
        const { name: _newName, ...next } = input;
        const formulaEdit = previous.type === 'calculated' && input.type === 'calculated' && previous.resultType === input.resultType && previous.currency === input.currency;
        if (!formulaEdit && canonical(configuration) !== canonical(next)) throw new DomainError('TABLE_DEPENDENCY');
      }
      const column = prepared[position]!;
      await tx.query('INSERT INTO table_columns (table_id, id, position, definition, target_table_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (table_id, id) DO UPDATE SET position = EXCLUDED.position, definition = EXCLUDED.definition', [tableId, column.id, position, JSON.stringify(column), input.type === 'relation' ? input.targetTableId : null]);
    }
  }
  /** Confere coluna/tipo e todos os destinos relacionados no mesmo banco da escrita. */
  private async validateValues(tx: PoolClient, columns: TableColumn[], records: Record<string, TableCell>[], actor: TableActor): Promise<void> {
    const targets = new Map<string, Set<string>>();
    for (const [id, value] of records.flatMap((values) => Object.entries(values))) {
      const column = columns.find((candidate) => candidate.id === id);
      if (!column) throw new DomainError('TABLE_INVALID_VALUE');
      validateScalar(column, value);
      if (column.type === 'relation') {
        const targetIds = value === null ? [] : typeof value === 'string' ? [value] : value as string[];
        if (targetIds.some((target) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target))) throw new DomainError('TABLE_INVALID_VALUE');
        const set = targets.get(column.targetTableId) ?? new Set<string>();
        targetIds.forEach((target) => set.add(target));
        targets.set(column.targetTableId, set);
      }
    }
    await this.authorizeTargets(tx, [...targets.keys()], actor);
    const expected = [...targets].flatMap(([tableId, ids]) => [...ids].map((id) => ({ table_id: tableId, id })));
    if (expected.length) {
      const found = await tx.query('SELECT r.id FROM table_records r JOIN jsonb_to_recordset($1::jsonb) AS requested(table_id uuid, id uuid) ON r.table_id = requested.table_id AND r.id = requested.id', [JSON.stringify(expected)]);
      if (found.rowCount !== expected.length) throw new DomainError('TABLE_INVALID_VALUE');
    }
  }
  /** Separa vínculos das células escalares; FKs, e não JSON, protegem a integridade referencial. */
  private scalarValues(columns: TableColumn[], values: Record<string, TableCell>): Record<string, TableCell> {
    return Object.fromEntries(Object.entries(values).filter(([id]) => columns.find((column) => column.id === id)?.type !== 'relation'));
  }
  /** Substitui somente vínculos explicitamente enviados, preservando relações omitidas num patch. */
  private async saveLinks(tx: PoolClient, tableId: string, recordId: string, columns: TableColumn[], values: Record<string, TableCell>): Promise<void> {
    const edited = columns.filter((column) => column.type === 'relation' && Object.hasOwn(values, column.id));
    if (!edited.length) return;
    await tx.query('DELETE FROM table_links WHERE table_id = $1 AND record_id = $2 AND column_id = ANY($3::uuid[])', [tableId, recordId, edited.map((column) => column.id)]);
    const links = edited.flatMap((column) => {
      if (column.type !== 'relation') return [];
      const value = values[column.id];
      const ids = value == null ? [] : typeof value === 'string' ? [value] : value as string[];
      return ids.map((id) => ({ column_id: column.id, target_table_id: column.targetTableId, target_record_id: id }));
    });
    if (links.length) await tx.query('INSERT INTO table_links (table_id, record_id, column_id, target_table_id, target_record_id) SELECT $1, $2, x.column_id, x.target_table_id, x.target_record_id FROM jsonb_to_recordset($3::jsonb) AS x(column_id uuid, target_table_id uuid, target_record_id uuid)', [tableId, recordId, JSON.stringify(links)]);
  }
  /** Resultado da escrita é autorizado como uma leitura, sem relações ocultas mesmo em patches escalares. */
  private async projectRecords(tx: PoolClient, tableId: string, rows: RecordRow[], columns: TableColumn[], deadline: number, plan = compileFormulas(columns), fixedToday?: string): Promise<TableRecord[]> {
    if (!rows.length) return [];
    const relationIds = columns.filter((column) => column.type === 'relation').map((column) => column.id);
    const links = relationIds.length ? await queryWithin<{ record_id: string; column_id: string; target_record_id: string }>(tx, deadline, 'SELECT record_id, column_id, target_record_id FROM table_links WHERE table_id = $1 AND record_id = ANY($2::uuid[]) AND column_id = ANY($3::uuid[]) ORDER BY target_record_id', [tableId, rows.map((row) => row.id), relationIds]) : [];
    // Índice em memória evita varrer todos os vínculos para cada célula da projeção.
    const indexed = new Map<string, string[]>();
    for (const [index, link] of links.entries()) {
      if (index % 1000 === 0 && performance.now() > deadline) throw new DomainError('SERVICE_UNAVAILABLE');
      const key = `${link.record_id}:${link.column_id}`;
      const ids = indexed.get(key) ?? [];
      ids.push(link.target_record_id);
      indexed.set(key, ids);
    }
    const records = rows.map((row, index) => {
      if (index % 1000 === 0 && performance.now() > deadline) throw new DomainError('SERVICE_UNAVAILABLE');
      return { id: row.id, version: row.version, values: Object.fromEntries(columns.map((column) => {
      const ids = indexed.get(`${row.id}:${column.id}`) ?? [];
      return [column.id, column.type === 'relation' ? column.cardinality === 'one' ? ids[0] ?? null : ids.length ? ids : null : row.values[column.id] ?? null];
      })) };
    });
    if (!columns.some((column) => column.type === 'calculated')) return records;
    const today = fixedToday ?? formatCivilDate(localDateOf((this.options.now?.() ?? new Date()).getTime(), (await readAppSettings(tx)).timeZone));
    return evaluateFormulas(tx, plan, records, columns.map((column) => column.id), today, deadline);
  }
  /** Replay não devolve IDs de relações cujo acesso foi revogado depois do commit original. */
  private async validateReplayRelations(tx: PoolClient, tableId: string, actor: TableActor, result: unknown): Promise<void> {
    if (actor.kind !== 'bot') return;
    const table = (await this.hydrateMany(tx, [await this.authorize(tx, tableId, { kind: 'owner' })], { kind: 'owner' }))[0]!;
    const payload = result as { records?: TableRecord[]; columns?: TableColumn[] };
    const targets = table.columns.filter((column) => column.type === 'relation' && (payload.columns?.some((candidate) => candidate.id === column.id) || payload.records?.some((record) => Object.hasOwn(record.values, column.id))));
    await this.authorizeTargets(tx, targets.map((column) => column.type === 'relation' ? column.targetTableId : ''), actor);
  }
  /** Autorização de destinos em lote: nenhum N+1 por célula ou coluna relacionada. */
  private async authorizeTargets(tx: Queryable, targets: string[], actor: TableActor): Promise<void> {
    const ids = [...new Set(targets)];
    if (!ids.length) return;
    const found = await tx.query<Pick<TableRow, 'id' | 'access_version'>>('SELECT t.id, t.access_version FROM data_tables t WHERE t.id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM table_bot_access a WHERE a.table_id = t.id AND a.bot_id = $2))', [ids, actor.kind === 'bot' ? actor.botId : null]);
    if (found.rowCount !== ids.length) throw new DomainError('TABLE_NOT_FOUND');
    this.captureEvidence(found.rows, actor);
  }
  /** Uma revisão da tabela cobre toda mutação dos registros ou acessos, para o futuro portão destrutivo. */
  private async bump(tx: PoolClient, tableId: string): Promise<void> {
    await tx.query('UPDATE data_tables SET version = version + 1, updated_at = now() WHERE id = $1', [tableId]);
  }
  /** Limita paginação também para callers internos. */
  private pageLimit(limit = 100): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('TABLE_QUERY_LIMIT');
    return limit;
  }
}
