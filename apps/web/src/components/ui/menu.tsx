'use client';

// Menu de ações do kit (design.md: "menus de ações"), sobre o DropdownMenu do Radix: abre por clique, Enter, Espaço ou
// seta para baixo, navega por setas, fecha com Esc e devolve o foco ao gatilho. Mesma superfície do popover.
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/** Menu não modal: mantém a página acessível sem aria-hidden em controles focáveis; Radix continua gerindo setas, Esc e retorno ao gatilho. */
export function Menu(props: ComponentProps<typeof MenuPrimitive.Root>) {
  return <MenuPrimitive.Root modal={false} {...props} />;
}
export const MenuTrigger = MenuPrimitive.Trigger;

/** Superfície flutuante em portal com os tokens e a animação comuns aos menus de ação. */
export function MenuContent({ className, sideOffset = 4, align = 'end', ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-[60] min-w-40 origin-(--radix-dropdown-menu-content-transform-origin) rounded-md border border-line bg-surface grad-sheen p-1 shadow-float',
          'animate-[popover-in_150ms_var(--ease-out)]',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

/** Ação com estados de teclado e desabilitado geridos pelo Radix; asChild preserva links nativos de navegação e download. */
export function MenuItem({ className, ...props }: ComponentProps<typeof MenuPrimitive.Item>) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex h-9 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm text-fg outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-hover max-md:h-10',
        className,
      )}
      {...props}
    />
  );
}
