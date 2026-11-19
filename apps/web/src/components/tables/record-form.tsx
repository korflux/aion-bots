'use client';

// Registro completo em drawer (tela cheia no celular, painel lateral no desktop).
//
// Dois modos:
//   - Novo registro: rascunho isolado com "Salvar"; o registro só existe depois de confirmar o formulário inteiro.
//   - Registro existente: edição livre como na grade, cada campo salva sozinho ao ser confirmado (sair do campo, escolher a opção, marcar a
//     seleção múltipla ou aplicar a relação), com a revisão do registro (`expectedVersion`) e sem botão de salvar. "Fechar" grava o que ainda
//     estiver pendente antes de sair. Conflito preserva o texto digitado e oferece recarregar, sem sobrescrever a outra sessão.
import type { DataTable, TableCell, TableRecord, TableWrite } from '@aion/shared';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { ApiError, apiErrorMessage, apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { TableField } from './field';
import { fieldInput, parseField } from './values';
import { DestructiveAction } from './destructive-action';

/** Valores de formulário mantêm strings de entrada; apenas campos realmente alterados entram no patch. */
export function recordDraft(table: DataTable, record: TableRecord | null, zone: string): Record<string, TableCell> {
  return Object.fromEntries(table.columns.map((column) => [column.id, column.type === 'relation' || column.type === 'multiselect' || column.type === 'calculated' ? record?.values[column.id] ?? null : fieldInput(column, record?.values[column.id], zone)]));
}
/** Patch preserva campos omitidos e texto vazio existente; criação só ocorre depois de validar o formulário. */
export function draftPatch(table: DataTable, draft: Record<string, TableCell>, baseline: Record<string, TableCell>, zone: string, creating: boolean): Record<string, TableCell> {
  const result: Record<string, TableCell> = {};
  for (const column of table.columns) {
    if (column.type === 'calculated' || !creating && JSON.stringify(draft[column.id]) === JSON.stringify(baseline[column.id])) continue;
    const value = draft[column.id] ?? null;
    result[column.id] = column.type === 'relation' || column.type === 'multiselect' ? value : parseField(column, typeof value === 'string' ? value : String(value ?? ''), zone);
  }
  return result;
}

/** Drawer usa a variante fullscreen apenas neste editor; fechamento com rascunho pendente grava (existente) ou pede descarte (novo). */
export function RecordForm({ table, record, zone, onClose, onSaved, onReload }: { table: DataTable; record: TableRecord | null; zone: string; onClose: () => void; onSaved: () => Promise<void>; onReload: () => Promise<void> }) {
  const { csrfToken } = useSession();
  const creating = record === null;
  const [baseline, setBaselineState] = useState(() => recordDraft(table, record, zone));
  const [draft, setDraftState] = useState(baseline);
  // Cópias síncronas: blur, escolha e "Fechar" podem acontecer na mesma volta de eventos.
  const baselineRef = useRef(baseline);
  const draftRef = useRef(draft);
  const setBaseline = (next: Record<string, TableCell>) => { baselineRef.current = next; setBaselineState(next); };
  const setDraft = (next: Record<string, TableCell>) => { draftRef.current = next; setDraftState(next); };
  /** Revisão atual do registro existente; cada gravação automática devolve a próxima. */
  const version = useRef(record?.version ?? 0);
  /** Houve gravação automática: a grade é relida ao fechar. */
  const changed = useRef(false);
  /** Gravação em andamento, aguardada por "Fechar" antes de sair. */
  const inflight = useRef<Promise<boolean> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [conflict, setConflict] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const busy = useRef(false);
  const attempt = useRef<{ signature: string; id: string } | null>(null);
  const opener = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.activeElement as HTMLElement);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  /** Criação: mesmo rascunho reaproveita o recibo em uma repetição após falha de rede. */
  async function save() {
    if (busy.current) return;
    setError('');
    let values: Record<string, TableCell>;
    try { values = draftPatch(table, draftRef.current, baselineRef.current, zone, creating); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Confira os campos.'); return; }
    const signature = JSON.stringify(values);
    if (attempt.current?.signature !== signature) attempt.current = { signature, id: crypto.randomUUID() };
    const body: TableWrite = { operationId: attempt.current.id, expectedSchemaVersion: table.schemaVersion, creates: [{ values }], updates: [] };
    busy.current = true; setSaving(true);
    try { await apiFetch(`/api/tables/${table.id}/records`, { method: 'POST', csrfToken, body }); await onSaved(); onClose(); }
    catch (cause) { setError(apiErrorMessage(cause)); setConflict(cause instanceof ApiError && cause.code === 'TABLE_CONFLICT'); }
    finally { busy.current = false; setSaving(false); }
  }
  /**
   * Registro existente: grava os campos alterados (normalmente um só, o recém-confirmado). Devolve falso quando a gravação falhou, para
   * "Fechar" não sair com o texto do dono ainda não salvo.
   */
  function commit(): Promise<boolean> {
    if (!record || conflict) return Promise.resolve(!conflict);
    if (inflight.current) return inflight.current.then(() => commit());
    let values: Record<string, TableCell>;
    try { values = draftPatch(table, draftRef.current, baselineRef.current, zone, false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Confira os campos.'); return Promise.resolve(false); }
    if (Object.keys(values).length === 0) return Promise.resolve(true);
    const sent = draftRef.current;
    setError(''); setStatus(''); busy.current = true; setSaving(true);
    const run = (async () => {
      try {
        const body: TableWrite = { operationId: crypto.randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [], updates: [{ id: record.id, expectedVersion: version.current, values }] };
        const result = await apiFetch<{ records: TableRecord[] }>(`/api/tables/${table.id}/records`, { method: 'POST', csrfToken, body });
        const updated = result.records.find((item) => item.id === record.id);
        if (updated) version.current = updated.version;
        // Os campos enviados viram a nova base; calculadas são atualizadas com o que o servidor recalculou.
        const nextBaseline = { ...baselineRef.current, ...Object.fromEntries(Object.keys(values).map((id) => [id, sent[id] ?? null])) };
        const calculated = Object.fromEntries(table.columns.filter((column) => column.type === 'calculated').map((column) => [column.id, updated?.values[column.id] ?? null]));
        setBaseline({ ...nextBaseline, ...calculated });
        setDraft({ ...draftRef.current, ...calculated });
        changed.current = true; setStatus('Alterações salvas.');
        return true;
      } catch (cause) { setError(apiErrorMessage(cause)); setConflict(cause instanceof ApiError && cause.code === 'TABLE_CONFLICT'); return false; }
      finally { busy.current = false; setSaving(false); inflight.current = null; }
    })();
    inflight.current = run;
    return run;
  }
  /** Altera um campo; seleção, Sim/Não, seleção múltipla e relação gravam na escolha (texto e números gravam ao sair do campo). */
  function change(columnId: string, value: TableCell, immediate: boolean) {
    setDraft({ ...draftRef.current, [columnId]: value });
    if (immediate) void commit();
  }
  /** Existente: grava o pendente e fecha (relendo a grade se algo mudou). Novo: rascunho sujo pede descarte. Nunca fecha durante a criação. */
  async function requestClose() {
    if (creating) { if (!busy.current) { if (dirty) setDiscard(true); else onClose(); } return; }
    if (conflict) { if (dirty) setDiscard(true); else onClose(); return; }
    if (!await commit()) return;
    if (changed.current) await onSaved();
    onClose();
  }
  return <>
    <Drawer open onOpenChange={(open) => { if (!open) void requestClose(); }}>
      <DrawerContent size="record" title={creating ? 'Novo registro' : 'Editar registro'} onCloseAutoFocus={(event) => { event.preventDefault(); (opener.current?.isConnected ? opener.current : document.getElementById("table-new-record"))?.focus(); }}>
        <header className="border-b border-line px-4 py-3 md:px-6"><h2 className="text-lg font-semibold">{creating ? 'Novo registro' : 'Editar registro'}</h2><p className="mt-0.5 break-words text-sm text-muted">{table.name}{creating ? '' : ' · As alterações são salvas ao sair de cada campo.'}</p></header>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); if (creating) void save(); else void commit(); }}>
          <div className="flex-1 space-y-4 overflow-y-auto p-4 md:p-6">{table.columns.map((column) => {
            const immediate = column.type === 'select' || column.type === 'boolean' || column.type === 'multiselect' || column.type === 'relation';
            return <div key={column.id} onBlur={(event) => { if (!creating && !immediate && !event.currentTarget.contains(event.relatedTarget as Node | null)) void commit(); }}>
              <label htmlFor={`record-${column.id}`} className="mb-1 block break-words text-sm font-medium">{column.name}</label>
              <TableField id={`record-${column.id}`} column={column} columns={table.columns} value={draft[column.id]} zone={zone} disabled={(creating && saving) || conflict} onChange={(value) => change(column.id, value, !creating && immediate)} />
              {record?.errors?.[column.id] ? <p className="mt-1 text-sm text-danger">Não foi possível calcular este campo.</p> : null}
            </div>;
          })}
            {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
            {conflict ? <div className="space-y-2 text-sm"><p>Seu rascunho foi preservado. Recarregue os dados para começar uma nova edição.</p><Button variant="secondary" onClick={() => setDiscard(true)}>Recarregar dados</Button></div> : null}
          </div>
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 md:px-6">
            {creating ? <>
              <Button variant="secondary" disabled={saving} onClick={() => void requestClose()}>Cancelar</Button>
              <Button type="submit" disabled={saving || conflict} aria-busy={saving}>{saving ? 'Salvando…' : 'Salvar'}</Button>
            </> : <>
              <p role="status" className="mr-auto text-xs text-muted">{saving ? 'Salvando…' : status}</p>
              <Button variant="danger" disabled={saving || dirty} onClick={() => setDeleting(true)}>Excluir registro</Button>
              <Button type="button" onClick={() => void requestClose()}>Fechar</Button>
            </>}
          </footer>
        </form>
      </DrawerContent>
    </Drawer>
    {deleting && record && <DestructiveAction table={table} target={{ kind: "delete_records", recordIds: [record.id] }} verb="Excluir registro" onClose={() => setDeleting(false)} onDone={async () => { await onSaved(); onClose(); }} />}
    <Modal open={discard} onOpenChange={setDiscard}><ModalContent title="Descartar alterações?" description="As alterações que ainda não foram salvas serão descartadas."><ModalActions><Button variant="secondary" onClick={() => setDiscard(false)}>Continuar editando</Button><Button variant="danger" onClick={() => { setDiscard(false); onClose(); if (conflict) void onReload(); else if (changed.current) void onSaved(); }}>Descartar alterações</Button></ModalActions></ModalContent></Modal>
  </>;
}
