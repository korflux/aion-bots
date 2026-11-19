// Textarea base do kit, irmã do Input: mesma superfície, borda e erro por `aria-invalid`. Cresce com o conteúdo
// (`field-sizing: content`, onde o navegador suporta) até a altura máxima e então rola; sem suporte, fica na
// altura mínima e rola. Fonte de 16 px no mobile para evitar o zoom automático do iOS.
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'field-sizing-content min-h-40 max-h-[60dvh] w-full resize-y rounded-md border border-line-strong bg-surface px-3 py-2 text-base/6 text-fg placeholder:text-subtle md:text-sm/6',
        'aria-[invalid=true]:border-danger disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
