'use client';

// Filtros e vistas são configuração independente dos registros; aplicar nunca salva a vista implicitamente.
import { tableQueryDefinitionSchema, type DataTable, type TableFilter, type TableQueryDefinition, type TableView } from '@aion/shared';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { ConfigurationPanel } from './configuration-panel';
import { emptyPredicate, filterOperators, moveItem, predicateCount } from './configuration';
import { TableField } from './field';
import { fieldInput, parseField } from './values';

const operators = { empty: 'Está vazio', not_empty: 'Está preenchido', eq: 'Igual', ne: 'Diferente', lt: 'Menor', lte: 'Menor ou igual', gt: 'Maior', gte: 'Maior ou igual', contains: 'Contém texto', includes: 'Inclui' };

/** Grupo recursivo com profundidade explícita e operadores derivados do tipo efetivo. */
function FilterNode({ value, table, zone, depth, count, onChange }: { value: TableFilter; table: DataTable; zone: string; depth: number; count: number; onChange: (value: TableFilter | null) => void }) {
  const id = useId();
  if ('filters' in value) return <fieldset className="min-w-0 space-y-3 rounded border border-line p-3"><legend className="px-1 text-sm">Grupo de condições</legend><Select aria-label="Combinar condições" value={value.op} onChange={(event) => onChange({ ...value, op: event.target.value as 'and' | 'or' })}><option value="and">Todas as condições</option><option value="or">Qualquer condição</option></Select>
    {value.filters.map((child, index) => <FilterNode key={index} value={child} table={table} zone={zone} depth={depth + 1} count={count} onChange={(next) => { const filters = next ? value.filters.map((item, position) => position === index ? next : item) : value.filters.filter((_, position) => position !== index); onChange(filters.length ? { ...value, filters } : null); }} />)}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" disabled={count >= 20 || depth >= 3 || !table.columns.length} onClick={() => onChange({ ...value, filters: [...value.filters, emptyPredicate(table.columns[0]!)] })}>Adicionar condição</Button><Button size="sm" variant="secondary" disabled={count >= 20 || depth >= 2 || !table.columns.length} onClick={() => onChange({ ...value, filters: [...value.filters, { op: 'and', filters: [emptyPredicate(table.columns[0]!)] }] })}>Adicionar grupo</Button><Button size="sm" variant="ghost" onClick={() => onChange(null)}>Remover grupo</Button></div>
  </fieldset>;
  const column = table.columns.find((item) => item.id === value.columnId);
  if (!column) return <div role="alert">A coluna deste filtro não está disponível.<Button variant="ghost" onClick={() => onChange(null)}>Remover condição</Button></div>;
  const effective = column.type === 'calculated' ? { id: column.id, name: column.name, type: column.resultType, ...(column.resultType === 'money' ? { currency: column.currency! } : {}) } : value.op === 'includes' && column.type === 'multiselect' ? { ...column, type: 'select' } : value.op === 'includes' && column.type === 'relation' ? { ...column, cardinality: 'one' } : column;
  return <fieldset className="min-w-0 space-y-2 rounded border border-line p-3"><legend className="px-1 text-sm">Condição</legend><label htmlFor={`${id}-column`} className="block text-sm">Coluna</label><Select id={`${id}-column`} value={value.columnId} onChange={(event) => onChange(emptyPredicate(table.columns.find((item) => item.id === event.target.value)!))}>{table.columns.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><label htmlFor={`${id}-operator`} className="block text-sm">Operador</label><Select id={`${id}-operator`} value={value.op} onChange={(event) => { const op = event.target.value as typeof value.op; onChange(op === 'empty' || op === 'not_empty' ? { op, columnId: value.columnId } : { op, columnId: value.columnId, value: null }); }}>{filterOperators(column).map((op) => <option key={op} value={op}>{operators[op]}</option>)}</Select>
    {value.op !== 'empty' && value.op !== 'not_empty' && <><label htmlFor={`${id}-value`} className="block text-sm">Valor</label><TableField id={`${id}-value`} column={{ ...effective, name: "Valor" } as typeof column} value={value.value} zone={zone} onChange={(next) => onChange({ ...value, value: next })} /></>}
    <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Remover condição</Button>
  </fieldset>;
}

/** Converte apenas entradas escalares do formulário; IDs/arrays/null mantêm seus tipos até a borda. */
export function presentFilter(filter: TableFilter | null | undefined, table: DataTable, zone: string): TableFilter | null {
  if (!filter) return null;
  if ('filters' in filter) return { ...filter, filters: filter.filters.map((child) => presentFilter(child, table, zone)!) };
  const column = table.columns.find((item) => item.id === filter.columnId);
  if (column && (column.type === 'datetime' || column.type === 'calculated' && column.resultType === 'datetime') && typeof filter.value === 'string') return { ...filter, value: fieldInput(column, filter.value, zone) };
  return filter;
}
/** A apresentação civil é convertida uma única vez ao contrato UTC, sem tocar em IDs de seleções. */
export function serializeFilter(filter: TableFilter | null | undefined, table: DataTable, zone: string): TableFilter | null {
  if (!filter) return null;
  if ('filters' in filter) return { ...filter, filters: filter.filters.map((child) => serializeFilter(child, table, zone)!) };
  if (filter.op === 'empty' || filter.op === 'not_empty') return filter;
  const column = table.columns.find((item) => item.id === filter.columnId);
  if (!column) return filter;
  const type = column.type === 'calculated' ? column.resultType : column.type;
  const effective = { ...column, type };
  return { ...filter, value: typeof filter.value === 'string' && !['select', 'multiselect', 'relation', 'text'].includes(type) ? parseField(effective as typeof column, filter.value, zone) : filter.value };
}

/** Guardar/atualizar/excluir usam revisão própria da vista e mantêm o rascunho em qualquer erro. */
export function ViewEditor({ table, zone, definition, view, onApply, onViewsChanged, onClose }: { table: DataTable; zone: string; definition: TableQueryDefinition; view?: TableView; onApply: (definition: TableQueryDefinition, view?: TableView) => Promise<void>; onViewsChanged: () => Promise<void>; onClose: () => void }) {
  const { csrfToken } = useSession();
  const [draft, setDraft] = useState<TableQueryDefinition>({ ...definition, columns: definition.columns ?? table.columns.map((column) => column.id), sort: definition.sort ?? [], filter: presentFilter(definition.filter, table, zone) });
  const [name, setName] = useState(view?.name ?? '');
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const busy = useRef(false);
  const [baseline] = useState(JSON.stringify({ draft, name }));
  const attempt = useRef<{ signature: string; id: string } | null>(null);
  const sortable = table.columns.filter((column) => column.type !== "multiselect" && !(column.type === "relation" && column.cardinality === "many"));
  const order = [...(draft.columns ?? []), ...table.columns.map((column) => column.id).filter((id) => !draft.columns?.includes(id))];
  /** Uma operação pode ser reenviada com a mesma identidade após falha de transporte. */
  async function submit(mode: 'apply' | 'create' | 'update' | 'delete') {
    if (busy.current) return;
    busy.current = true; setSaving(true); setError('');
    try {
      const parsed = mode === "delete" ? {} : tableQueryDefinitionSchema.parse({ ...draft, filter: serializeFilter(draft.filter, table, zone) });
      if (mode === 'apply') { await onApply(parsed, view); onClose(); return; }
      const signature = JSON.stringify({ mode, parsed, name, view });
      if (attempt.current?.signature !== signature) attempt.current = { signature, id: crypto.randomUUID() };
      const path = `/api/tables/${table.id}/views${mode !== 'create' ? `/${view!.id}` : ''}`;
      const result = await apiFetch<TableView>(path, { method: mode === 'create' ? 'POST' : mode === 'update' ? 'PUT' : 'DELETE', csrfToken, body: mode === 'delete' ? { operationId: attempt.current.id, expectedVersion: view!.version } : { ...parsed, name, operationId: attempt.current.id, ...(mode === 'update' ? { expectedVersion: view!.version } : {}) } });
      await onViewsChanged(); await onApply(mode === 'delete' ? {} : parsed, mode === 'delete' ? undefined : result); onClose();
    } catch (cause) { setError(apiErrorMessage(cause)); }
    finally { busy.current = false; setSaving(false); }
  }
  return <ConfigurationPanel title="Filtrar e organizar" dirty={baseline !== JSON.stringify({ draft, name })} busy={saving} onClose={onClose} footer={<><Button variant="secondary" disabled={saving || !name.trim()} onClick={() => void submit('create')}>Salvar como vista</Button>{view && <><Button variant="secondary" disabled={saving} onClick={() => void submit('update')}>Atualizar vista</Button><Button variant="danger" disabled={saving} onClick={() => void submit('delete')}>Excluir vista</Button></>}<Button disabled={saving} onClick={() => void submit('apply')}>{saving ? 'Aplicando…' : 'Aplicar'}</Button></>}>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <section className="space-y-3"><h3 className="font-semibold">Filtros</h3><p className="text-xs text-muted">Até 20 condições em três níveis · {predicateCount(draft.filter ?? null)} condição(ões)</p>{draft.filter ? <FilterNode value={draft.filter} table={table} zone={zone} depth={1} count={predicateCount(draft.filter)} onChange={(filter) => setDraft({ ...draft, filter })} /> : <Button variant="secondary" disabled={!table.columns.length} onClick={() => setDraft({ ...draft, filter: { op: 'and', filters: [emptyPredicate(table.columns[0]!)] } })}>Adicionar filtro</Button>}</section>
    <section className="space-y-3"><h3 className="font-semibold">Ordenação</h3>{draft.sort?.map((item, index) => <div key={index} className="space-y-2"><Select aria-label={`Coluna da ordenação ${index + 1}`} value={item.columnId} onChange={(event) => setDraft({ ...draft, sort: draft.sort!.map((entry, position) => position === index ? { ...entry, columnId: event.target.value } : entry) })}>{sortable.filter((column) => column.id === item.columnId || !draft.sort?.some((entry) => entry.columnId === column.id)).map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</Select><Select aria-label={`Direção da ordenação ${index + 1}`} value={item.direction} onChange={(event) => setDraft({ ...draft, sort: draft.sort!.map((entry, position) => position === index ? { ...entry, direction: event.target.value as 'asc' | 'desc' } : entry) })}><option value="asc">Crescente</option><option value="desc">Decrescente</option></Select><Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, sort: draft.sort!.filter((_, position) => position !== index) })}>Remover ordenação {index + 1}</Button></div>)}<Button variant="secondary" disabled={(draft.sort?.length ?? 0) >= 3 || !sortable.some((column) => !draft.sort?.some((item) => item.columnId === column.id))} onClick={() => setDraft({ ...draft, sort: [...(draft.sort ?? []), { columnId: sortable.find((column) => !draft.sort?.some((item) => item.columnId === column.id))!.id, direction: 'asc' }] })}>Adicionar ordenação</Button><p className="text-xs text-muted">Até três campos. Vazios ficam por último.</p></section>
    <section className="space-y-3"><h3 className="font-semibold">Colunas</h3>{order.map((id, index) => { const column = table.columns.find((item) => item.id === id); return column && <div key={id} className="flex flex-wrap items-center gap-2"><label className="min-w-0 flex-1 break-words text-sm"><input type="checkbox" className="mr-2" checked={draft.columns?.includes(id)} onChange={(event) => setDraft({ ...draft, columns: event.target.checked ? order.filter((value) => value === id || draft.columns?.includes(value)) : draft.columns?.filter((value) => value !== id) })} />{column.name}</label><Button size="sm" variant="ghost" aria-label={`Subir ${column.name}`} disabled={index === 0 || !draft.columns?.includes(id)} onClick={() => setDraft({ ...draft, columns: moveItem(draft.columns!, draft.columns!.indexOf(id), -1) })}>Subir</Button><Button size="sm" variant="ghost" aria-label={`Descer ${column.name}`} disabled={index >= (draft.columns?.length ?? 0) - 1 || !draft.columns?.includes(id)} onClick={() => setDraft({ ...draft, columns: moveItem(draft.columns!, draft.columns!.indexOf(id), 1) })}>Descer</Button></div>; })}</section>
    <div><label htmlFor="view-name" className="mb-1 block text-sm">Nome da vista</label><Input id="view-name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></div><p className="text-xs text-muted">Excluir uma vista remove somente a configuração. Os registros serão mantidos.</p>
  </ConfigurationPanel>;
}
