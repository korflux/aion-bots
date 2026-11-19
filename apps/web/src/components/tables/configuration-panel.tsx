'use client';

// Casca única dos editores D3/D4: ações fixas, conteúdo rolável e confirmação antes de perder um rascunho.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';

/** Guarda o ponto de abertura e protege fechar/Escape/recarregar quando há alterações locais. */
export function ConfigurationPanel({ title, dirty, busy, wide, children, footer, onClose }: { title: string; dirty: boolean; busy: boolean; wide?: boolean; children: ReactNode; footer: ReactNode; onClose: () => void }) {
  const [discard, setDiscard] = useState(false);
  const opener = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.activeElement as HTMLElement);
  useEffect(() => {
    if (!dirty) return;
    /** Saída do documento também respeita o rascunho, além do fechamento do drawer. */
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  /** Operações em andamento não fecham; as demais só descartam com escolha explícita. */
  function close() { if (busy) return; if (dirty) setDiscard(true); else onClose(); }
  return <><Drawer open onOpenChange={(open) => { if (!open) close(); }}><DrawerContent title={title} size={wide ? 'structure' : 'record'} onCloseAutoFocus={(event) => { event.preventDefault(); opener.current?.focus(); }}>
    <header className="flex items-center justify-between gap-3 border-b border-line p-4"><h2 className="min-w-0 break-words text-lg font-semibold">{title}</h2><Button size="sm" variant="ghost" disabled={busy} onClick={close}>Fechar</Button></header>
    <div className="min-h-0 flex-1 overflow-y-auto p-4"><fieldset disabled={busy} className="min-w-0 space-y-5">{children}</fieldset></div>
    <footer className="flex flex-wrap justify-end gap-2 border-t border-line p-4"><Button variant="secondary" disabled={busy} onClick={close}>Cancelar</Button>{footer}</footer>
  </DrawerContent></Drawer><Modal open={discard} onOpenChange={setDiscard}><ModalContent title="Descartar alterações?" description="A configuração ainda não foi salva."><ModalActions><Button variant="secondary" onClick={() => setDiscard(false)}>Continuar editando</Button><Button variant="danger" onClick={onClose}>Descartar alterações</Button></ModalActions></ModalContent></Modal></>;
}
