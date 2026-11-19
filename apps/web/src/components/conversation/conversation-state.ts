// Estado da conversa no cliente (funções puras, sem React): como o snapshot e cada evento do SSE viram a lista que a tela mostra.
//
// Regra central: cada evento do SSE traz o ESTADO ATUAL da linha (mensagem ou execução), nunca um pedaço. Por isso aplicar o mesmo
// evento duas vezes, ou fora de ordem depois de uma reconexão, dá o mesmo resultado: `applyMessage` e `applyRun` são upserts por
// id. Uma mensagem `discarded` (texto abandonado por um reinício do worker) sai da lista. Os complementos pendentes (phase 4, F5) viajam dentro
// da execução ativa e o rascunho devolvido tem evento próprio (`draft`), também como estado atual.
//
// Versões do Chat geral (phase 4, CONV-01): a sessão traz as rodadas do caminho ativo (`rounds`, com as versões de cada mensagem e resposta) e o
// retrocesso em vigor (`rewound`). Elas não têm evento próprio: o SSE `path` só avisa que o caminho mudou e a tela relê o snapshot inteiro
// (`use-conversation`). O bot é linear e fica com `rounds` nulo.
import {
  OPEN_RUN_STATUSES,
  type ComplementView,
  type ConversationPage,
  type ConversationSnapshot,
  type ContextState,
  type DraftEvent,
  type DraftView,
  type MessageView,
  type ModelChoiceView,
  type ObjectiveView,
  type PathRound,
  type Rewound,
  type RunView,
} from '@aion/shared';

export interface ConversationState {
  /** Linha do tempo em ordem crescente de id, sem mensagens descartadas. */
  items: MessageView[];
  /** Execuções na fila ou ocupando o bot, da mais antiga à mais nova. */
  runs: RunView[];
  /** Há mensagens mais antigas que as carregadas. */
  hasMore: boolean;
  model: ModelChoiceView;
  objective?: ObjectiveView | null;
  /** Metadados de ocupação e consumo vindos do servidor; ausência não representa consumo zero. */
  context?: ContextState | null;
  providerConfigured: boolean;
  /** Rascunho devolvido ainda não entregue a nenhum composer (phase 4, F5), ou nulo. */
  draft: DraftView | null;
  /** Só na sessão do Chat geral: as rodadas do caminho ativo presentes em `items`, na ordem; nulo no bot (linear, sem versões). */
  rounds: PathRound[] | null;
  /** Só na sessão: o retrocesso em vigor (linha "N rodadas retrocedidas · Restaurar"), ou nulo. */
  rewound: Rewound | null;
}

/** Ids são inteiros grandes em texto: mais dígitos é maior, e com o mesmo tamanho vale a ordem do texto. */
export const compareIds = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

export function fromSnapshot(snapshot: ConversationSnapshot): ConversationState {
  return {
    items: snapshot.items.filter((item) => item.status !== 'discarded'),
    runs: snapshot.runs,
    hasMore: snapshot.hasMore,
    model: snapshot.model,
    objective: snapshot.objective ?? null,
    context: snapshot.context ?? null,
    providerConfigured: snapshot.providerConfigured,
    draft: snapshot.draft ?? null,
    rounds: snapshot.rounds ?? null,
    rewound: snapshot.rewound ?? null,
  };
}

/** Insere ou atualiza uma mensagem mantendo a ordem por id; `discarded` remove. Devolve o mesmo estado se nada mudou. */
export function applyMessage(state: ConversationState, message: MessageView): ConversationState {
  const index = state.items.findIndex((item) => item.id === message.id);
  if (message.status === 'discarded') {
    return index === -1 ? state : { ...state, items: state.items.filter((item) => item.id !== message.id) };
  }
  if (index !== -1) {
    const items = state.items.slice();
    items[index] = message;
    return { ...state, items };
  }
  // Quase sempre entra no fim; procura de trás para frente a posição correta.
  let position = state.items.length;
  while (position > 0 && compareIds((state.items[position - 1] as MessageView).id, message.id) > 0) position -= 1;
  const items = state.items.slice();
  items.splice(position, 0, message);
  return { ...state, items, rounds: withNewRound(state.rounds, message) };
}

