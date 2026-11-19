'use client';

// Lista de bots no cliente: uma única cópia compartilhada entre o painel da seção Bots (que vive no shell) e as
// páginas (editor, conversa), para que criar, editar, arquivar ou desarquivar atualize o painel na hora.
//
// Por que um store de módulo e não um Context: o painel é renderizado pelo shell, ACIMA das páginas, e o layout
// do shell é da T1; o store dispensa um provider novo no topo da árvore. Ele só é preenchido no navegador (o
// servidor devolve sempre o estado `idle`), então nada vaza entre requisições do SSR. Login e logout usam
// carga completa da página, o que zera o store entre sessões.
//
// Estado ao vivo (F10, A12): cada item da lista traz o `runState` do bot (o que ele faz agora). Quem MOSTRA esse estado (o painel de bots, o
// cabeçalho da conversa) usa `useLiveBots`, que mantém UMA releitura periódica compartilhada: painel e cabeçalho são assinantes da mesma
// releitura, nunca vários relógios. Cadência de 5 s se algum
// bot estiver em movimento (trabalhando, aguardando ou recém-concluído), senão 15 s; parada com a aba oculta (volta ao ficar visível, relendo na hora);
// relê ao montar. Uma falha de fundo é silenciosa e mantém o último estado.
import { BUSY_RUN_STATES, type BotSummary } from '@aion/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '@/lib/api-client';
import { createLivePoll } from '@/lib/live-poll';

/** Intervalo da releitura da lista enquanto algum bot está trabalhando, aguardando aprovação ou acabou de concluir (`BUSY_RUN_STATES`). */
export const LIVE_POLL_BUSY_MS = 5_000;
/** Intervalo da releitura da lista quando nenhum bot está em movimento. */
export const LIVE_POLL_IDLE_MS = 15_000;

