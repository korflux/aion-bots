'use client';

// Sessão aberta do chat geral em /chat/[sessaoId] (F16): a MESMA tela da conversa do bot (`ConversationView`) com o cabeçalho do chat
// geral: o título gerado pela primeira mensagem e o botão "Salvar", que suspende a exclusão em 7 dias. O título e o estado de salva vêm
// do store da lista (a mesma cópia do painel), e mandar uma mensagem recarrega a lista (é aí que a sessão ganha título e atividade).
// Uma sessão que a lista NÃO conhece e cuja conversa está vazia é o rascunho ("Novo chat": a API o deixa fora da lista até a primeira
// mensagem); quem decide o nome do cabeçalho nesse caso é a própria conversa (ver `ConversationView`). Sem o botão "Salvar", que só faz
// sentido depois de haver o que guardar. No celular (phase 5, T6) o "Salvar" vai para o menu "Mais ações do chat" (`menuActions`), com a mesma lógica do botão.
// Uma sessão que deixou de existir (apagada pela retenção) mostra a tela "Esta sessão expirou" no lugar da conversa.
import type { ChatSession } from '@aion/shared';
import { Bookmark, MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConversationView } from '@/components/conversation/conversation-view';
import { EmptyState, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { MenuItem } from '@/components/ui/menu';
import { apiErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { setChatSessionSaved } from './chat-api';
import { expiryLabel, sessionTitle } from './chat-state';
import { refreshChatSessions, useChatSessions } from './chat-store';
import { useNewSession } from './use-new-session';

/** Tela de uma sessão que não existe mais: a retenção a apagou (ou o endereço é antigo). A lista do painel é relida para ela sair dali. */
function SessionExpired() {
  const { open, busy } = useNewSession();
  useEffect(() => {
    void refreshChatSessions();
  }, []);
  return (
    <>
      <PageHeader title="Esta sessão expirou" />
      <EmptyState
        icon={MessageSquare}
        action={
          <Button variant="primary" disabled={busy} onClick={() => void open()}>
            Novo chat
          </Button>
        }
      >
        As sessões do chat geral são apagadas 7 dias após a última mensagem, a menos que estejam salvas.
      </EmptyState>
    </>
  );
}

/**
 * Salvar ou deixar de salvar a sessão (ligado, ela não expira; desligado, volta a contar os 7 dias), com o aviso do resultado. Uma só lógica para as duas portas: o botão
 * "Salvar" do cabeçalho do desktop (`SaveToggle`) e o item "Salvar sessão" do menu "Mais ações" do celular (`SaveMenuItem`).
 */
function useSaveToggle(session: ChatSession) {
  const { csrfToken } = useSession();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await setChatSessionSaved(session.id, !session.saved, csrfToken);
      toast(updated.saved || updated.expiresAt === null ? 'Sessão salva: ela não será apagada.' : `Sessão não salva: ${expiryLabel(updated.expiresAt, Date.now())}.`);
    } catch (error) {
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setBusy(false);
    }
  }

  return { busy, toggle };
}

/** Botão "Salvar" do cabeçalho (desktop): com texto (o estado importa e o ícone sozinho é ambíguo). */
function SaveToggle({ session }: { session: ChatSession }) {
  const { busy, toggle } = useSaveToggle(session);
  return (
    <Button variant="secondary" size="sm" aria-pressed={session.saved} disabled={busy} onClick={() => void toggle()}>
      <Bookmark className={cn('size-4', session.saved && 'fill-current')} strokeWidth={1.5} aria-hidden />
      {session.saved ? 'Salva' : 'Salvar'}
    </Button>
  );
}

/** O mesmo no menu "Mais ações do chat" (celular): "Salvar sessão", ou "Remover dos salvos" quando já está salva. */
function SaveMenuItem({ session }: { session: ChatSession }) {
  const { busy, toggle } = useSaveToggle(session);
  return (
    <MenuItem disabled={busy} onSelect={() => void toggle()}>
      <Bookmark className={cn('size-4', session.saved && 'fill-current')} strokeWidth={1.5} aria-hidden />
      {session.saved ? 'Remover dos salvos' : 'Salvar sessão'}
    </MenuItem>
  );
}

export function ChatSessionView({ id }: { id: string }) {
  const { sessions } = useChatSessions();
  const session = sessions.find((item) => item.id === id);
  // Abrir uma sessão por link (push, histórico) com a lista carregada antes dela existir: uma releitura por sessão aberta tira a dúvida
  // entre "rascunho" e "sessão que a lista ainda não conhece".
  useEffect(() => {
    void refreshChatSessions();
  }, [id]);

  return (
    <ConversationView
      owner={{
        kind: 'session',
        sessionId: id,
        // Nulo enquanto a lista não conhece a sessão (ainda carregando, vazia ou além das 200 mais recentes): o cabeçalho decide pela conversa.
        title: session ? sessionTitle(session) : null,
        actions: session ? <SaveToggle session={session} /> : null,
        menuActions: session ? <SaveMenuItem session={session} /> : null,
        expired: <SessionExpired />,
      }}
      footer={null}
      onSent={() => void refreshChatSessions()}
    />
  );
}
