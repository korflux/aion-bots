// Layout das rotas autenticadas. A sessão é validada NO SERVIDOR a cada carga (a API confere hash, validade
// e revogação): sem sessão válida o dono vai ao login com o destino preservado. Com sessão, o shell e o
// contexto (dono + token CSRF) envolvem as páginas.
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { PushProvider } from '@/components/push/push-provider';
import { AppShell } from '@/components/shell/app-shell';
import { DEFAULT_AFTER_LOGIN } from '@/lib/auth/next-path';
import { fetchSession } from '@/lib/server-session';
import { SessionProvider } from '@/lib/session-context';

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const session = await fetchSession();
  if (!session) {
    // O proxy grava o caminho atual neste cabeçalho; o login valida o valor antes de usá-lo.
    const path = (await headers()).get('x-aion-path') ?? DEFAULT_AFTER_LOGIN;
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  return (
    <SessionProvider session={session}>
      <PushProvider>
        <AppShell>{children}</AppShell>
      </PushProvider>
    </SessionProvider>
  );
}
