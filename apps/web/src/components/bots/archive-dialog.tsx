'use client';

// Modal de confirmação de arquivamento (design: Editor do bot, zona de arquivamento). Sobre o Dialog do Radix:
// foco preso, Esc e toque fora fecham. O botão que abre (`children`) é o `Trigger` do Radix de propósito: é ele
// que o Radix usa para devolver o foco ao fechar; sem um Trigger o foco se perderia no <body>. O foco inicial cai
// em "Cancelar", a ação segura. Centralizado por `inset-0 m-auto` (sem `translate`), para a entrada poder usar só
// `scale` + `opacity` (design: física), reaproveitando o keyframe do tooltip.
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { LoaderCircle } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';

interface ArchiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  botName: string;
  busy: boolean;
  onConfirm: () => void;
  /** O botão "Arquivar bot" que abre o modal (vira o Trigger do Radix). */
  children: ReactElement;
}

export function ArchiveDialog({ open, onOpenChange, botName, busy, onConfirm, children }: ArchiveDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogPrimitive.Trigger asChild>{children}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 data-[state=closed]:animate-[overlay-out_150ms_var(--ease-out)_forwards] data-[state=open]:animate-[overlay-in_200ms_var(--ease-out)]" />
        <DialogPrimitive.Content className="fixed inset-0 z-50 m-auto h-fit w-[calc(100vw-32px)] max-w-[440px] animate-[tooltip-in_200ms_var(--ease-out)] rounded-lg border border-line bg-surface grad-sheen p-6 shadow-float">
          <DialogPrimitive.Title className="text-[18px]/[26px] font-semibold text-fg">Arquivar este bot?</DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-sm text-muted [overflow-wrap:anywhere]">
            <strong className="font-medium text-fg">{botName}</strong> sai da lista principal e vai para Arquivados. As rotinas deste bot serão
            pausadas. A conversa e a memória são preservadas, e você pode desarquivar depois.
          </DialogPrimitive.Description>
          <div className="mt-6 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button variant="secondary" disabled={busy}>
                Cancelar
              </Button>
            </DialogPrimitive.Close>
            <Button variant="danger" className="border border-danger/40" onClick={onConfirm} disabled={busy}>
              {busy ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" strokeWidth={1.5} aria-hidden /> : null}
              Arquivar
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
