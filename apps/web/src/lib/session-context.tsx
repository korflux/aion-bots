'use client';

// Contexto da sessão no cliente: dono e token CSRF, entregues pelo layout autenticado (que já validou a
// sessão no servidor). Os componentes usam `useSession()` para chamar a API com o CSRF certo.
import type { SessionInfo } from '@aion/shared';
import { createContext, useContext, type ReactNode } from 'react';

const SessionContext = createContext<SessionInfo | null>(null);

export function SessionProvider({ session, children }: { session: SessionInfo; children: ReactNode }) {
  return <SessionContext value={session}>{children}</SessionContext>;
}

/** Sessão corrente; só existe dentro do layout autenticado. */
export function useSession(): SessionInfo {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession fora do SessionProvider');
  return session;
}
