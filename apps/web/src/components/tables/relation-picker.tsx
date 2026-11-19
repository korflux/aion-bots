'use client';

// Relação é um rascunho local: aplicar não escreve no banco; a gravação do registro revalida os alvos.
import type { DataTable, TableCell, TableColumn, TableQuery, TableQueryResult, TableRecord, TableRecordLookup } from '@aion/shared';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { recordLabel } from './values';

/** Popup paginado com seleção independente da página e foco devolvido ao campo de origem. */
export function RelationPicker({ column, value, zone, onApply, onClose }: { column: Extract<TableColumn, { type: 'relation' }>; value: TableCell | undefined; zone: string; onApply: (value: TableCell) => void; onClose: () => void }) {
  const { csrfToken } = useSession();
  const [table, setTable] = useState<DataTable | null>(null);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [rows, setRows] = useState<TableRecord[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [initialSelected] = useState<string[]>(value === null || value === undefined ? [] : Array.isArray(value) ? value : [String(value)]);
  const [selected, setSelected] = useState(initialSelected);
  const [missing, setMissing] = useState<string[]>([]);
  const lookup = useRef<Promise<TableRecord[]> | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (search === term) return;
    const timer = window.setTimeout(() => { setTerm(search); setCursors([undefined]); }, 250);
    return () => window.clearTimeout(timer);
  }, [search, term]);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError('');
      try {
        const definition = await apiFetch<DataTable>(`/api/tables/${column.targetTableId}`);
        const textColumns = definition.columns.filter((item) => item.type === 'text').map((item) => item.id);
        // ponytail: busca textual usa até 20 campos pelo teto de filtros; ampliar o contrato de busca se tabelas reais precisarem pesquisar mais campos simultaneamente.
        const body: TableQuery = { limit: 20, ...(cursors.at(-1) ? { cursor: cursors.at(-1) } : {}), columns: textColumns, ...(term && textColumns.length ? { filter: { op: 'or', filters: textColumns.slice(0, 20).map((columnId) => ({ op: 'contains', columnId, value: term })) } } : {}) };
        // Só os IDs da seleção inicial são relidos; o teto UTF-8 pode gerar várias páginas, sem cortar nenhum nome.
        if (initialSelected.length && !lookup.current) lookup.current = (async () => {
          const selectedRows: TableRecord[] = [];
          let cursor: string | null = null;
          do {
            const lookupBody: TableRecordLookup = { ids: initialSelected, columns: textColumns, limit: 100, ...(cursor ? { cursor } : {}) };
            const found = await apiFetch<TableQueryResult>(`/api/tables/${column.targetTableId}/records/lookup`, { method: 'POST', csrfToken, body: lookupBody });
            selectedRows.push(...found.records); cursor = found.nextCursor;
          } while (cursor);
          return selectedRows;
        })();
        const [result, selectedRows] = await Promise.all([apiFetch<TableQueryResult>(`/api/tables/${column.targetTableId}/query`, { method: 'POST', csrfToken, body }), lookup.current ?? Promise.resolve([])]);
        if (cancelled) return;
        setTable(definition); setRows(result.records); setNext(result.nextCursor);
        setMissing(initialSelected.filter((id) => !selectedRows.some((record) => record.id === id)));
        setLabels((current) => ({ ...current, ...Object.fromEntries([...selectedRows, ...result.records].map((record) => [record.id, recordLabel(definition.columns, record, zone)])) }));
      } catch (cause) { if (!cancelled) setError(apiErrorMessage(cause)); }
      finally { if (!cancelled) setLoading(false); }
    }
    void load();
    return () => { cancelled = true; };
  }, [column.targetTableId, csrfToken, cursors, initialSelected, retry, term, zone]);
  /** Toggle mantém os IDs fora da página e respeita o máximo comum do contrato. */
  function choose(id: string) {
    setSelected((current) => column.cardinality === 'one' ? [id] : current.includes(id) ? current.filter((item) => item !== id) : current.length < 100 ? [...current, id] : current);
  }
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }}>
    <ModalContent title={table?.name ?? 'Selecionar registros'} description={column.cardinality === 'one' ? 'Selecione um registro relacionado.' : 'Selecione até 100 registros relacionados.'} onKeyDown={(event) => event.stopPropagation()}>
      <label className="mt-4 block text-sm" htmlFor="relation-search">Buscar registros</label>
      <Input id="relation-search" className="mt-1" value={search} onChange={(event) => setSearch(event.target.value)} disabled={table !== null && !table.columns.some((item) => item.type === 'text')} />
      <div className="mt-3 max-h-[35dvh] overflow-y-auto" aria-busy={loading}>
        {loading ? <p role="status" className="py-4 text-sm text-muted">Carregando registros…</p> : error ? <div><p role="alert">{error}</p><Button variant="secondary" onClick={() => { lookup.current = null; setRetry((current) => current + 1); }}>Tentar novamente</Button></div> : rows.length === 0 ? <p className="py-4 text-sm text-muted">{term ? 'Nenhum registro encontrado.' : 'Esta tabela ainda não tem registros.'}</p> : rows.map((record) => <label key={record.id} className="flex min-h-11 items-start gap-3 border-b border-line py-3">
          <input className="mt-1 size-4 shrink-0 accent-primary" type={column.cardinality === 'one' ? 'radio' : 'checkbox'} name="relation-choice" checked={selected.includes(record.id)} disabled={column.cardinality === 'many' && selected.length === 100 && !selected.includes(record.id)} onChange={() => choose(record.id)} />
          <span className="min-w-0 break-words text-sm"><span className="block whitespace-pre-wrap">{labels[record.id]}</span><span className="text-xs text-muted">{record.id}</span></span>
        </label>)}
      </div>
      <div className="mt-3 flex justify-between gap-2"><Button variant="secondary" size="sm" disabled={loading || cursors.length === 1} onClick={() => setCursors((current) => current.slice(0, -1))}>Anterior</Button><Button variant="secondary" size="sm" disabled={loading || !next} onClick={() => setCursors((current) => [...current, next!])}>Próxima</Button></div>
      <p className="mt-4 text-sm" role="status">{selected.length} selecionado(s){selected.length === 100 ? ' · Limite atingido' : ''}</p>
      <ul className="mt-2 max-h-28 overflow-y-auto space-y-2">{selected.map((id) => <li key={id} className="flex items-start justify-between gap-2 text-sm"><span className="min-w-0 break-words">{missing.includes(id) ? `Registro indisponível #${id}` : labels[id] ?? `Registro #${id}`}</span><Button size="sm" variant="ghost" aria-label={`Remover ${labels[id] ?? `registro ${id}`}`} onClick={() => setSelected((current) => current.filter((item) => item !== id))}>Remover</Button></li>)}</ul>
      {selected.some((id) => missing.includes(id)) && <p role="alert" className="mt-2 text-sm">Remova os registros indisponíveis para aplicar a seleção.</p>}
      <ModalActions><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button disabled={loading || !!error || selected.some((id) => missing.includes(id))} onClick={() => { onApply(selected.length === 0 ? null : column.cardinality === 'one' ? selected[0]! : selected); onClose(); }}>Aplicar</Button></ModalActions>
    </ModalContent>
  </Modal>;
}
