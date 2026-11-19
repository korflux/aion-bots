'use client';

// Carrega um bot completo (GET /api/bots/:id) para o editor e a conversa. O componente que usa este hook deve
// receber `key={id}`: assim o estado reinicia sozinho quando o id muda, sem setState dentro de efeito.
import type { Bot } from '@aion/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api-client';

export type BotLoad =
  | { status: 'loading' }
  | { status: 'ready'; bot: Bot }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

export function useBot(id: string): { load: BotLoad; retry: () => void; replace: (bot: Bot) => void } {
  const [load, setLoad] = useState<BotLoad>({ status: 'loading' });
  // Incrementar dispara nova busca (tentar de novo depois de erro).
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Bot>(`/api/bots/${id}`).then(
      (bot) => {
        if (!cancelled) setLoad({ status: 'ready', bot });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'BOT_NOT_FOUND') setLoad({ status: 'not-found' });
        else setLoad({ status: 'error', message: error instanceof ApiError ? error.message : 'Não foi possível carregar o bot.' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  const retry = useCallback(() => {
    setLoad({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, []);
  /** Troca o bot carregado pelo devolvido por uma alteração (arquivar, desarquivar). */
  const replace = useCallback((bot: Bot) => setLoad({ status: 'ready', bot }), []);

  return { load, retry, replace };
}
