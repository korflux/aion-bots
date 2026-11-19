'use client';

// Shell de navegação autenticado (F17; phase 5, T6): barra de ícones + painel + conteúdo no desktop e, abaixo de 768 px, o conteúdo ocupando a tela com a barra inferior
// (`TabBar`) nas quatro telas de aba. Não há mais cabeçalho do shell no celular: cada tela desenha o próprio cabeçalho (título e ação nas abas; "Voltar" para o pai fixo nas demais,
// ver `back-link.tsx`), então o shell só reserva a área segura do topo.
//
// A troca desktop x mobile é 100 % CSS (`hidden md:flex` / `md:hidden`), então não há salto de layout nem divergência de hidratação. O JS só guarda estado de interação: painel
// recolhido e largura. Entre 768 e 1024 px o painel começa recolhido (design), até o dono expandir.
//
// Fundo (UI-06): o contêiner do shell é TRANSPARENTE de propósito. O fundo liso da página (`bg-app`) vem do `body` em globals.css, então não há segunda camada de cor aqui. A barra de
// ícones também é transparente; só o painel lateral leva `bg-panel` (cor lisa), e o conteúdo mostra a página.
//
// Baseline mobile (design "Motion e baseline mobile"): altura em `100dvh` (acompanha a barra do navegador), área segura do topo aqui e a de baixo na barra inferior e no composer,
// `overscroll-behavior: none` na raiz e `contain` na área rolável.
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { PendingApprovalsProvider } from '@/components/approvals/pending-approvals';
import { SettingsProvider } from '@/components/settings/settings-provider';
import { NotificationNotice } from '@/components/push/notification-notice';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useMediaQuery } from '@/lib/use-media-query';
import { IconRail } from './icon-rail';
import { sectionForPath } from './nav-config';
import { PANEL_DEFAULT_WIDTH, SectionPanel } from './section-panel';
import { TabBar } from './tab-bar';

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active = sectionForPath(pathname);
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1023px)');

  // `null` = seguir o padrão do breakpoint (recolhido em tablet); true/false = escolha explícita do dono.
  const [collapsedChoice, setCollapsedChoice] = useState<boolean | null>(null);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const collapsed = collapsedChoice ?? isTablet;

  return (
    <TooltipProvider>
      <SettingsProvider>
      <PendingApprovalsProvider>
        <div className="flex h-dvh flex-col overflow-hidden overscroll-none pt-[env(safe-area-inset-top)] md:flex-row md:pt-0">
          <a
            href="#conteudo"
            className="sr-only z-50 rounded-md bg-action px-3 py-2 text-sm font-medium text-action-fg focus:not-sr-only focus:absolute focus:left-2 focus:top-2"
          >
            Pular para o conteúdo
          </a>

          {/* Desktop: barra + painel lado a lado. */}
          <div className="hidden md:flex">
            <IconRail
              active={active}
              panelCollapsed={collapsed}
              onExpandPanel={() => setCollapsedChoice(false)}
            />
            {active?.panel && !collapsed ? (
              <SectionPanel
                section={active}
                width={panelWidth}
                onCollapse={() => setCollapsedChoice(true)}
                onResize={setPanelWidth}
              />
            ) : null}
          </div>

          {/* O aviso "Ativar notificações" (T10) fica acima do conteúdo e some quando não há o que oferecer. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <NotificationNotice />
            <main id="conteudo" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
              {children}
            </main>
          </div>

          {/* Celular: a barra inferior das quatro abas (some nas demais telas e com o teclado aberto). */}
          <TabBar />
        </div>
      </PendingApprovalsProvider>
      </SettingsProvider>
    </TooltipProvider>
  );
}
