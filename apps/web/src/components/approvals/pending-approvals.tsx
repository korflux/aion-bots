'use client';

// Número de aprovações pendentes (badge do ícone Aprovações na barra; design: "oculto em zero, 9+ acima de 9"). O número vem de
// `GET /api/approvals/pending-count` e é atualizado: ao montar, a cada 15 s, quando a janela volta ao foco e quando outro
// componente avisa que algo mudou (`notifyApprovalsChanged`: chegou um cartão de aprovação pelo SSE, ou o dono respondeu a um).
// Falha de rede NÃO zera o número: mantém o último valor conhecido até a próxima tentativa.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchPendingCount } from './approvals-api';

const CHANGED_EVENT = 'aion:approvals-changed';
const REFRESH_MS = 15_000;

/** Pede a todos os interessados (o badge) que releiam o número de pendências. */
export const notifyApprovalsChanged = (): void => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED_EVENT));
};

const PendingContext = createContext(0);

export function PendingApprovalsProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    /** Relê o número; sem conexão agora, o valor anterior continua válido até o próximo ciclo. */
    const refresh = () => {
      fetchPendingCount().then(
        (pending) => {
          if (!cancelled) setCount(pending.count);
        },
        () => undefined,
      );
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener(CHANGED_EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(CHANGED_EVENT, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return <PendingContext value={count}>{children}</PendingContext>;
}

/** Aprovações pendentes agora (0 fora do provedor). */
export const usePendingApprovals = (): number => useContext(PendingContext);
