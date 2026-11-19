'use client';

// "Execuções recentes" de Configurações → Atividade e arquivos (F15, A14; phase 5, T4): as execuções de todos os bots e do chat geral, com origem, estado
// e horário. É um ÍNDICE: cada item leva ao cartão na conversa do dono (bot ou sessão do chat geral). As aprovações pendentes ("Aguardando você") saíram
// daqui na phase 5 e vivem no topo de Aprovações (`approvals/pending-section.tsx`); a aprovação é respondida na conversa, nunca aqui.
// A única ação direta é "Parar" numa execução ativa (a mesma de F7).
//
// Dados: `GET /api/activities` (a primeira página traz também as pendências, que esta tela ignora; "Carregar mais" traz as execuções seguintes por cursor). A tela
// se atualiza sozinha por releitura da primeira página (não há canal de eventos global como o SSE da conversa): a cada 15 s, a cada 5 s
// enquanto há execução em andamento, a cada 1,5 s logo depois de pedir uma parada, e ao voltar o foco para a janela.
// A releitura é combinada com o que já foi carregado (`mergeFirstPage`), então "Carregar mais" não se perde. Falha numa releitura de fundo
// mantém a tela como está; só a primeira carga mostra o erro.
import type { RecentActivity } from '@aion/shared';
import { Activity } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { notifyApprovalsChanged } from '@/components/approvals/pending-approvals';
import { stopRun } from '@/components/conversation/conversation-api';
import { EmptyState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { useNow } from '@/lib/use-now';
import { fetchActivities } from './activities-api';
import { appendPage, conversationSourceOf, hasOpenWork, mergeFirstPage, type Recents } from './activities-state';
import { RecentRow } from './activity-rows';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; recents: Recents };

const POLL_IDLE_MS = 15_000;
const POLL_BUSY_MS = 5_000;
const POLL_STOPPING_MS = 1_500;

const sectionTitle = 'mb-2 text-sm font-medium text-fg';

export function ActivitiesView() {
  const { csrfToken } = useSession();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  /** Execuções cuja parada já foi aceita pela API; o botão fica "Parando…" até a linha deixar de ser ativa. */
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const now = useNow(30_000);

  /** Relê a primeira página e a combina com o que a tela já carregou. */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const fresh = await fetchActivities(null);
      setLoad((current) => ({
        status: 'ready',
        recents: current.status === 'ready' ? mergeFirstPage(current.recents, fresh) : { items: fresh.items, nextCursor: fresh.nextCursor },
      }));
    } catch (error) {
      setLoad((current) => (current.status === 'ready' ? current : { status: 'error', message: apiErrorMessage(error) }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const busy = load.status === 'ready' && hasOpenWork(load.recents);
  const pollMs = stopping.size > 0 ? POLL_STOPPING_MS : busy ? POLL_BUSY_MS : POLL_IDLE_MS;
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) void refresh();
    };
    const timer = setInterval(tick, pollMs);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [pollMs, refresh]);

  /** "Carregar mais": a página seguinte por cursor, acrescentada sem repetir o que uma releitura já trouxe. */
  async function loadMore(): Promise<void> {
    if (load.status !== 'ready' || load.recents.nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchActivities(load.recents.nextCursor);
      setLoad((current) => (current.status === 'ready' ? { ...current, recents: appendPage(current.recents, page) } : current));
    } catch (error) {
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setLoadingMore(false);
    }
  }

  /** Parar a execução da linha (do bot ou da sessão). Com `runId`, a API recusa se a lista estava desatualizada (a execução já terminou). */
  async function stop({ runId, ...owner }: RecentActivity): Promise<void> {
    setStopping((current) => new Set(current).add(runId));
    try {
      await stopRun(conversationSourceOf(owner), csrfToken, runId);
      // Parar uma execução que esperava aprovação cancela o pedido: o badge da barra precisa reler.
      notifyApprovalsChanged();
    } catch (error) {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(runId);
        return next;
      });
      // RUN_NOT_ACTIVE é informativo (a execução acabou no meio do clique), não erro.
      if (error instanceof ApiError && error.code === 'RUN_NOT_ACTIVE') toast('Esta execução já terminou.');
      else toast.error(apiErrorMessage(error), { duration: Infinity });
    }
    void refresh();
  }

  if (load.status === 'loading') {
    return (
      <div role="status" aria-busy="true" aria-label="Carregando atividades" className="flex flex-col gap-3 py-2">
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-11 animate-pulse rounded-md bg-surface" />
        ))}
      </div>
    );
  }

  if (load.status === 'error') {
    return (
      <EmptyState
        icon={Activity}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setLoad({ status: 'loading' });
              void refresh();
            }}
          >
            Tentar novamente
          </Button>
        }
      >
        {load.message}
      </EmptyState>
    );
  }

  const { recents } = load;
  if (recents.items.length === 0) return <EmptyState icon={Activity}>Nada por aqui ainda.</EmptyState>;

  return (
    <section aria-labelledby="atividades-recentes">
      <h2 id="atividades-recentes" className={sectionTitle}>
        Execuções recentes
      </h2>
      <ul>
        {recents.items.map((item) => (
          <RecentRow key={item.runId} item={item} now={now} stopping={stopping.has(item.runId)} onStop={(target) => void stop(target)} />
        ))}
      </ul>
      {recents.nextCursor !== null ? (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
            Carregar mais
          </Button>
        </div>
      ) : null}
    </section>
  );
}
