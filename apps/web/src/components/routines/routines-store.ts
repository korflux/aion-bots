'use client';

// Lista de rotinas no cliente: uma única cópia compartilhada entre o painel da seção Rotinas (que vive no shell) e as páginas
// (editor, histórico, cartões da conversa), para que criar, editar, pausar ou excluir atualize o painel na hora. Mesmo desenho do
// `bots-store`: store de módulo (o painel é renderizado pelo shell, acima das páginas), só preenchido no navegador (o servidor
// devolve sempre o estado `idle`, então nada vaza entre requisições do SSR) e zerado por login e logout, que recarregam a página.
import type { RoutineStatus, RoutineView } from '@aion/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '@/lib/api-client';

export interface RoutinesState {
  /** `idle`: ainda não pediu; `loading`: primeira carga; `ready`: lista válida; `error`: a última carga falhou. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  routines: readonly RoutineView[];
}

const INITIAL: RoutinesState = { status: 'idle', routines: [] };

let state: RoutinesState = INITIAL;
let requestId = 0;
const listeners = new Set<() => void>();

function publish(next: RoutinesState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Recarrega a lista na API. Respostas antigas (de uma chamada anterior que demorou) são descartadas. */
export async function refreshRoutines(): Promise<void> {
  const mine = ++requestId;
  // Mantém a lista atual à vista durante recargas; só a primeira carga mostra o carregando.
  if (state.status === 'idle' || state.status === 'error') publish({ status: 'loading', routines: state.routines });
  try {
    const data = await apiFetch<{ routines: RoutineView[] }>('/api/routines');
    if (mine === requestId) publish({ status: 'ready', routines: data.routines });
  } catch {
    if (mine === requestId) publish({ status: 'error', routines: state.routines });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Estado da lista de rotinas. Quem a usa recarrega ao montar: a lista muda por fora (arquivar um bot pausa as rotinas dele). */
export function useRoutines(): RoutinesState {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => INITIAL);
  useEffect(() => {
    void refreshRoutines();
  }, []);
  return snapshot;
}

/** Filtros do painel (design: pílulas Ativas, Pausadas, Concluídas). */
export const ROUTINE_FILTERS: readonly { id: RoutineStatus; label: string }[] = [
  { id: 'active', label: 'Ativas' },
  { id: 'paused', label: 'Pausadas' },
  { id: 'completed', label: 'Concluídas' },
];

export interface RoutineGroup {
  bot: RoutineView['bot'];
  routines: RoutineView[];
}

/** Agrupa por bot mantendo a ordem da API (já alfabética por bot e por nome). */
export function groupByBot(routines: readonly RoutineView[]): RoutineGroup[] {
  const groups: RoutineGroup[] = [];
  for (const routine of routines) {
    const last = groups.at(-1);
    if (last && last.bot.id === routine.bot.id) last.routines.push(routine);
    else groups.push({ bot: routine.bot, routines: [routine] });
  }
  return groups;
}
