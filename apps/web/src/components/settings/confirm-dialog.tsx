'use client';

// Modal de confirmação do kit (design.md: largura máxima de 440 px, ações à direita, raio --radius-lg, sombra
// única), sobre o Dialog do Radix: foco preso, Esc fecha, nome e descrição acessíveis. Usado para "Desconectar", "Excluir" e "Remover". Título e descrição quebram palavra longa
// (o nome de uma rotina ou de uma conta pode ter 40 caracteres sem espaço e não pode estourar o modal em 375 px).
// Controlado por quem abre; `onCloseAutoFocus` deixa o chamador decidir para onde o foco volta (o botão que abriu
// pode já não existir depois de confirmar).
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Texto do botão de confirmação (sempre com texto, regra de ícone do design). */
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  onConfirm,
  onCloseAutoFocus,
}: ConfirmDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 data-[state=open]:animate-[overlay-in_200ms_var(--ease-out)]" />
        <DialogPrimitive.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface grad-sheen p-6 shadow-float data-[state=open]:animate-[tooltip-in_200ms_var(--ease-out)]"
        >
          <DialogPrimitive.Title className="break-words text-[18px]/[26px] font-semibold text-fg">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 break-words text-sm text-muted">{description}</DialogPrimitive.Description>
          <div className="mt-6 flex flex-col justify-end gap-2 md:flex-row">
            <DialogPrimitive.Close asChild>
              <Button variant="secondary" disabled={pending}>
                Cancelar
              </Button>
            </DialogPrimitive.Close>
            <Button variant="danger" onClick={onConfirm} disabled={pending}>
              {pending ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" aria-hidden /> : null}
              {confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
