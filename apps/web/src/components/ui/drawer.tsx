'use client';

// Drawer do kit, sobre o Dialog do Radix: foco preso, fecha com Esc e ao tocar fora. Entra pela direita.
// Histórico mantém largura limitada a 90 vw; registro usa 480 px no desktop e tela inteira no celular. Entra por
// transform (250 ms, --ease-drawer) e respeita safe area. Fundo `bg-panel` com `grad-panel` (identidade: painel, drawer e barra inferior; a camada vem do utilitário único).
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const Drawer = DialogPrimitive.Root;
/** Gatilho: é ele que o Radix usa para devolver o foco ao fechar (Esc, toque fora ou escolha de item). */
export const DrawerTrigger = DialogPrimitive.Trigger;

export interface DrawerContentProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  /** Nome acessível do diálogo (leitores de tela anunciam); não é exibido. */
  title: string;
  /** Configurações/registro ocupam o celular inteiro (480/560 px no desktop); defaults antigos são preservados. */
  size?: 'default' | 'record' | 'structure';
  children: ReactNode;
}

/** Histórico lateral com título acessível, safe area e animação de entrada e saída definida no CSS comum. */
export function DrawerContent({ title, size = 'default', className, children, ...props }: DrawerContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 data-[state=closed]:animate-[overlay-out_150ms_var(--ease-out)_forwards] data-[state=open]:animate-[overlay-in_200ms_var(--ease-out)]" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(
          'fixed inset-y-0 z-50 flex max-w-[90vw] bg-panel grad-panel pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]',
          'right-0 pr-[env(safe-area-inset-right)] data-[state=closed]:animate-[drawer-out-right_200ms_var(--ease-drawer)_forwards] data-[state=open]:animate-[drawer-in-right_250ms_var(--ease-drawer)]',
          size === 'record' && 'h-dvh w-full max-w-full flex-col md:w-[480px] md:max-w-[90vw]',
          size === 'structure' && 'h-dvh w-full max-w-full flex-col md:w-[560px] md:max-w-[90vw]',
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
