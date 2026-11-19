// Select nativo do kit, irmão do Input: mesma altura, borda, foco e erro por `aria-invalid`. Nativo de propósito: teclado, leitor de
// tela e o seletor do celular vêm prontos (as listas curtas do editor de rotina não precisam de um popover próprio).
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-9 w-full rounded-md border border-line-strong bg-surface px-2.5 text-base text-fg md:text-sm',
        'aria-[invalid=true]:border-danger disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
