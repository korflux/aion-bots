'use client';

// Leitura da vista "Salvos" de `/chats` (phase 5, T10): as sessões do Chat geral com `saved: true`, vindas de `GET /api/chat/sessions?saved=true`. O filtro é do SERVIDOR de
// propósito: a lista completa (`chat-store`) traz só as 200 sessões mais recentes, e uma sessão salva não expira, então uma salva antiga ficaria de fora de um filtro feito
// no navegador.
//
// Por que não vai no `chat-store`: o store guarda UMA lista compartilhada com o painel do desktop e a barra de ícones, que não muda. A vista Salvos só existe enquanto a página está
// aberta, então a leitura é do componente: carrega ao abrir (sem cópia velha de uma visita anterior) e relê a cada 15 s com a aba visível (`createLivePoll`, o mesmo relógio do
// store), o que mantém a bolinha de não lido e "salvar/desfazer" feitos em outro aparelho em dia.
//
// Estados: `loading` na primeira leitura; `ready` com a lista (vazia ou não); `error` SÓ se a primeira leitura falhou (uma releitura de fundo que falha mantém a última lista). Depois
// de um erro a releitura periódica segue tentando e, se der certo, a tela se recupera sozinha; `retry` refaz a leitura já.
import type { ChatSessionList } from '@aion/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { createLivePoll } from '@/lib/live-poll';
import { CHAT_SESSIONS_POLL_MS, sameSessions, type ChatSessionsState } from './chat-store';

/** Endereço da lista filtrada: o único parâmetro aceito pela API é `saved=true` (allowlist na borda). */
const SAVED_SESSIONS_URL = '/api/chat/sessions?saved=true';

/** A vista dos salvos: o estado da leitura (o mesmo formato do store) e `retry` para a leitura que falhou. */
export function useSavedChatSessions(): ChatSessionsState & { retry: () => void } {
  const [state, setState] = useState<ChatSessionsState>({ status: 'loading', sessions: [] });
  /** Cada tentativa de "Tentar novamente" reinicia a leitura (e o relógio de releitura) do zero. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    /** Já houve uma leitura bem-sucedida? Antes dela uma falha é erro de tela; depois, é só uma releitura de fundo que falhou. */
    let loaded = false;
    /** A leitura mais nova vence: uma resposta antiga que chega depois (aba voltando a ficar visível durante uma leitura) é descartada. */
    let latest = 0;

    async function load(): Promise<void> {
      const mine = ++latest;
      try {
        const data = await apiFetch<ChatSessionList>(SAVED_SESSIONS_URL);
        if (!active || mine !== latest) return;
        loaded = true;
        // Sem mudança, não acorda a tela (a releitura de fundo é frequente).
        setState((current) => (current.status === 'ready' && sameSessions(current.sessions, data.items) ? current : { status: 'ready', sessions: data.items }));
      } catch {
        if (active && mine === latest && !loaded) setState({ status: 'error', sessions: [] });
      } finally {
        if (active) poll.schedule();
      }
    }

    // `settled` verdadeiro: a primeira leitura é a do próprio `watch` (que relê ao montar), então o relógio nunca espera por outra carga.
    const poll = createLivePoll({ refresh: () => void load(), delay: () => CHAT_SESSIONS_POLL_MS, settled: () => true });
    const stop = poll.watch();
    return () => {
      active = false;
      stop();
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading', sessions: [] });
    setAttempt((value) => value + 1);
  }, []);

  return { ...state, retry };
}
