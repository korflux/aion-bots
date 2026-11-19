// Input base do kit: 36 px, fundo de superfície, borda --border-strong (a --border some contra o fundo), foco com
// anel do token --focus (global) e erro por
// `aria-invalid`. Fonte de 16 px no mobile (evita zoom automático do iOS) e 14 px no desktop.
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-base text-fg placeholder:text-subtle md:text-sm',
        'aria-[invalid=true]:border-danger disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('mb-1.5 block text-sm font-medium text-fg', className)} {...props} />;
}
