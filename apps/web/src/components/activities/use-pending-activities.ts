'use client';

// As aprovações pendentes de todos os bots e do chat geral ("Aguardando você"), lidas de `GET /api/activities` (phase 5, T4; spec F8, Suposição 25). Era parte da tela
// Atividades e passou para o topo de Aprovações; este hook guarda o que era dela: a leitura e a atualização sozinha da lista (não há canal de eventos global como o SSE
// da conversa).
//
// Atualiza: ao montar, a cada 15 s (5 s enquanto há pendência, que expira e some), ao voltar o foco para a janela e quando o número de pendências do shell muda
// (`usePendingApprovals`, que já relê a cada 15 s e quando um cartão de aprovação chega ou é respondido). Falha numa releitura de fundo mantém a lista como está; só a
// primeira carga mostra o erro, com `retry`.
import type { PendingActivity } from '@aion/shared';
import { useCallback, useEffect, useState } from 'react';
import { usePendingApprovals } from '@/components/approvals/pending-approvals';
import { apiErrorMessage } from '@/lib/api-client';
import { fetchActivities } from './activities-api';

export type PendingLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; pending: PendingActivity[] };

const POLL_IDLE_MS = 15_000;
const POLL_BUSY_MS = 5_000;

/** A lista de pendências já atualizada sozinha (`load`) e a nova tentativa depois de um erro na primeira leitura (`retry`). */
export function usePendingActivities(): { load: PendingLoad; retry: () => void } {
  const [load, setLoad] = useState<PendingLoad>({ status: 'loading' });
  const count = usePendingApprovals();

  /** Relê a lista; numa falha de fundo a lista que já está na tela continua valendo. */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { pending } = await fetchActivities(null);
      setLoad({ status: 'ready', pending });
    } catch (error) {
      setLoad((current) => (current.status === 'ready' ? current : { status: 'error', message: apiErrorMessage(error) }));
    }
  }, []);

  // O número do shell mudou (chegou ou foi respondida uma aprovação): relê já, em vez de esperar o próximo ciclo.
  useEffect(() => {
    void refresh();
  }, [refresh, count]);

  const hasPending = load.status === 'ready' && load.pending.length > 0;
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) void refresh();
    };
    const timer = setInterval(tick, hasPending ? POLL_BUSY_MS : POLL_IDLE_MS);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [hasPending, refresh]);

  const retry = useCallback(() => {
    setLoad({ status: 'loading' });
    void refresh();
  }, [refresh]);

  return { load, retry };
}