/**
 * Rodada nova que chega pelo SSE numa sessão do Chat geral: a mensagem do dono que abre rodada (não o complemento) entra no fim do caminho com
 * uma versão só de cada lado, que é o que um envio comum cria. As formas que mudam o caminho de outro jeito (edição, outra resposta, envio depois
 * de retroceder) também emitem `path`, e o snapshot relido traz as versões certas. No bot (`rounds` nulo) nada muda.
 */
function withNewRound(rounds: PathRound[] | null, message: MessageView): PathRound[] | null {
  if (rounds === null || message.kind !== 'text' || message.role !== 'user' || message.complement || message.runId === null) return rounds;
  if (rounds.some((round) => round.messageId === message.id)) return rounds;
  return [...rounds, { messageId: message.id, runId: message.runId, messageVersions: [message.id], runVersions: [message.runId] }];
}

const isOpen = (run: RunView): boolean => OPEN_RUN_STATUSES.includes(run.status);

/** Atualiza a lista de execuções abertas: uma execução que terminou sai dela; uma aberta entra ou é atualizada. */
export function applyRun(state: ConversationState, run: RunView): ConversationState {
  const others = state.runs.filter((existing) => existing.id !== run.id);
  if (!isOpen(run)) return others.length === state.runs.length ? state : { ...state, runs: others };
  return { ...state, runs: [...others, run].sort((a, b) => compareIds(a.id, b.id)) };
}

/**
 * Complemento que ESTE aparelho acabou de enviar (resposta do envio): entra já na execução ativa, sem esperar o evento da execução, que traz a
 * lista inteira depois (e então prevalece). Sem execução ativa conhecida, nada muda: o evento a trará.
 */
export function applyComplement(state: ConversationState, complement: ComplementView): ConversationState {
  const active = activeRunOf(state);
  if (!active || (active.complements ?? []).some((known) => known.id === complement.id)) return state;
  return { ...state, runs: state.runs.map((run) => (run.id === active.id ? { ...run, complements: [...(run.complements ?? []), complement] } : run)) };
}

/** Tira um complemento da execução ativa (cancelado aqui; o evento da execução confirma). */
export function dropComplement(state: ConversationState, complementId: string): ConversationState {
  return { ...state, runs: state.runs.map((run) => (run.complements?.some((known) => known.id === complementId) ? { ...run, complements: run.complements.filter((known) => known.id !== complementId) } : run)) };
}

/**
 * Evento `draft` (ou a resposta do "Cancelar"): o rascunho atual substitui o conhecido; `draft: null` só tira o rascunho se ele for o mesmo (um
 * evento atrasado de um rascunho antigo não apaga um mais novo).
 */
export function applyDraft(state: ConversationState, event: DraftEvent): ConversationState {
  if (event.draft) return { ...state, draft: event.draft };
  return state.draft?.id === event.id ? { ...state, draft: null } : state;
}

/** Junta uma página de mensagens mais antigas ao começo da lista (sem repetir as já conhecidas), e as rodadas dela antes das da sessão. */
export function prependPage(state: ConversationState, page: ConversationPage): ConversationState {
  const known = new Set(state.items.map((item) => item.id));
  const older = page.items.filter((item) => item.status !== 'discarded' && !known.has(item.id));
  const rounds = state.rounds === null ? null : [...(page.rounds ?? []).filter((round) => !state.rounds?.some((current) => current.messageId === round.messageId)), ...state.rounds];
  return { ...state, items: [...older, ...state.items], hasMore: page.hasMore, rounds };
}

/** A execução que ocupa o bot agora (rodando ou esperando aprovação), se houver. */
export const activeRunOf = (state: ConversationState): RunView | null => state.runs.find((run) => run.status !== 'queued') ?? null;

/**
 * A sessão não aceita trocar de caminho (CONVERSATION_BUSY, phase 4 Suposição 8): há execução na fila, rodando ou aguardando aprovação, ou
 * complemento pendente (que só existe numa execução ativa, então a lista de execuções abertas já o cobre).
 */
export const isBusy = (state: ConversationState): boolean => state.runs.length > 0;

/** Execuções na fila (ainda sem mensagem na linha do tempo), da mais antiga à mais nova. */
export const queuedRunsOf = (state: ConversationState): RunView[] => state.runs.filter((run) => run.status === 'queued');
