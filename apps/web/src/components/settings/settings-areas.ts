// As 6 áreas de Configurações (phase 5, T4; spec F9, Suposição 21): FONTE ÚNICA da ordem, do nome, da descrição, do ícone e do endereço de cada área. O
// índice (`settings-index.tsx`) desenha uma linha por entrada e o painel do desktop (`shell/nav-config.ts`) lista as mesmas, na mesma ordem.
//
// As rotas antigas (`provedores`, `conectores`, `pesquisa-na-web`, `python`, `chat-geral`, `idioma-e-fuso`, `regras-globais`, `atividades` e `conta`) não
// aparecem aqui: o redirecionamento permanente delas para estas áreas vive em `next.config.ts` (`SETTINGS_REDIRECTS`). `/configuracoes/arquivos` também
// fica de fora: é a lista completa de arquivos, aberta por "Ver arquivos" em Atividade e arquivos, fora do menu.
import { Activity, Bell, Plug, ScrollText, ShieldCheck, SlidersHorizontal, type LucideIcon } from 'lucide-react';

export type SettingsAreaId = 'conexoes' | 'preferencias' | 'personalizacao' | 'notificacoes' | 'atividade-e-arquivos' | 'conta-e-seguranca';

export interface SettingsAreaInfo {
  id: SettingsAreaId;
  href: `/configuracoes/${SettingsAreaId}`;
  label: string;
  /** O que a área contém, em uma linha: aparece no índice. */
  description: string;
  icon: LucideIcon;
}

export const SETTINGS_AREAS: readonly SettingsAreaInfo[] = [
  { id: 'conexoes', href: '/configuracoes/conexoes', label: 'Conexões', description: 'OpenCode Go, Anthropic, Composio, pesquisa na web e Python', icon: Plug },
  { id: 'preferencias', href: '/configuracoes/preferencias', label: 'Preferências', description: 'Idioma, fuso e modelo do Chat geral', icon: SlidersHorizontal },
  { id: 'personalizacao', href: '/configuracoes/personalizacao', label: 'Personalização', description: 'Como te chamar e as regras globais que todos os bots seguem', icon: ScrollText },
  { id: 'notificacoes', href: '/configuracoes/notificacoes', label: 'Notificações', description: 'Este aparelho, dispositivos e avisos por bot', icon: Bell },
  { id: 'atividade-e-arquivos', href: '/configuracoes/atividade-e-arquivos', label: 'Atividade e arquivos', description: 'Execuções recentes e armazenamento', icon: Activity },
  { id: 'conta-e-seguranca', href: '/configuracoes/conta-e-seguranca', label: 'Conta e segurança', description: 'Autenticador, sessões e sair', icon: ShieldCheck },
];
