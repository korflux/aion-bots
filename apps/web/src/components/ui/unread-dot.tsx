// Marcador de não lido (phase 3, F4/A7; design "Tela: Lista de bots", "Lista do Chat geral" e "Navegação"): a bolinha de 8 px em `--info`, igual nas
// listas, na barra de ícones e no botão "Abrir menu". É decorativa (`aria-hidden`); quem a usa põe a novidade no nome acessível: nas listas, o
// `sr-only` de `UNREAD_LABEL` dentro do link; na navegação, o sufixo `UNREAD_NAV_SUFFIX` no `aria-label`.
import { cn } from '@/lib/cn';

/** Texto para leitor de tela do item com novidade nas listas ("Nome, estado, Novidades não lidas"). */
export const UNREAD_LABEL = 'Novidades não lidas';

/** Sufixo do nome acessível das entradas da navegação com novidade ("Bots, há novidades não lidas"). */
export const UNREAD_NAV_SUFFIX = ', há novidades não lidas';

/** A bolinha. `className` posiciona (na lista é o último filho `shrink-0`; na navegação, `absolute` com anel na cor do fundo da barra). */
export function UnreadDot({ className }: { className?: string }) {
  return <span aria-hidden data-testid="unread-dot" className={cn('block size-2 shrink-0 rounded-full bg-info', className)} />;
}
