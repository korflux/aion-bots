// Inventário da navegação do shell (F17): seções da barra de ícones e o painel de subopções de cada uma.
//
// Fonte única de "quais seções existem". Cada task que entrega uma tela acrescenta aqui o que é dela
// (ex.: T4 põe os bots no painel de Bots, T3 põe Provedores em Configurações), sem tocar no componente do shell.
// Configurações (phase 5, T4): o ícone da barra abre o ÍNDICE (`/configuracoes`) e o painel lista as 6 áreas, na ordem e com os nomes de `SETTINGS_AREAS`.
import {
  Bot,
  CalendarClock,
  MessageSquare,
  Plus,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { BotsPanel } from '@/components/bots/bots-panel';
import { ChatPanel } from '@/components/chat/chat-panel';
import { RoutinesPanel } from '@/components/routines/routines-panel';
import { SETTINGS_AREAS } from '@/components/settings/settings-areas';

export interface PanelLink {
  href: string;
  label: string;
}

export interface SectionPanelConfig {
  title: string;
  links?: readonly PanelLink[];
  /** Ação principal da seção, como botão de ícone no topo do painel (ex.: novo bot). */
  action?: { href: string; label: string; icon: LucideIcon };
  /** Corpo próprio do painel (lista dinâmica da seção), no lugar de `links`. */
  Content?: ComponentType;
}

export interface NavSection {
  /** Primeiro segmento da URL da seção (`/bots/...` -> `bots`). */
  id: 'bots' | 'chat' | 'rotinas' | 'aprovacoes' | 'configuracoes';
  label: string;
  /** Destino do ícone da barra. */
  href: string;
  icon: LucideIcon;
  /** Configurações fica fixa na base da barra; as demais seguem a ordem do design. */
  placement: 'top' | 'bottom';
  /** Painel de subopções; `null` nas seções sem painel (Aprovações). */
  panel: SectionPanelConfig | null;
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'bots',
    label: 'Bots',
    href: '/bots',
    icon: Bot,
    placement: 'top',
    panel: {
      title: 'Bots',
      action: { href: '/bots/novo', label: 'Novo bot', icon: Plus },
      Content: BotsPanel,
    },
  },
  {
    id: 'chat',
    label: 'Chat geral',
    href: '/chat',
    icon: MessageSquare,
    placement: 'top',
    panel: { title: 'Chat geral', Content: ChatPanel },
  },
  {
    id: 'rotinas',
    label: 'Rotinas',
    href: '/rotinas',
    icon: CalendarClock,
    placement: 'top',
    panel: {
      title: 'Rotinas',
      action: { href: '/rotinas/nova', label: 'Nova rotina', icon: Plus },
      Content: RoutinesPanel,
    },
  },
  { id: 'aprovacoes', label: 'Aprovações', href: '/aprovacoes', icon: ShieldCheck, placement: 'top', panel: null },
  {
    id: 'configuracoes',
    label: 'Configurações',
    href: '/configuracoes',
    icon: Settings,
    placement: 'bottom',
    panel: {
      title: 'Configurações',
      // Atividade e arquivos é consulta ocasional: vive em Configurações em vez de ocupar um ícone da barra. A lista completa de arquivos
      // (`/configuracoes/arquivos`) fica fora do menu, aberta por "Ver arquivos" naquela área.
      links: SETTINGS_AREAS.map(({ href, label }) => ({ href, label })),
    },
  },
];

/**
 * Seção ativa para um caminho (pelo primeiro segmento), ou `null` fora de qualquer seção. `/chats` (a lista de sessões, phase 5 T6) é da seção Chat geral, cujo id é `chat`:
 * no desktop a lista abre com o painel de sessões ao lado.
 */
export function sectionForPath(pathname: string): NavSection | null {
  const segment = pathname.split('/')[1];
  const id = segment === 'chats' ? 'chat' : segment;
  return NAV_SECTIONS.find((section) => section.id === id) ?? null;
}
