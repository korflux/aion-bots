'use client';

// "Novo chat" do chat geral: pede à API o rascunho vazio (ou o cria) e abre a conversa dele. Compartilhado pelo botão do painel, pelo botão
// da tela de sessão expirada e pela abertura automática de /chat. `replace` troca a entrada do histórico em vez de empilhar uma nova: a abertura automática de /chat não pode deixar um /chat
// "fantasma" no histórico, ou o botão Voltar reabriria o chat e o redirecionaria de novo.
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { createChatSession } from './chat-api';

export interface NewSession {
  open: () => Promise<void>;
  busy: boolean;
  /** A última tentativa falhou (a tela mostra "Tentar de novo"); volta a falso quando uma nova tentativa começa. */
  failed: boolean;
}

/** Abre o rascunho pelo contrato do chat e conserva os estados de tentativa e falha usados pelas entradas da seção. */
export function useNewSession({ replace = false }: { replace?: boolean } = {}): NewSession {
  const router = useRouter();
  const { csrfToken } = useSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const open = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const session = await createChatSession(csrfToken);
      const href = `/chat/${session.id}`;
      if (replace) router.replace(href);
      else router.push(href);
    } catch (error) {
      setFailed(true);
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setBusy(false);
    }
  }, [busy, csrfToken, replace, router]);

  return { open, busy, failed };
}
