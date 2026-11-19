'use client';

// Prepara uma operação concreta, mostra impacto/impedimentos e confirma uma única vez. Conflito não dispara repetição automática.
import type { DataTable, TableDependencies, TableDestructive, TablePreparation, TableQueryResult } from '@aion/shared';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { ApiError, apiErrorMessage, apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { DestructiveConfirmation } from './destructive-confirmation';

type Target = { kind: 'delete_table' } | { kind: 'delete_column'; columnId: string } | { kind: 'delete_records'; recordIds: string[] };
/** Cada abertura explícita lê a revisão atual e prepara o alvo escolhido, sem aproveitar impacto antigo. */
export function DestructiveAction({ table, target, verb, onClose, onDone }: { table: DataTable; target: Target; verb: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [fixedTarget] = useState(target);
  const opener = useRef<HTMLElement | null>(typeof document === "undefined" ? null : document.activeElement as HTMLElement);
  const { csrfToken } = useSession(); const [preparation, setPreparation] = useState<TablePreparation | null>(null);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [dependencies, setDependencies] = useState<TableDependencies | null>(null);
  const operation = useRef<TableDestructive | null>(null); const operationId = useRef(crypto.randomUUID()); const cancel = useRef<HTMLButtonElement>(null); const working = useRef(false);
  useEffect(() => { let cancelled = false;
    async function prepare() { try {
      const current = await apiFetch<DataTable>(`/api/tables/${table.id}`);
      const found = fixedTarget.kind === 'delete_records' ? await apiFetch<TableQueryResult>(`/api/tables/${table.id}/records/lookup`, { method: 'POST', csrfToken, body: { ids: fixedTarget.recordIds, columns: [] } }) : null;
      if (found && found.records.length !== (fixedTarget.kind === 'delete_records' ? fixedTarget.recordIds.length : 0)) throw new Error('Registro removido. Recarregue os dados.');
      const definition: TableDestructive = fixedTarget.kind === 'delete_records' ? { kind: fixedTarget.kind, expectedVersion: current.version, records: found!.records.map((row) => ({ id: row.id, expectedVersion: row.version })) } : { ...fixedTarget, expectedVersion: current.version };
      operation.current = definition;
      try { const prepared = await apiFetch<TablePreparation>(`/api/tables/${table.id}/operations/prepare`, { method: 'POST', csrfToken, body: definition }); if (!cancelled) setPreparation(prepared); }
      catch (cause) { if (cause instanceof ApiError && cause.code === 'TABLE_DEPENDENCY') { const result = await apiFetch<TableDependencies>(`/api/tables/${table.id}/dependencies`, { method: 'POST', csrfToken, body: { operation: definition } }); if (!cancelled) setDependencies(result); } throw cause; }
    } catch (cause) { if (!cancelled) setError(apiErrorMessage(cause)); } finally { if (!cancelled) setLoading(false); } }
    void prepare(); return () => { cancelled = true; };
    // O alvo fica fixo durante este popup; uma nova abertura é a única forma de refazer a preparação.
  }, [table.id, csrfToken, fixedTarget]);
  /** Página adicional conserva todos os impedimentos já apresentados e continua sujeita à revisão do servidor. */
  async function more() { setBusy(true); try { const result = await apiFetch<TableDependencies>(`/api/tables/${table.id}/dependencies`, { method: 'POST', csrfToken, body: { operation: operation.current, cursor: dependencies!.nextCursor } }); setDependencies((current) => ({ dependencies: [...current!.dependencies, ...result.dependencies], nextCursor: result.nextCursor })); } catch (cause) { setError(apiErrorMessage(cause)); } finally { setBusy(false); } }
  /** O recibo permanece para rede perdida, mas o popup nunca reenvia confirmação após erro. */
  async function confirm() { if (!preparation || working.current) return; working.current = true; setBusy(true);
    try { await apiFetch(`/api/tables/${table.id}/operations/confirm`, { method: 'POST', csrfToken, body: { preparationId: preparation.preparationId, operationId: operationId.current, confirmation: true } }); await onDone(); onClose(); }
    catch (cause) { setError(apiErrorMessage(cause)); } finally { working.current = false; setBusy(false); }
  }
  return preparation ? <DestructiveConfirmation preparation={preparation} verb={verb} busy={busy} error={error} onCancel={onClose} onRestoreFocus={() => { if (opener.current?.isConnected) opener.current.focus(); }} onConfirm={() => void confirm()} /> : <Modal open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><ModalContent title={verb} description="Esta ação não pode ser desfeita." onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}>
    <p className="mt-4 whitespace-pre-wrap break-words text-sm">Tabela: {table.name}</p>{loading ? <p role="status" className="mt-3 text-sm">Preparando impacto…</p> : <><p role="alert" className="mt-3 text-sm text-danger">{error}</p>{dependencies && <section className="mt-4 space-y-3 text-sm"><h3 className="font-semibold">Impedimentos</h3><p>Nenhum vínculo, coluna ou vista será removido automaticamente.</p><ul className="space-y-3">{dependencies.dependencies.map((item, index) => <li key={`${item.kind}:${index}`} className="break-words"><Link href={`/configuracoes/tabelas/${item.tableId}`} className="underline">{item.tableName}</Link> · {item.kind === 'view' ? 'Vista' : item.kind === 'formula' ? 'Coluna calculada' : 'Relação'}: {item.name}</li>)}</ul>{dependencies.nextCursor !== null && <Button variant="secondary" disabled={busy} onClick={() => void more()}>Mais impedimentos</Button>}</section>}</>}
    <ModalActions><Button ref={cancel} variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button><Button variant="danger" disabled>{verb}</Button></ModalActions>
  </ModalContent></Modal>;
}
