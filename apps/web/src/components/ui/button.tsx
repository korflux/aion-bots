// Botão base do kit (design.md): variantes primário, secundário, ghost e perigo; tamanhos 32/36 px e ícone.
// Botão de ícone tem 32 px no desktop e área de toque de 40 px no mobile. Ícone sozinho EXIGE `aria-label`.
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-action text-action-fg hover:bg-action/90 active:bg-action/80',
        secondary: 'border border-line bg-surface text-fg hover:bg-surface-hover active:bg-selected',
        ghost: 'text-muted hover:bg-surface-hover hover:text-fg active:bg-selected',
        danger: 'text-danger hover:bg-danger-soft active:bg-danger-soft',
      },
      size: {
        md: 'h-9 px-4',
        sm: 'h-8 px-3',
        icon: 'size-8 max-md:size-10',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Renderiza o filho (ex.: um Link) com o estilo do botão. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type = 'button', ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return <Component type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