export interface BotsState {
  /** `idle`: ainda não pediu; `loading`: primeira carga; `ready`: lista válida; `error`: a última carga falhou. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  bots: readonly BotSummary[];
}

const INITIAL: BotsState = { status: 'idle', bots: [] };

let state: BotsState = INITIAL;
let requestId = 0;
const listeners = new Set<() => void>();

function publish(next: BotsState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Estado atual do store (o mesmo valor que `useBots` entrega ao React; os testes o leem por aqui). */
export const getBotsState = (): BotsState => state;

/** Mesma lista, item a item (as chaves vêm sempre na mesma ordem do servidor): uma releitura sem mudança não deve acordar nenhuma tela. */
const sameBots = (a: readonly BotSummary[], b: readonly BotSummary[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Recarrega a lista na API. Respostas antigas (de uma chamada anterior que demorou) são descartadas. `background` é a releitura periódica: ela nunca
 * mostra "carregando" nem erro (falhou, o último estado continua valendo) e, se nada mudou, não publica. Qualquer releitura, ao terminar, reprograma a
 * próxima da cadência (`scheduleNextPoll`), então uma releitura manual (depois de editar um bot) também reinicia a contagem.
 */
export async function refreshBots({ background = false }: { background?: boolean } = {}): Promise<void> {
  const mine = ++requestId;
  // Mantém a lista atual à vista durante recargas; só a primeira carga mostra o carregando.
  if (!background && (state.status === 'idle' || state.status === 'error')) publish({ status: 'loading', bots: state.bots });
  try {
    const data = await apiFetch<{ bots: BotSummary[] }>('/api/bots');
    if (mine === requestId && !(state.status === 'ready' && sameBots(state.bots, data.bots))) publish({ status: 'ready', bots: data.bots });
  } catch {
    if (mine === requestId && !background) publish({ status: 'error', bots: state.bots });
  } finally {
    scheduleNextPoll();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// --- Releitura periódica compartilhada (F10 passo 2; não lido, phase 3 F4) ----------------------------------------------------
// O relógio é o `createLivePoll` (lib/live-poll), o mesmo da lista do Chat geral. Além do painel e do cabeçalho da conversa, a barra de ícones também
// assina (a bolinha de Bots vale em qualquer seção), e continua havendo uma releitura só por ciclo.

/** Intervalo até a próxima releitura: curto se algum bot está em movimento, longo caso contrário. */
const pollDelay = (bots: readonly BotSummary[]): number => (bots.some((bot) => BUSY_RUN_STATES.includes(bot.runState)) ? LIVE_POLL_BUSY_MS : LIVE_POLL_IDLE_MS);

const livePoll = createLivePoll({
  refresh: () => void refreshBots({ background: true }),
  delay: () => pollDelay(state.bots),
  settled: () => state.status === 'ready' || state.status === 'error',
});

/** Programa a próxima releitura de fundo (no máximo uma pendente; nada sem assinantes, com a aba oculta ou antes da primeira carga). */
const scheduleNextPoll = (): void => livePoll.schedule();

/**
 * Passa a manter a releitura periódica da lista até a função devolvida ser chamada. Contado por assinante: o primeiro liga o relógio e a escuta
 * da visibilidade e relê ao montar; o último desliga tudo. Os demais só se somam, sem pedir nada à API.
 */
export const watchBots = (): (() => void) => livePoll.watch();

/**
 * A conversa do bot acabou de ser lida NESTE aparelho (a presença gravou a leitura no servidor): apaga a bolinha na hora, sem esperar o próximo
 * ciclo (F4, "na hora em que a conversa é lida neste aparelho"). Uma releitura em andamento é invalidada, porque pode ter lido o banco antes da
 * leitura. ponytail: uma novidade chegada entre a leitura e esta marcação fica escondida até o próximo ciclo (no máximo 15 s), aceitável para a bolinha.
 */
export function markBotRead(id: string): void {
  // Só com a lista pronta: invalidar a primeira carga (ou a recarga depois de um erro) deixaria o painel preso em "carregando".
  if (state.status !== 'ready' || !state.bots.some((bot) => bot.id === id && bot.unread)) return;
  requestId += 1;
  publish({ ...state, bots: state.bots.map((bot) => (bot.id === id ? { ...bot, unread: false } : bot)) });
}

/** Estado da lista de bots; dispara a primeira carga quando o primeiro componente a usa. */
export function useBots(): BotsState {
  const snapshot = useSyncExternalStore(subscribe, getBotsState, () => INITIAL);
  useEffect(() => {
    if (state.status === 'idle') void refreshBots();
  }, []);
  return snapshot;
}

/**
 * `useBots` mais a releitura periódica do estado ao vivo, enquanto o componente estiver montado. É o hook de quem MOSTRA o `runState` (o painel
 * de bots e o cabeçalho da conversa); quem só precisa da lista (seletor de bot do editor de rotinas) segue com `useBots`.
 */
export function useLiveBots(): BotsState {
  const snapshot = useBots();
  useEffect(() => watchBots(), []);
  return snapshot;
}

const LAST_BOT_KEY = 'aion:last-bot';

/** Guarda o bot aberto por último neste navegador (conveniência: `/bots` volta para ele). Falha de storage é ignorada. */
export function rememberLastBot(id: string): void {
  try {
    window.localStorage.setItem(LAST_BOT_KEY, id);
  } catch {
    // Storage bloqueado (janela privada, dados limpos): a conveniência some, o app segue funcionando.
  }
}

/** Id do último bot aberto, se houver; o chamador confere que ele ainda existe e está ativo. */
export function readLastBot(): string | null {
  try {
    return window.localStorage.getItem(LAST_BOT_KEY);
  } catch {
    return null;
  }
}

/** Bots fora de Arquivados (a lista principal). */
export const activeBots = (bots: readonly BotSummary[]): BotSummary[] => bots.filter((bot) => bot.archivedAt === null);

/** Bots em Arquivados. */
export const archivedBots = (bots: readonly BotSummary[]): BotSummary[] => bots.filter((bot) => bot.archivedAt !== null);

/** A rota atual é a conversa (ou uma subpágina, como o editor) deste bot? É o "item aberto" do painel e da navegação. */
export const botIsOpen = (pathname: string, id: string): boolean => pathname === `/bots/${id}` || pathname.startsWith(`/bots/${id}/`);
