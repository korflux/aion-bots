// Cliente tipado das tabelas; sessão e transporte permanecem no apiFetch comum.
import type { AppSettings, DataTable, TableRecord, TableQueryDefinition } from '@aion/shared';
import { apiFetch } from '@/lib/api-client';

export type RecordPage = { records: TableRecord[]; nextCursor: string | null };
export type TablePage = { tables: DataTable[]; nextCursor: string | null };
/** O formulário recebe todos os campos de um registro autorizado, independentemente da projeção da lista. */
export async function loadRecord(tableId: string, recordId: string): Promise<TableRecord> {
  return apiFetch<TableRecord>(`/api/tables/${tableId}/records/${recordId}`);
}
/** Catálogo de até 100 definições globais, paginado no transporte, reutilizado pela gestão e pelas relações. */
export async function loadTableCatalog(): Promise<DataTable[]> {
  const tables: DataTable[] = []; let cursor: string | null = null;
  do { const page: TablePage = await apiFetch<TablePage>(pagePath('/api/tables', cursor ?? undefined, 20)); tables.push(...page.tables); cursor = page.nextCursor; } while (cursor);
  return tables;
}
/** URL de paginação com cursor opaco, sem misturar o estado de edições locais. */
export function pagePath(path: string, cursor?: string, limit = 20): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return `${path}?${query}`;
}
/**
 * Registros por página da grade: o máximo aceito pela API (`tablePageSchema`/`queryPage`, 1..100). Com 20 o dono paginava demais; 100 linhas
 * renderizam sem custo perceptível e as fórmulas são calculadas no servidor por página.
 */
export const TABLE_PAGE_SIZE = 100;
/** Carrega definição e página com o mesmo ponto de entrada nas duas rotas do editor. */
export async function loadTable(id: string, cursor?: string, definition?: TableQueryDefinition, csrfToken?: string): Promise<{ table: DataTable; page: RecordPage; zone: string }> {
  const pageRequest = definition ? apiFetch<RecordPage>(`/api/tables/${id}/query`, { method: 'POST', csrfToken, body: { ...definition, limit: TABLE_PAGE_SIZE, ...(cursor ? { cursor } : {}) } }) : apiFetch<RecordPage>(pagePath(`/api/tables/${id}/records`, cursor, TABLE_PAGE_SIZE));
  const [table, page, settings] = await Promise.all([apiFetch<DataTable>(`/api/tables/${id}`), pageRequest, apiFetch<AppSettings>('/api/settings')]);
  return { table, page, zone: settings.timeZone };
}
