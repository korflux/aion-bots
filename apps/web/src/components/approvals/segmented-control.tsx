'use client';

// Controle segmentado do kit (design: "Controle segmentado, para regras de aprovação"): um grupo de opções exclusivas, a ativa com
// `--bg-selected`. Semântica de radiogrupo: um único item entra na ordem de Tab (o ativo) e as setas, Home e End movem a escolha,
// como num radio nativo. Permitir ativo usa texto `--success` e Negar ativo `--danger`; as demais, texto normal. Todas as opções
// têm texto (a ação é crítica e ambígua demais para depender de ícone ou cor).
import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/** Cor do texto da opção ativa (design: permitir verde, negar vermelho). */
const ACTIVE_TEXT: Record<string, string> = { allow: 'text-success', deny: 'text-danger' };

interface SegmentedControlProps<T extends string> {
  /** Nome acessível do grupo (ex.: "Regra global de Send Email"). */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({ label, options, value, onChange, disabled = false, className }: SegmentedControlProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = options.length - 1;
    let target: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = index === 0 ? last : index - 1;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = last;
    else return;
    event.preventDefault();
    buttons.current[target]?.focus();
    const next = options[target];
    if (next) onChange(next.value);
  }

  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-md border border-line bg-surface p-0.5', className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'h-8 flex-1 whitespace-nowrap rounded-sm px-3 text-sm font-medium transition-colors disabled:opacity-60 max-md:h-10 md:flex-none',
              checked ? cn('bg-selected', ACTIVE_TEXT[option.value] ?? 'text-fg') : 'text-muted hover:bg-surface-hover hover:text-fg',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
