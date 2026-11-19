'use client';

// Lista de sessões do chat geral no cliente: uma única cópia compartilhada entre o painel da seção Chat geral (que vive no shell) e as
// páginas (início do chat e a sessão aberta), para criar uma sessão, salvar ou mandar a primeira mensagem (que dá o título) atualizar o
// painel na hora. Mesmo desenho do `bots-store`: store de módulo (o painel é renderizado pelo shell, acima das páginas), preenchido só no
// navegador, e zerado a cada login e logout (carga completa da página).
//
// Não lido (phase 3, F4/A7): cada sessão traz `unread`, e quem MOSTRA a bolinha (o painel e a barra de ícones) usa `useLiveChatSessions`, que mantém
// uma releitura periódica de 15 s compartilhada (`createLivePoll`, o mesmo relógio da lista de bots): a leitura feita em outro aparelho apaga a bolinha
// aqui no ciclo seguinte.
import type { ChatSession, ChatSessionList } from '@aion/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '@/lib/api-client';
import { createLivePoll } from '@/lib/live-poll';
import { byRecentActivity } from './chat-state';

export interface ChatSessionsState {
  /** `idle`: ainda não pediu; `loading`: primeira carga; `ready`: lista válida; `error`: a última carga falhou. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  sessions: readonly ChatSession[];
}

const INITIAL: ChatSessionsState = { status: 'idle', sessions: [] };

let state: ChatSessionsState = INITIAL;
let requestId = 0;
const listeners = new Set<() => void>();

function publish(next: ChatSessionsState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Intervalo da releitura de fundo da lista (o mesmo ciclo ocioso da lista de bots: a bolinha some em até 15 s depois da leitura em outro aparelho). */
export const CHAT_SESSIONS_POLL_MS = 15_000;

/** Mesma lista, item a item: uma releitura de fundo sem mudança não acorda nenhuma tela. */
export const sameSessions = (a: readonly ChatSession[], b: readonly ChatSession[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Recarrega a lista na API. Respostas antigas (de uma chamada anterior que demorou) são descartadas. `background` é a releitura periódica: nunca
 * mostra "carregando" nem erro (falhou, o último estado continua valendo) e, sem mudança, não publica. Ao terminar, programa a próxima releitura.
 */
export async function refreshChatSessions({ background = false }: { background?: boolean } = {}): Promise<void> {
  const mine = ++requestId;
  // Mantém a lista atual à vista durante recargas; só a primeira carga mostra o carregando.
  if (!background && (state.status === 'idle' || state.status === 'error')) publish({ status: 'loading', sessions: state.sessions });
  try {
    const data = await apiFetch<ChatSessionList>('/api/chat/sessions');
    if (mine === requestId && !(state.status === 'ready' && sameSessions(state.sessions, data.items))) publish({ status: 'ready', sessions: data.items });
  } catch {
    if (mine === requestId && !background) publish({ status: 'error', sessions: state.sessions });
  } finally {
    livePoll.schedule();
  }
}

const livePoll = createLivePoll({
  refresh: () => void refreshChatSessions({ background: true }),
  delay: () => CHAT_SESSIONS_POLL_MS,
  settled: () => state.status === 'ready' || state.status === 'error',
});

/**
 * A sessão acabou de ser lida NESTE aparelho (a presença gravou a leitura no servidor): apaga a bolinha na hora, sem esperar o próximo ciclo. Só com a
 * lista pronta (invalidar a primeira carga deixaria o painel em "carregando"); a releitura em andamento é invalidada por poder ser anterior à leitura.
 * ponytail: uma novidade chegada entre a leitura e esta marcação fica escondida até o próximo ciclo (no máximo 15 s), aceitável para a bolinha.
 */
export function markChatSessionRead(id: string): void {
  if (state.status !== 'ready' || !state.sessions.some((session) => session.id === id && session.unread)) return;
  requestId += 1;
  publish({ ...state, sessions: state.sessions.map((session) => (session.id === id ? { ...session, unread: false } : session)) });
}

/**
 * Coloca uma sessão (criada ou alterada) na lista sem esperar a recarga e a devolve. Uma recarga em andamento é invalidada: ela pode ter
 * lido o banco antes desta alteração e sobrescreveria o que a tela acabou de mostrar.
 */
export function upsertChatSession(session: ChatSession): ChatSession {
  requestId += 1;
  const others = state.sessions.filter((item) => item.id !== session.id);
  publish({ status: state.status === 'idle' ? 'idle' : 'ready', sessions: [session, ...others].sort(byRecentActivity) });
  return session;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Estado da lista de sessões; dispara a primeira carga quando o primeiro componente a usa. */
export function useChatSessions(): ChatSessionsState {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => INITIAL);
  useEffect(() => {
    if (state.status === 'idle') void refreshChatSessions();
  }, []);
  return snapshot;
}

/** `useChatSessions` mais a releitura periódica (não lido) enquanto o componente estiver montado: o hook do painel e da barra de ícones. */
export function useLiveChatSessions(): ChatSessionsState {
  const snapshot = useChatSessions();
  useEffect(() => livePoll.watch(), []);
  return snapshot;
}

/** A rota atual é esta sessão do Chat geral? É o "item aberto" do painel e da navegação. */
export const sessionIsOpen = (pathname: string, id: string): boolean => pathname === `/chat/${id}`;
