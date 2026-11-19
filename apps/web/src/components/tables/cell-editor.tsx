'use client';

// Editor compacto dentro da célula da grade (edição direta, estilo planilha). Cobre os tipos escalares, seleção e Sim/Não; relação e seleção
// múltipla têm editores próprios no `TableEditor` (seletor em modal e lista de opções). O valor fica como texto até salvar: `parseField`
// converte na gravação, então a mesma validação do formulário completo vale aqui.
import type { TableCell, TableColumn } from '@aion/shared';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { fieldInput } from './values';

/** Classes comuns: ocupa a célula inteira, sem alterar a altura da linha além do necessário. Borda neutra (tema neutro, A2); o foco é o anel global de `:focus-visible` (token de foco, TOK-01, 2 px de contorno a 2 px de distância, sem regra local). Medido a 1440 px: o anel cabe no preenchimento da célula (4 px em cima e embaixo, 8 px nos lados) e não é cortado pela grade nem coberto pelo cabeçalho fixo. */
const base = 'w-full min-w-0 rounded-sm border border-line-strong bg-surface px-1.5 py-1 text-sm text-fg disabled:opacity-50';

export function CellEditor({ id, column, value, zone, disabled, onChange, onCommit }: {
  id: string;
  column: TableColumn;
  /** Texto em edição (escalares) ou ID da opção (seleção); `null`/vazio representam célula vazia. */
  value: TableCell;
  zone: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  /** Seleção e Sim/Não salvam na escolha: não há botão de confirmar. */
  onCommit: (value: string) => void;
}) {
  const text = typeof value === 'string' ? value : fieldInput(column, value, zone);
  // Um único ref para os três elementos possíveis; o tipo real é conferido no efeito.
  const field = useRef<HTMLElement | null>(null);
  const bind = (element: HTMLElement | null) => { field.current = element; };
  // Foco imediato ao abrir; texto existente preservado; o cursor vai para o fim.
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.focus();
    // Cursor no fim (inclusive quando a edição começou digitando um caractere); date/time não aceitam seleção de texto.
    if (element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && element.type === 'text')) element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  if (column.type === 'boolean' || column.type === 'select') {
    const current = typeof value === 'boolean' ? String(value) : text;
    return <select ref={bind} id={id} aria-label={column.name} disabled={disabled} className={cn(base, 'h-8')} value={current} onChange={(event) => onCommit(event.target.value)}>
      <option value="">Vazio</option>
      {column.type === 'boolean' ? <><option value="true">Sim</option><option value="false">Não</option></> : column.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>;
  }
  if (column.type === 'text') {
    // Enter confirma e Shift+Enter quebra linha (tratados pela grade); a altura acompanha o conteúdo até um limite.
    return <textarea ref={bind} id={id} aria-label={column.name} disabled={disabled} rows={Math.min(6, Math.max(1, text.split('\n').length))} maxLength={8000} className={cn(base, 'block resize-none leading-5')} value={text} onChange={(event) => onChange(event.target.value)} />;
  }
  const type = column.type === 'date' ? 'date' : column.type === 'time' ? 'time' : column.type === 'datetime' ? 'datetime-local' : 'text';
  return <input ref={bind} id={id} aria-label={column.name} disabled={disabled} type={type} step={column.type === 'datetime' ? 0.001 : undefined}
    inputMode={column.type === 'number' || column.type === 'money' ? 'decimal' : undefined}
    className={cn(base, 'h-8', column.type === 'number' || column.type === 'money' ? 'text-right tabular-nums' : '')} value={text} onChange={(event) => onChange(event.target.value)} />;
}
