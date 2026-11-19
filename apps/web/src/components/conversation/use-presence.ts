'use client';

// Hook da presença e leitura da conversa aberta (phase 3, T2; F1/A2): liga o informante de `presence.ts` aos eventos da página. Usado por
// `useConversation`, então vale igual para a conversa do bot e para a sessão do Chat geral.
//
// Eventos: `visibilitychange`, `focus` e `blur` reconferem visibilidade e foco; `pagehide` (fechar, recarregar, ir para outro site ou entrar
// no bfcache) encerra na hora, com a requisição `keepalive`; `pageshow` (voltar do bfcache) reconfere. Trocar de conversa ou desmontar a tela
// encerra e desliga o informante desta conversa (o efeito se refaz para a nova). Só começa quando a conversa carregou, para a primeira
// informação já levar a leitura até a mensagem mais recente.
// Toda leitura aceita pelo servidor também apaga a bolinha de não lido desta conversa nos stores das listas (phase 3, F4: "na hora em que a conversa é
// lida neste aparelho"), sem esperar o próximo ciclo de releitura. Estar presente (conversa aberta, visível e em foco) também fecha as notificações dela neste
// aparelho (phase 16, A10; `close-notifications.ts`): o dono já está vendo o que elas avisavam.
import { useEffect, useRef } from 'react';
import { ApiError } from '@/lib/api-client';
import { markBotRead } from '@/components/bots/bots-store';
import { markChatSessionRead } from '@/components/chat/chat-store';
import { useSession } from '@/lib/session-context';
import { reportPresence, type ConversationSource } from './conversation-api';
import { closeConversationNotifications } from '@/components/push/close-notifications';
import { createPresenceReporter, type PresenceOutcome } from './presence';

/** Informa presença e leitura desta conversa enquanto `ready` (conversa carregada); `readThrough` é a mensagem mais recente mostrada. */
export function usePresence(source: ConversationSource, readThrough: string | null, ready: boolean): void {
  const { csrfToken } = useSession();
  // A leitura muda a cada mensagem; o informante a lê na hora de cada envio sem se refazer (nem reiniciar a presença).
  const latestRead = useRef(readThrough);
  useEffect(() => {
    latestRead.current = readThrough;
  }, [readThrough]);

  useEffect(() => {
    if (!ready) return;
    const report = async (present: boolean, read: string | null): Promise<PresenceOutcome> => {
      try {
        await reportPresence(source, present, read, csrfToken);
        if (read !== null) (source.kind === 'bot' ? markBotRead : markChatSessionRead)(source.id);
        if (present) void closeConversationNotifications(source);
        return 'ok';
      } catch (error) {
        // Sem toast: rede, limite ou sessão vencida não interrompem a conversa (a spec F1 não mostra erro de presença ao dono).
        return error instanceof ApiError && error.code === 'NOT_FOUND' ? 'not-found' : 'failed';
      }
    };
    const reporter = createPresenceReporter({
      report,
      isActive: () => document.visibilityState === 'visible' && document.hasFocus(),
      readThrough: () => latestRead.current,
    });

    reporter.sync();
    document.addEventListener('visibilitychange', reporter.sync);
    window.addEventListener('focus', reporter.sync);
    window.addEventListener('blur', reporter.sync);
    window.addEventListener('pagehide', reporter.leave);
    window.addEventListener('pageshow', reporter.sync);
    return () => {
      document.removeEventListener('visibilitychange', reporter.sync);
      window.removeEventListener('focus', reporter.sync);
      window.removeEventListener('blur', reporter.sync);
      window.removeEventListener('pagehide', reporter.leave);
      window.removeEventListener('pageshow', reporter.sync);
      reporter.stop();
    };
  }, [source, csrfToken, ready]);
}
