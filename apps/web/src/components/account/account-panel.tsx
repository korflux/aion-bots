'use client';

// Configurações → Conta e segurança: dono (somente leitura), autenticador TOTP (ativar e desativar), sessões por dispositivo
// (encerrar cada uma) e Sair. Toda alteração vai à API com o token CSRF da sessão; a revogação acontece no servidor.
// O título e a coluna são da moldura da área (`SettingsArea`, phase 5, T4); este painel só desenha as seções.
import type { SessionSummary } from '@aion/shared';
import { LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { TotpSection } from '@/components/account/totp-section';
import { Button } from '@/components/ui/button';
import { apiErrorMessage, apiFetch, beginSignOut } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/format';
import { useSession } from '@/lib/session-context';

const sectionTitle = 'mb-2 text-xs font-medium uppercase tracking-wide text-subtle';

/** Preferências de segurança e dispositivos do dono; a sessão vem do layout autenticado e a revogação continua exclusiva do servidor. */
export function AccountPanel() {
  const session = useSession();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  // Instante da última carga: o horário relativo é calculado a partir dele, mantendo a renderização pura.
  const [loadedAt, setLoadedAt] = useState<Date>(() => new Date(0));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  // Incrementar força uma nova carga da lista (depois de encerrar uma sessão).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ sessions: SessionSummary[] }>('/api/auth/sessions').then(
      (data) => {
        if (cancelled) return;
        setSessions(data.sessions);
        setLoadedAt(new Date());
        setLoadError(null);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(apiErrorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  /** Encerra outra sessão e relê a lista autoritativa sem afetar a navegação deste dispositivo. */
  async function revoke(id: string) {
    setBusyId(id);
    try {
      await apiFetch(`/api/auth/sessions/${id}`, { method: 'DELETE', csrfToken: session.csrfToken });
      toast('Sessão encerrada');
      setReloadKey((key) => key + 1);
    } catch (error) {
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setBusyId(null);
    }
  }

  /** Saída voluntária sempre termina no login, inclusive se a sessão já venceu ou a revogação falhou. */
  async function signOut() {
    setLeaving(true);
    beginSignOut();
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', csrfToken: session.csrfToken, redirectOnExpired: false });
    } catch {
      // Se a sessão já não existe no servidor, sair localmente é o resultado esperado.
    }
    window.location.assign('/login');
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="conta-dono">
        <h2 id="conta-dono" className={sectionTitle}>
          Dono
        </h2>
        <p className="text-sm text-fg">{session.owner.email}</p>
        <p className="mt-1 text-xs text-subtle">O e-mail e a senha são definidos nas variáveis de ambiente do servidor.</p>
      </section>

      <section aria-labelledby="conta-autenticador">
        <h2 id="conta-autenticador" className={sectionTitle}>
          Autenticador
        </h2>
        <TotpSection />
      </section>

      <section aria-labelledby="conta-sessoes">
        <h2 id="conta-sessoes" className={sectionTitle}>
          Sessões
        </h2>
        {loadError ? (
          <p role="alert" className="text-sm text-danger">
            {loadError}
          </p>
        ) : sessions === null ? (
          <div aria-busy="true" aria-label="Carregando sessões" className="flex flex-col gap-2">
            {[0, 1].map((row) => (
              <div key={row} className="h-11 animate-pulse rounded-md bg-surface" />
            ))}
          </div>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {sessions.map((item) => (
              <li key={item.id} className="flex min-h-14 items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                    <span className="truncate">{item.device}</span>
                    {item.current ? (
                      <span className="rounded-sm bg-surface-hover px-1.5 py-0.5 text-xs font-medium text-muted">Esta sessão</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted">Último uso: {formatRelativeTime(item.lastUsedAt, loadedAt)}</p>
                </div>
                {item.current ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyId === item.id}
                    onClick={() => void revoke(item.id)}
                    aria-label={`Encerrar sessão de ${item.device}`}
                  >
                    Encerrar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div>
        <Button variant="secondary" onClick={() => void signOut()} disabled={leaving}>
          <LogOut className="size-4" strokeWidth={1.5} aria-hidden />
          Sair
        </Button>
      </div>
    </div>
  );
}
