'use client';

// Corpo do painel da seção Rotinas (plugado em nav-config; design: Rotinas): filtros em pílulas (Ativas, Pausadas, Concluídas) e as
// rotinas agrupadas por bot. Cada grupo mostra a Faísca do bot (24 px, parada), e cada item o nome, a agenda legível e a próxima execução; uma rotina
// pausada fica em `--text-subtle` com o ícone de pausa. O botão de nova rotina fica no cabeçalho do painel (ação declarada em nav-config)
// e o menu de ações (`RoutineMenu`) em cada item. Os dados vêm do store compartilhado, então criar, editar ou pausar atualiza o painel.
import type { RoutineStatus, RoutineView } from '@aion/shared';
import { Pause } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { cn } from '@/lib/cn';
import { formatNextRun } from '@/lib/format';
import { RoutineMenu } from './routine-menu';
import { ROUTINE_FILTERS, groupByBot, refreshRoutines, useRoutines } from './routines-store';

/** Segunda linha do item: a próxima execução, ou o estado quando não há. */
function nextLine(routine: RoutineView): string {
  if (routine.status === 'completed') return 'Concluída';
  if (routine.status === 'paused') return 'Pausada';
  return routine.nextRunAt ? `Próxima: ${formatNextRun(routine.nextRunAt, routine.timezone)}` : 'Sem próxima execução';
}

/** Linha navegável da rotina com agenda, estado e menu independente; excluir a rotina aberta devolve à seção. */
function RoutineItem({ routine, current }: { routine: RoutineView; current: boolean }) {
  const router = useRouter();
  const paused = routine.status === 'paused';
  return (
    <li className={cn('group flex items-center rounded-sm transition-colors hover:bg-surface-hover', current && 'bg-selected hover:bg-selected')}>
      <Link
        href={`/rotinas/${routine.id}`}
        title={routine.name}
        aria-current={current ? 'page' : undefined}
        className={cn(
          'flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 px-3 py-1.5 text-sm',
          paused ? (current ? 'text-muted' : 'text-subtle') : current ? 'font-medium text-fg' : 'text-muted',
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {paused ? <Pause className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden /> : null}
          <span className="min-w-0 truncate">{routine.name}</span>
        </span>
        <span className="truncate text-xs text-muted">{routine.summary}</span>
        <span className="truncate text-xs text-muted">{nextLine(routine)}</span>
      </Link>
      <RoutineMenu routine={routine} onDeleted={() => (current ? router.push('/rotinas') : undefined)} />
    </li>
  );
}

/** Lista desktop por estado e bot, atualizada pelo store compartilhado da seção. */
export function RoutinesPanel() {
  const { status, routines } = useRoutines();
  const pathname = usePathname();
  const [filter, setFilter] = useState<RoutineStatus>('active');

  if (status === 'idle' || (status === 'loading' && routines.length === 0)) {
    return (
      <div role="status" aria-busy="true" aria-label="Carregando rotinas" className="flex flex-col gap-1.5 px-1 pt-1">
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-11 animate-pulse rounded-sm bg-surface" />
        ))}
      </div>
    );
  }

  if (status === 'error' && routines.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 px-3 py-2">
        <p className="text-sm text-danger">Não foi possível carregar as rotinas.</p>
        <button type="button" onClick={() => void refreshRoutines()} className="rounded-sm text-sm font-medium text-fg underline underline-offset-4">
          Tentar novamente
        </button>
      </div>
    );
  }

  if (routines.length === 0) return <p className="px-3 py-2 text-sm text-subtle">Nenhuma rotina.</p>;

  const shown = routines.filter((routine) => routine.status === filter);
  const groups = groupByBot(shown);
  const filterLabel = ROUTINE_FILTERS.find((item) => item.id === filter)?.label.toLowerCase() ?? '';

  return (
    <>
      <div role="group" aria-label="Filtrar rotinas" className="mb-2 flex flex-wrap gap-1 px-1">
        {ROUTINE_FILTERS.map((item) => {
          const selected = item.id === filter;
          const total = routines.filter((routine) => routine.status === item.id).length;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              onClick={() => setFilter(item.id)}
              className={cn(
                'h-8 rounded-full border px-2.5 text-xs font-medium transition-colors max-md:h-10',
                selected ? 'border-transparent bg-selected text-fg' : 'border-line text-muted hover:bg-surface-hover hover:text-fg',
              )}
            >
              {item.label} <span className="tabular-nums">{total}</span>
            </button>
          );
        })}
      </div>

      {groups.length === 0 ? (
        <p className="px-3 py-2 text-sm text-subtle">Nenhuma rotina {filterLabel}.</p>
      ) : (
        groups.map((group) => (
          <section key={group.bot.id} aria-label={`Rotinas de ${group.bot.name}`} className="mt-3 first:mt-0">
            <h3 className="flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-subtle">
              <BotAvatar owner={group.bot} size={24} still />
              <span className="min-w-0 truncate" title={group.bot.name}>
                {group.bot.name}
              </span>
            </h3>
            <ul className="flex flex-col gap-0.5">
              {group.routines.map((routine) => (
                <RoutineItem
                  key={routine.id}
                  routine={routine}
                  current={pathname === `/rotinas/${routine.id}` || pathname.startsWith(`/rotinas/${routine.id}/`)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
