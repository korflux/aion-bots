// Verificação da sessão no servidor do Next (Server Components). É a autoridade das páginas autenticadas:
// o cookie do navegador é repassado à API, que valida hash, validade e revogação. Só roda no servidor.
import { SESSION_COOKIE_NAME, sessionInfoSchema, type SessionInfo } from '@aion/shared';
import { cookies } from 'next/headers';

/** URL interna da API (rede do Easypanel ou localhost). Lida em tempo de execução, não de build. */
function apiInternalUrl(): string {
  return process.env.AION_API_INTERNAL_URL ?? 'http://localhost:3001';
}

/**
 * Sessão corrente ou `null` se não há sessão válida (sem cookie, vencida ou revogada).
 * Falha da API (fora do ar) NÃO vira `null`: lança, para o dono ver "indisponível" e não ser deslogado por engano.
 */
export async function fetchSession(): Promise<SessionInfo | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const response = await fetch(`${apiInternalUrl()}/api/auth/session`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    cache: 'no-store',
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`API indisponível (${response.status})`);
  return sessionInfoSchema.parse(await response.json());
}
