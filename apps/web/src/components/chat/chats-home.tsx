'use client';

// Chats (`/chats`; phase 5, T6 e T10; spec Suposição 19; design "Tela: Chats"): a página dos chats do Chat geral. De cima para baixo: o cabeçalho (título e, no celular, o "+" de novo
// chat; no desktop o botão já está no cabeçalho do painel), a escolha "Todos | Salvos", a lista de sessões que rola por dentro e, FIXO no rodapé da coluna, o campo "Pergunte ao Aion"
// (o mesmo do Início, `HomeComposer`): digitar ali e enviar abre o chat sem passar pelo "+" do canto. No celular a barra inferior fica abaixo da coluna (o shell a põe fora do
// `<main>`), então o campo sempre aparece acima dela. No desktop a página abre com o painel de sessões ao lado (`sectionForPath`), que não muda com a vista.
//
// Vistas (T10): "Todos" é o mesmo conteúdo, ordem e regras do painel (`SessionsList`, reaproveitada: título, prazo de exclusão ou "Salva", bolinha de não lido, carregando, vazio e erro),
// com as seções "Salvos" e "Recentes" e o aviso da retenção sob "Recentes". "Salvos" é a mesma lista só com as sessões salvas, lida do SERVIDOR (`use-saved-sessions.ts`: a lista completa é limitada às mais
// recentes e uma salva antiga ficaria de fora de um filtro no navegador), com vazio próprio só com a seção "Salvos" e sem o aviso de 7 dias (salvas não expiram). A vista mora na URL (`?vista=salvos`;
// "Todos" é `/chats` sem parâmetro): sobrevive a recarregar e a abrir um chat e voltar, e um valor desconhecido cai em "Todos". Trocar de vista só troca a URL no lugar
// (`history.replaceState`, que o Next integra ao `useSearchParams`): não é navegação, não cria entrada no histórico e não chama o servidor.
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { HomeComposer } from '@/components/home/home-composer';
import { cn } from '@/lib/cn';
import { ChatSessionsList, NewSessionAction, SessionsList } from './chat-panel';
import { SAVED_VIEW_PARAM, chatsViewOf, type ChatsView } from './chat-state';
import { useSavedChatSessions } from './use-saved-sessions';

/** Rótulo e endereço de cada vista: "Todos" é `/chats` limpo, "Salvos" leva `?vista=salvos`. */
const VIEWS: readonly { id: ChatsView; label: string; href: string }[] = [
  { id: 'todos', label: 'Todos', href: '/chats' },
  { id: 'salvos', label: 'Salvos', href: `/chats?vista=${SAVED_VIEW_PARAM}` },
];

/** Troca a URL para a vista pedida sem navegar (ver o cabeçalho do arquivo). A leitura da vista vem do `useSearchParams`, que acompanha a troca. */
function selectView(view: (typeof VIEWS)[number]): void {
  window.history.replaceState(null, '', view.href);
}

/**
 * A escolha "Todos | Salvos": controle segmentado de dois botões com `aria-pressed` (o selecionado fica destacado), num grupo com nome acessível. Botões, não links: é um filtro
 * da mesma página, e o estado selecionado é o que o leitor de tela anuncia.
 */
function ViewSwitch({ view }: { view: ChatsView }) {
  return (
    <div role="group" aria-label="Vista dos chats" className="mb-2 inline-flex rounded-lg border border-line bg-surface p-0.5">
      {VIEWS.map((option) => (
        <Button
          key={option.id}
          variant="ghost"
          size="sm"
          aria-pressed={view === option.id}
          onClick={() => selectView(option)}
          className={cn('min-w-20 rounded-md px-3 text-muted', view === option.id && 'bg-selected font-medium text-fg')}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** "Todos": a lista completa do painel (o store compartilhado), com as seções e o aviso único da retenção sob "Recentes". */
function AllSessions() {
  return <ChatSessionsList />;
}

/** O vazio de "Salvos": diz onde se salva (o botão "Salvar" do cabeçalho da conversa no desktop; "Salvar sessão" no menu da conversa no celular). */
const SAVED_EMPTY_MESSAGE = 'Nenhum chat salvo. Use "Salvar" dentro de uma conversa para guardá-la aqui.';

/** "Salvos": só as sessões salvas, com o vazio próprio e sem o aviso da retenção (uma sessão salva não expira). */
function SavedSessions() {
  const { status, sessions, retry } = useSavedChatSessions();
  return <SessionsList status={status} sessions={sessions} emptyMessage={SAVED_EMPTY_MESSAGE} onRetry={retry} />;
}

export function ChatsHome() {
  const view = chatsViewOf(useSearchParams().get('vista'));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mx-auto w-full max-w-[760px] shrink-0 px-4 md:px-6">
        <PageHeader title="Chats" padded={false} mobileAction={<NewSessionAction />} />
        <ViewSwitch view={view} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-6 md:px-6">{view === 'salvos' ? <SavedSessions /> : <AllSessions />}</div>
      </div>
      {/* O campo é o `Composer` (uma fonte só, a mesma da conversa e do Início): pílula lisa, com anexar à esquerda e modelo, effort, contexto, ditado e enviar à direita. */}
      <HomeComposer />
    </div>
  );
}
