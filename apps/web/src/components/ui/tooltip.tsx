'use client';

// Tooltip do kit sobre Radix (acessível por teclado e leitor de tela). Aparece após 400 ms, como no design,
// e usa só transform/opacity com origem no gatilho.
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export const TooltipProvider = ({ delayDuration = 400, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
);
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({ className, sideOffset = 8, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 origin-(--radix-tooltip-content-transform-origin) rounded-sm border border-line bg-surface px-2 py-1 text-xs font-medium text-fg',
          'animate-[tooltip-in_150ms_var(--ease-out)]',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
