'use client';

// Popover do kit (design.md: "Popover: seletor de modelo e menus de ações"), sobre o Popover do Radix: fecha com Esc e
// ao clicar fora, devolve o foco ao gatilho e posiciona sozinho (vira para o outro lado se não couber). Superfície
// `--bg-surface` com raio `--radius-lg`, borda e a sombra única do design; abre com `scale(0.97)` e `opacity`, a partir
// do gatilho (`transform-origin` do Radix).
import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({ className, sideOffset = 8, align = 'start', ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-lg border border-line bg-surface grad-sheen shadow-float',
          'animate-[popover-in_150ms_var(--ease-out)]',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
