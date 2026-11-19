'use client';

// Modal do kit (design.md: "popup de confirmação e de ativação do TOTP, largura máxima de 440 px e ações à direita"),
// sobre o Dialog do Radix: foco preso, fecha com Esc e ao tocar fora. Centralizado, com gutter de 16 px em telas
// estreitas e rolagem interna se a altura não couber (celular deitado).
//
// Foco ao fechar: o Radix só devolve o foco ao `Dialog.Trigger`, e este modal é CONTROLADO (o botão que o abre só
// muda um estado, não é um Trigger). Por isso `Modal` guarda o elemento que tinha o foco no momento de abrir e
// `ModalContent` o refoca ao fechar. Sem isso o foco cairia no <body> e quem navega por teclado perderia a posição.
// Quem for focar um campo ao abrir deve usar `onOpenAutoFocus` (não `autoFocus`): com `autoFocus` o Radix enxerga o
// próprio campo como o "foco anterior" e nada volta ao botão de origem.
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { createContext, useContext, useLayoutEffect, useRef, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/cn';

const OpenerContext = createContext<RefObject<HTMLElement | null> | null>(null);

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

export function Modal({ open, onOpenChange, children }: ModalProps) {
  const opener = useRef<HTMLElement | null>(null);
  // Roda na abertura, antes de o Radix mover o foco para dentro (o efeito dele é passivo e vem depois).
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  return (
    <OpenerContext value={opener}>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        {children}
      </DialogPrimitive.Root>
    </OpenerContext>
  );
}

export interface ModalContentProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  /** Título visível e nome acessível do diálogo. */
  title: string;
  /** Texto curto abaixo do título; vira a descrição acessível. Sem ele o diálogo não declara descrição. */
  description?: string;
  /** Elemento decorativo à esquerda do título (a Faísca do bot dormindo no popup de exclusão). Não entra no nome acessível do diálogo. */
  leading?: ReactNode;
  children: ReactNode;
}

export function ModalContent({ title, description, leading, className, children, onCloseAutoFocus, ...props }: ModalContentProps) {
  const opener = useContext(OpenerContext);
  // `min-w-0` deixa o título quebrar linha ao lado do elemento `leading` (item de flex); fora de um flex não tem efeito.
  const heading = <DialogPrimitive.Title className="min-w-0 text-[18px]/[26px] font-semibold text-fg">{title}</DialogPrimitive.Title>;
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 data-[state=closed]:animate-[overlay-out_150ms_var(--ease-out)_forwards] data-[state=open]:animate-[overlay-in_200ms_var(--ease-out)]" />
      <DialogPrimitive.Content
        // Sem descrição, declara `aria-describedby` vazio (o Radix avisa no console quando não há nenhum dos dois).
        {...(description ? {} : { 'aria-describedby': undefined })}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          // Devolve o foco a quem abriu o modal (ver o comentário do arquivo).
          event.preventDefault();
          opener?.current?.focus();
        }}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto',
          'rounded-lg border border-line bg-surface grad-sheen p-6 shadow-float',
          'data-[state=closed]:animate-[overlay-out_150ms_var(--ease-out)_forwards] data-[state=open]:animate-[overlay-in_200ms_var(--ease-out)]',
          className,
        )}
        {...props}
      >
        {leading ? (
          <div className="flex items-center gap-3">
            <span className="shrink-0">{leading}</span>
            {heading}
          </div>
        ) : (
          heading
        )}
        {description ? (
          <DialogPrimitive.Description className="mt-1 text-sm text-muted">{description}</DialogPrimitive.Description>
        ) : null}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** Linha de ações do rodapé, alinhada à direita (Cancelar à esquerda da ação principal). */
export function ModalActions({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-6 flex justify-end gap-2', className)} {...props} />;
}
