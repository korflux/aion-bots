'use client';

// Barra inferior do celular (phase 5, T6; spec F3, Suposições 5, 16 e 17; design "Shell celular"): Início, Chats, Rotinas e Aprovações, no lugar do menu sanduíche e da gaveta.
// Só existe abaixo de 768 px (`md:hidden`; a partir dali o shell é a barra de ícones e o painel), só nas quatro telas de aba (`mobile-nav.ts`) e some com o teclado aberto
// (`use-keyboard-open.ts`), para o composer ficar logo acima dele. Cada aba tem alvo de 48 px (a barra tem 64), ícone de 20 px com o nome sempre visível, `aria-current="page"` na ativa e
// o sinal da aba no nome acessível, como a barra de ícones do desktop faz: Aprovações leva o número de pendentes (vazio em 0, "9+" acima de 9) e Início e Chats levam a
// bolinha de não lido. Os números e a bolinha vêm dos mesmos dados da barra de ícones (`usePendingApprovals`, `useUnreadSections`): nada novo é lido do servidor.
//
// `TabBarView` é só apresentação (recebe o estado pronto), para a prova unitária cobrir selo, bolinhas e `aria-current` sem navegador; `TabBar` liga os dados do app.
import { CalendarClock, House, MessagesSquare, ShieldCheck, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { badgeText } from '@/components/approvals/approvals-state';
import { usePendingApprovals } from '@/components/approvals/pending-approvals';
import { UNREAD_NAV_SUFFIX, UnreadDot } from '@/components/ui/unread-dot';
import { cn } from '@/lib/cn';
import { TAB_ROUTES, tabForPath, type TabId } from './mobile-nav';
import { useKeyboardOpen } from './use-keyboard-open';
import { useUnreadSections } from './use-unread-sections';

/** Nome visível e ícone de cada aba (Lucide, 20 px; o nome fica sempre à vista, abaixo do ícone). */
const TAB_LOOK: Record<TabId, { label: string; icon: LucideIcon }> = {
  inicio: { label: 'Início', icon: House },
  chats: { label: 'Chats', icon: MessagesSquare },
  rotinas: { label: 'Rotinas', icon: CalendarClock },
  aprovacoes: { label: 'Aprovações', icon: ShieldCheck },
};

export interface TabBarViewProps {
  /** Aba ativa (a tela atual). */
  active: TabId;
  /** Aprovações pendentes: vira o selo da aba Aprovações (vazio em 0, "9+" acima de 9). */
  approvals: number;
  /** Início tem bot ativo com novidade; Chats tem sessão com novidade. */
  unread: { inicio: boolean; chats: boolean };
}

/**
 * O nome acessível da aba: o visível mais o sinal ("Aprovações, 3 pendentes", "Chats, há novidades não lidas"). O selo e a bolinha visuais são `aria-hidden`; é este nome que diz
 * o mesmo ao leitor de tela.
 */
function tabName(id: TabId, approvals: number, unread: boolean): string {
  const { label } = TAB_LOOK[id];
  if (id === 'aprovacoes' && badgeText(approvals) !== null) return `${label}, ${approvals} ${approvals === 1 ? 'pendente' : 'pendentes'}`;
  return unread ? `${label}${UNREAD_NAV_SUFFIX}` : label;
}

/**
 * A barra desenhada para um estado dado: quatro links na ordem de `TAB_ROUTES`, com o selo de Aprovações e as bolinhas de Início e Chats. É a TabBar do kit (`docs/identidade/components/TabBar`):
 * 64 px mais a área segura, quatro colunas iguais, a aba ativa com o ícone numa pílula `bg-selected` de 52 × 28 e o texto em `text`, as inativas em `text-muted`. O rótulo é de 11 px (o do kit,
 * não o `caption` de 12 px): "Aprovações" mede 85 px em 12 px e a coluna de 320 px tem 80, então só em 11 px (78 px) o nome cabe inteiro nessa largura.
 */
export function TabBarView({ active, approvals, unread }: TabBarViewProps) {
  const approvalsBadge = badgeText(approvals);
  return (
    <nav
      aria-label="Navegação principal"
      className="shrink-0 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid h-16 grid-cols-4">
        {TAB_ROUTES.map(({ id, href }) => {
          const { label, icon: Icon } = TAB_LOOK[id];
          const isActive = id === active;
          const hasUnread = (id === 'inicio' && unread.inicio) || (id === 'chats' && unread.chats);
          return (
            <li key={id} className="flex min-w-0">
              <Link
                href={href}
                aria-label={tabName(id, approvals, hasUnread)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'group flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]/[14px] font-medium',
                  isActive ? 'text-fg' : 'text-muted hover:text-fg',
                )}
              >
                <span
                  className={cn(
                    'relative grid h-7 w-[52px] place-items-center rounded-full transition-[background-color,transform] group-active:scale-[0.92]',
                    isActive ? 'bg-selected' : 'group-hover:bg-surface-hover',
                  )}
                >
                  <Icon className="size-5" strokeWidth={1.5} aria-hidden />
                  {id === 'aprovacoes' && approvalsBadge ? (
                    <span
                      aria-hidden
                      data-testid="tab-approvals-badge"
                      className="absolute -top-0.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[11px]/none font-semibold text-action-fg"
                    >
                      {approvalsBadge}
                    </span>
                  ) : null}
                  {hasUnread ? <UnreadDot className="absolute right-3 top-0.5 ring-2 ring-panel" /> : null}
                </span>
                <span className="max-w-full truncate">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A barra do shell: some fora das quatro telas de aba e com o teclado virtual aberto. */
export function TabBar() {
  const active = tabForPath(usePathname());
  const approvals = usePendingApprovals();
  const unread = useUnreadSections();
  const keyboardOpen = useKeyboardOpen();
  if (active === null || keyboardOpen) return null;
  return <TabBarView active={active} approvals={approvals} unread={{ inicio: unread.bots, chats: unread.chat }} />;
}
