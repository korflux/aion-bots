// Trilho e polegar do interruptor do kit (design.md: ligado em `--action` com polegar `--action-fg`, desligado em `--bg-selected` com polegar
// `--text-muted`). Só desenho: o estado é dito ao leitor de tela pelo `aria-checked` do botão `role="switch"` que o envolve, e quem o envolve também
// dá a área de toque (44 px de altura). Usado pela matriz de silenciar (Notificações) e pelo interruptor da Pesquisa na web.
// A transição do polegar segue a regra global de movimento reduzido (globals.css zera a duração).
import { cn } from '@/lib/cn';

export function SwitchTrack({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={cn('relative inline-block h-5 w-9 shrink-0 rounded-full border transition-colors', on ? 'border-transparent bg-action' : 'border-line-strong bg-selected')}>
      <span className={cn('absolute top-0.5 size-3.5 rounded-full transition-all', on ? 'left-[18px] bg-action-fg' : 'left-0.5 bg-muted')} />
    </span>
  );
}
