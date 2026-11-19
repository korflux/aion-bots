'use client';

// Histórico de uma rotina (F12 passo 5; design: Histórico da rotina): tabela com Previsto, Real, Estado e Ação ("Ver na conversa", que leva
// ao cartão da execução na conversa do bot). Cada linha é um horário previsto já tratado: executado (com o estado da execução), perdido
// (serviço parado há mais de 60 minutos), pulado (a anterior ainda esperava na fila, ou a rotina foi pausada antes de começar) ou manual
// ("Executar agora"). Em 375 px cada linha vira um bloco empilhado. Paginação por "Carregar mais".
import { ROUTINE_HISTORY_LABELS, type RoutineHistoryItem, type RoutineHistoryState, type RoutineView } from '@aion/shared';
import { ArrowLeft, History } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { STATUS_TONE } from '@/components/activities/activities-state';
import { BotLoadError, BotLoading } from '@/components/bots/bot-states';
import { EmptyState } from '@/components/page';
import { BackLink } from '@/components/shell/back-link';
import { StatusBadge, type BadgeTone } from '@/components/settings/status-badge';
import { Button } from '@/components/ui/button';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { formatDateTimeInZone } from '@/lib/format';
import { fetchRoutine, fetchRoutineHistory } from './routines-api';
import { RoutineNotFound } from './routine-states';

/** Tom do selo: o dos estados de execução (fonte única em Atividades) mais os dois que só existem no histórico da rotina. */
const TONE: Record<RoutineHistoryState, BadgeTone> = { ...STATUS_TONE, missed: 'warning', skipped: 'neutral' };

type Load =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; routine: RoutineView; items: RoutineHistoryItem[]; nextCursor: string | null };

export function RoutineHistoryView({ routineId }: { routineId: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchRoutine(routineId), fetchRoutineHistory(routineId, null)]).then(
      ([routine, page]) => {
        if (!cancelled) setLoad({ status: 'ready', routine, items: page.items, nextCursor: page.nextCursor });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'ROUTINE_NOT_FOUND') setLoad({ status: 'not-found' });
        else setLoad({ status: 'error', message: error instanceof ApiError ? error.message : 'Não foi possível carregar o histórico.' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [routineId, attempt]);

  const loadMore = useCallback(async () => {
    if (load.status !== 'ready' || load.nextCursor === null) return;
    setLoadingMore(true);
    try {
      const page = await fetchRoutineHistory(routineId, load.nextCursor);
      setLoad((current) => (current.status === 'ready' ? { ...current, items: [...current.items, ...page.items], nextCursor: page.nextCursor } : current));
    } catch (error) {
      setLoad({ status: 'error', message: apiErrorMessage(error) });
    } finally {
      setLoadingMore(false);
    }
  }, [load, routineId]);

  if (load.status === 'loading') return <BotLoading label="Carregando histórico" />;
  if (load.status === 'not-found') return <RoutineNotFound />;
  if (load.status === 'error') {
    return (
      <BotLoadError
        message={load.message}
        onRetry={() => {
          setLoad({ status: 'loading' });
          setAttempt((value) => value + 1);
        }}
      />
    );
  }

  const { routine, items, nextCursor } = load;
  return (
    <div className="mx-auto w-full max-w-[920px]">
      <header className="flex min-h-[52px] items-center gap-2 px-4 md:gap-3 md:px-6">
        {/* No celular o "Voltar" é o do pai fixo (Rotinas, `BackLink`); no desktop segue o atalho para o editor da rotina. */}
        <BackLink />
        <Button asChild variant="ghost" size="icon" className="max-md:hidden">
          <Link href={`/rotinas/${routine.id}`} aria-label="Voltar para a rotina">
            <ArrowLeft className="size-4" strokeWidth={1.5} aria-hidden />
          </Link>
        </Button>
        <h1 className="min-w-0 truncate text-[18px]/[26px] font-semibold text-fg" title={routine.name}>
          Histórico: {routine.name}
        </h1>
      </header>

      {items.length === 0 ? (
        <EmptyState icon={History}>Ainda não executou.</EmptyState>
      ) : (
        <div className="px-4 pb-10 md:px-6">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Execuções de {routine.name}</caption>
            <thead className="max-md:sr-only">
              <tr className="border-b border-line text-xs font-medium uppercase tracking-wide text-subtle">
                <th scope="col" className="py-2 pr-4 font-medium">Previsto</th>
                <th scope="col" className="py-2 pr-4 font-medium">Real</th>
                <th scope="col" className="py-2 pr-4 font-medium">Estado</th>
                <th scope="col" className="py-2 font-medium">Ação</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-line max-md:flex max-md:flex-wrap max-md:items-center max-md:justify-between max-md:gap-x-4 max-md:gap-y-1 max-md:py-3">
                  <td className="py-3 pr-4 tabular-nums max-md:p-0">
                    <span className="md:hidden text-xs text-subtle">Previsto: </span>
                    {formatDateTimeInZone(item.scheduledFor, routine.timezone)}
                    {item.manual ? <span className="ml-2 text-xs text-subtle">(manual)</span> : null}
                  </td>
                  <td className="py-3 pr-4 tabular-nums text-muted max-md:order-3 max-md:w-full max-md:p-0 max-md:text-xs">
                    <span className="md:hidden text-subtle">Real: </span>
                    {item.startedAt ? formatDateTimeInZone(item.startedAt, routine.timezone) : '—'}
                  </td>
                  <td className="py-3 pr-4 max-md:p-0">
                    <StatusBadge tone={TONE[item.state]}>{ROUTINE_HISTORY_LABELS[item.state]}</StatusBadge>
                  </td>
                  <td className="py-3 max-md:order-4 max-md:p-0">
                    {item.messageId ? (
                      <Link href={`/bots/${routine.bot.id}?mensagem=${item.messageId}`} className="text-fg underline underline-offset-4">
                        Ver na conversa
                      </Link>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor !== null ? (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                Carregar mais
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
