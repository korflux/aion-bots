'use client';

// Apresentação compartilhada D7: impacto vem do servidor e nenhuma confirmação é refeita automaticamente após conflito.
import type { TablePreparation } from '@aion/shared';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';

/** Cancelar recebe foco inicial; o callback só confirma a preparação concreta mostrada. */
export function DestructiveConfirmation({ preparation, busy, error, verb, onCancel, onConfirm, onRestoreFocus }: { preparation: TablePreparation; busy: boolean; error: string; verb: string; onCancel: () => void; onConfirm: () => void; onRestoreFocus?: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  return <Modal open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}><ModalContent title={`${verb} · ${preparation.impact.columnName ?? preparation.impact.tableName}`} description="Esta ação não pode ser desfeita." onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }} onCloseAutoFocus={onRestoreFocus ? (event) => { event.preventDefault(); onRestoreFocus(); } : undefined}>
    <p className="mt-4 whitespace-pre-wrap break-words text-sm">Tabela: {preparation.impact.tableName}</p><p className="mt-2 text-sm">{preparation.impact.recordCount} registro(s) afetado(s).</p>{error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}<ModalActions><Button ref={cancel} variant="secondary" disabled={busy} onClick={onCancel}>Cancelar</Button><Button variant="danger" disabled={busy || !!error} onClick={onConfirm}>{busy ? 'Confirmando…' : verb}</Button></ModalActions>
  </ModalContent></Modal>;
}
