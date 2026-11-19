// Mapa da navegação do celular (phase 5, T6; spec F3, Suposições 5 e 6): FONTE ÚNICA de duas perguntas que o shell abaixo de 768 px faz a cada rota, sem React e sem
// leitura de estado, para a prova unitária cobrir cada rota do app.
//   1. Esta é uma das quatro telas de aba (Início, Chats, Rotinas, Aprovações)? Só nelas a barra inferior aparece e só nelas "Voltar" não existe.
//   2. Para onde "Voltar" leva? Ao PAI FIXO da hierarquia, nunca ao histórico do navegador: a tela aberta por push, atalho do ícone ou link digitado não tem histórico
//      do app atrás, e o botão tem de funcionar igual nos dois casos.
// Quem consome: `tab-bar.tsx` (abas), `back-link.tsx` (botão Voltar dos cabeçalhos) e `section-panel.tsx` (item ativo do painel de Configurações).

/** Identificador de cada aba da barra inferior. */
export type TabId = 'inicio' | 'chats' | 'rotinas' | 'aprovacoes';

/** As quatro abas, na ordem da barra. O endereço é o da própria tela: a aba ativa é a rota exata (a barra só existe nelas). */
export const TAB_ROUTES: readonly { id: TabId; href: string }[] = [
  { id: 'inicio', href: '/' },
  { id: 'chats', href: '/chats' },
  { id: 'rotinas', href: '/rotinas' },
  { id: 'aprovacoes', href: '/aprovacoes' },
];

/** Aba do caminho, ou `null` quando a tela não é de aba (conversa, editor, área de Configurações, erro): nelas não há barra inferior. */
export function tabForPath(pathname: string): TabId | null {
  return TAB_ROUTES.find((tab) => tab.href === pathname)?.id ?? null;
}

/**
 * Pai fixo de cada tela que não é de aba (Suposição 6), da mais específica à mais geral (a primeira regra que casa vale):
 *  - conversa do bot, editor de bot (criar e editar) e a seção `/bots` → Início;
 *  - arquivos e memória do bot → conversa do bot (a memória é da spec; os arquivos, que a spec não lista, seguem o mesmo vínculo com a conversa, de onde o menu os abre);
 *  - sessão do Chat geral e a abertura `/chat` → Chats;
 *  - editor de rotina (nova e existente) e histórico → Rotinas;
 *  - Artefatos (phase 14, A3 e A31) → Início; a página de uma tabela ou de um doc → Artefatos, inclusive as páginas próprias antigas da tabela (por bot e em Configurações), que
 *    continuam existindo. As listas antigas de tabelas (`/bots/:id/tabelas` e `/configuracoes/tabelas`) redirecionam para Artefatos (`next.config.ts`) e não têm tela, então não
 *    têm regra própria aqui;
 *  - lista de arquivos → Atividade e arquivos; área de Configurações → índice; índice → Início.
 * Caminho fora do mapa (aba, "Não encontrado") não tem pai: a tela de erro leva ao Início por conta própria.
 */
const PARENTS: readonly (readonly [RegExp, (match: RegExpExecArray) => string])[] = [
  [/^\/bots\/novo$/, () => '/'],
  [/^\/bots\/[^/]+\/tabelas\/[^/]+$/, () => '/artefatos'],
  [/^\/bots\/([^/]+)\/(?:arquivos|memoria)$/, (match) => `/bots/${match[1]}`],
  [/^\/bots(?:\/[^/]+(?:\/editar)?)?$/, () => '/'],
  [/^\/chat(?:\/[^/]+)?$/, () => '/chats'],
  [/^\/rotinas\/.+$/, () => '/rotinas'],
  [/^\/artefatos$/, () => '/'],
  [/^\/artefatos\/(?:tabelas|docs)\/[^/]+$/, () => '/artefatos'],
  [/^\/configuracoes\/arquivos$/, () => '/configuracoes/atividade-e-arquivos'],
  [/^\/configuracoes\/tabelas\/[^/]+$/, () => '/artefatos'],
  [/^\/configuracoes\/[^/]+$/, () => '/configuracoes'],
  [/^\/configuracoes$/, () => '/'],
];

/** Destino de "Voltar" para o caminho (o pai fixo), ou `null` nas telas de aba e fora do mapa. */
export function backHrefFor(pathname: string): string | null {
  for (const [pattern, parent] of PARENTS) {
    const match = pattern.exec(pathname);
    if (match) return parent(match);
  }
  return null;
}
