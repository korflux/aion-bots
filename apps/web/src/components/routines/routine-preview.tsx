'use client';

// Prévia das próximas execuções (design: Editor de rotina → Prévia): título "Próximas execuções" e 5 linhas com data, hora e dia da
// semana NO FUSO DA ROTINA; se o fuso difere do navegador, cada linha mostra também o horário local em `caption`. Agenda inválida
// mostra "Agenda inválida: <motivo>" no lugar das datas. A prévia se atualiza a cada alteração (com um pequeno atraso para não
// chamar a API a cada tecla) e usa o MESMO motor do servidor (`POST /api/routines/preview`), então "o que a prévia mostra é o que
// vai rodar".
import type { RoutineScheduleSettings } from '@aion/shared';
import { useEffect, useState } from 'react';
import { browserTimeZone, formatDateTimeInZone } from '@/lib/format';
import { apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { previewSchedule } from './routines-api';

/** Espera depois da última alteração antes de pedir a prévia. */
const DEBOUNCE_MS = 300;

export type PreviewState =
  | { status: 'incomplete' }
  | { status: 'loading' }
  | { status: 'ready'; description: string; occurrences: string[] }
  | { status: 'invalid'; reason: string }
  | { status: 'error'; message: string };

/**
 * Prévia da agenda do formulário. `settings` nulo = agenda incompleta (nada a pedir). O resultado guarda a chave do que foi pedido:
 * enquanto a chave guardada difere da atual, a prévia está "calculando", sem precisar de setState síncrono dentro do efeito.
 */
export function usePreview(settings: RoutineScheduleSettings | null): PreviewState {
  const { csrfToken } = useSession();
  const key = settings === null ? null : JSON.stringify(settings);
  const [answer, setAnswer] = useState<{ key: string; state: PreviewState } | null>(null);

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      previewSchedule(JSON.parse(key) as RoutineScheduleSettings, csrfToken).then(
        (preview) => {
          if (cancelled) return;
          setAnswer({
            key,
            state: preview.valid
              ? { status: 'ready', description: preview.description ?? '', occurrences: preview.occurrences }
              : { status: 'invalid', reason: preview.reason ?? 'Agenda inválida.' },
          });
        },
        (error: unknown) => {
          if (!cancelled) setAnswer({ key, state: { status: 'error', message: apiErrorMessage(error) } });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, csrfToken]);

  if (key === null) return { status: 'incomplete' };
  return answer?.key === key ? answer.state : { status: 'loading' };
}

export function RoutinePreview({ state, timezone }: { state: PreviewState; timezone: string }) {
  const local = browserTimeZone();

  return (
    <section aria-labelledby="previa-titulo" className="rounded-md border border-line bg-surface grad-sheen p-4">
      <h2 id="previa-titulo" className="text-xs font-medium uppercase tracking-wide text-subtle">
        Próximas execuções
      </h2>
      <p className="mt-2 break-words text-xs text-subtle">Fuso: {timezone}</p>
      <div aria-live="polite" className="mt-3 min-h-56 text-sm">
        {state.status === 'incomplete' ? <p className="text-muted">Complete a agenda para ver as próximas execuções.</p> : null}
        {state.status === 'loading' ? <p className="text-muted">Calculando…</p> : null}
        {state.status === 'error' ? <p className="text-danger">{state.message}</p> : null}
        {state.status === 'invalid' ? (
          <p data-testid="previa-invalida" className="text-danger">
            Agenda inválida: {state.reason}
          </p>
        ) : null}
        {state.status === 'ready' ? (
          <>
            <p className="mb-3 text-muted">{state.description}</p>
            <ol className="flex flex-col gap-2.5">
              {state.occurrences.map((iso) => {
                const inRoutineZone = formatDateTimeInZone(iso, timezone);
                const inLocalZone = local !== null && local !== timezone ? formatDateTimeInZone(iso, local) : null;
                return (
                  <li key={iso} className="flex flex-col">
                    <time dateTime={iso} className="tabular-nums text-fg">{inRoutineZone}</time>
                    {inLocalZone !== null && inLocalZone !== inRoutineZone ? <span className="text-xs tabular-nums text-subtle">No seu horário: {inLocalZone}</span> : null}
                  </li>
                );
              })}
            </ol>
          </>
        ) : null}
      </div>
    </section>
  );
}
