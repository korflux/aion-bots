'use client';

// Barra de ícones (56 px): a estrela da marca no topo (link "Início", phase 5 T5), seções e Configurações fixa na base. Todo ícone é icon-only,
// com `aria-label`, tooltip à direita (400 ms), área de 40 px, foco visível e `aria-current="page"` no ativo.
// Bots e Chat geral levam a bolinha de não lido (phase 3, F4/A7) na posição do contador de aprovações, com anel na cor do fundo da barra; o contador
// de Aprovações segue como era e é independente da leitura. A barra é TRANSPARENTE de propósito (phase 5, T8): ela mostra o fundo liso da página (UI-06); só o painel ao lado leva `bg-panel`. A bolinha entra no nome acessível ("Bots, há novidades não lidas"); o tooltip fica só o nome.
import { PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { badgeText } from '@/components/approvals/approvals-state';
import { usePendingApprovals } from '@/components/approvals/pending-approvals';
import { BrandStar } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { UNREAD_NAV_SUFFIX, UnreadDot } from '@/components/ui/unread-dot';
import { cn } from '@/lib/cn';
import { NAV_SECTIONS, type NavSection } from './nav-config';
import { useUnreadSections } from './use-unread-sections';

interface IconRailProps {
  active: NavSection | null;
  /** Mostra o botão de reabrir o painel quando ele está recolhido (desktop). */
  panelCollapsed?: boolean;
  onExpandPanel?: () => void;
}

/** Link de seção com nome acessível, seleção corrente e indicadores independentes de leitura e aprovação. */
function RailLink({
  section,
  isActive,
  badge = 0,
  unread = false,
}: {
  section: NavSection;
  isActive: boolean;
  badge?: number;
  /** Algum item da seção tem novidade não lida (só Bots e Chat geral). */
  unread?: boolean;
}) {
  const Icon = section.icon;
  const badgeLabel = badgeText(badge);
  // O número e a novidade entram no nome acessível (o círculo visual é só um reforço): "Aprovações, 3 pendentes", "Bots, há novidades não lidas".
  const name = badgeLabel
    ? `${section.label}, ${badge} ${badge === 1 ? 'pendente' : 'pendentes'}`
    : unread
      ? `${section.label}${UNREAD_NAV_SUFFIX}`
      : section.label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={section.href}
          aria-label={name}
          aria-current={isActive ? 'page' : undefined}
          className={cn(
            'relative flex size-10 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-fg active:bg-selected',
            isActive && 'bg-selected text-fg',
          )}
        >
          <Icon className="size-[18px]" strokeWidth={1.5} aria-hidden />
          {badgeLabel ? (
            <span
              aria-hidden
              data-testid="approvals-badge"
              className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[11px]/none font-semibold text-action-fg"
            >
              {badgeLabel}
            </span>
          ) : null}
          {unread ? <UnreadDot className="absolute right-0.5 top-0.5 ring-2 ring-app" /> : null}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{section.label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A estrela da marca no topo: abre o Início (`/`), que não tem painel (design "Shell desktop"). É marca, não ícone genérico: só aparece aqui. Mesmo alvo de 40 px,
 * foco visível e tooltip dos demais itens; `aria-current="page"` só no próprio Início (a seção ativa das demais vem de `active`).
 */
function HomeLink() {
  const atHome = usePathname() === '/';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href="/"
          aria-label="Início"
          aria-current={atHome ? 'page' : undefined}
          className={cn(
            'mb-3 flex size-10 items-center justify-center rounded-md transition-colors hover:bg-surface-hover active:bg-selected',
            atHome && 'bg-selected',
          )}
        >
          <BrandStar size={24} />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">Início</TooltipContent>
    </Tooltip>
  );
}

/** Navegação desktop com ações estáveis; o painel recolhido pode ser reaberto sem trocar de seção. */
export function IconRail({ active, panelCollapsed = false, onExpandPanel }: IconRailProps) {
  const pendingApprovals = usePendingApprovals();
  const unread = useUnreadSections();
  const top = NAV_SECTIONS.filter((section) => section.placement === 'top');
  const bottom = NAV_SECTIONS.filter((section) => section.placement === 'bottom');
  return (
    <nav aria-label="Seções" className="flex w-14 shrink-0 flex-col items-center gap-1 py-3">
      <HomeLink />
      {panelCollapsed && active?.panel && onExpandPanel ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Expandir painel" onClick={onExpandPanel} className="mb-2">
              <PanelLeftOpen className="size-4" strokeWidth={1.5} aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Expandir painel</TooltipContent>
        </Tooltip>
      ) : null}
      {top.map((section) => (
        <RailLink
          key={section.id}
          section={section}
          isActive={active?.id === section.id}
          badge={section.id === 'aprovacoes' ? pendingApprovals : 0}
          unread={(section.id === 'bots' && unread.bots) || (section.id === 'chat' && unread.chat)}
        />
      ))}
      <div className="mt-auto flex flex-col items-center gap-1">
        {bottom.map((section) => (
          <RailLink key={section.id} section={section} isActive={active?.id === section.id} />
        ))}
      </div>
    </nav>
  );
}
