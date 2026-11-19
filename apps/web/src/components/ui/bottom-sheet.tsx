'use client';

// Drawer inferior do kit (design.md: "Seletor de modelo e popovers grandes viram drawer inferior no mobile", com 70 dvh
// de altura), sobre o Dialog do Radix: foco preso, fecha com Esc e ao tocar fora, devolve o foco ao gatilho. Sobe por
// `transform` (250 ms, --ease-drawer) e respeita a safe area. O conteúdo é uma coluna: quem usa decide o que fica
// fixo no topo e na base e o que rola.
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const BottomSheet = DialogPrimitive.Root;
export const BottomSheetTrigger = DialogPrimitive.Trigger;
export const BottomSheetClose = DialogPrimitive.Close;

export interface BottomSheetContentProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  /** Nome acessível do drawer (leitores de tela anunciam); não é exibido. */
  title: string;
  children: ReactNode;
}

export function BottomSheetContent({ title, className, children, ...props }: BottomSheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 data-[state=closed]:animate-[overlay-out_150ms_var(--ease-out)_forwards] data-[state=open]:animate-[overlay-in_200ms_var(--ease-out)]" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex h-[70dvh] flex-col overflow-hidden rounded-t-lg border-t border-line bg-surface grad-sheen pb-[env(safe-area-inset-bottom)]',
          'data-[state=closed]:animate-[sheet-out_200ms_var(--ease-drawer)_forwards] data-[state=open]:animate-[sheet-in_250ms_var(--ease-drawer)]',
          className,
        )}
        {...props}
      >
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
