// Estado ao vivo de um bot (F10, A12): a pose do mascote e o texto de estado da lista e do cabeçalho da conversa. É a FONTE ÚNICA da regra que
// converte status de execução em estado do mascote, usada por:
//  - o serviço de bots (`BotService.list`), que calcula o `runState` do item da lista com `botRunStateOf`;
//  - a tela Atividades (T13), que mostra o mascote de cada linha pelo status da execução dela com `mascotStateOfRunStatus`.
// Sem dependência de React nem de banco: funções puras, para a regra ser provada sozinha (live-state.test.ts) e nunca repetida nas telas.
//
// Os seis ids são os mesmos de `MascotState` (apps/web/src/components/mascot): o valor que sai daqui entra no mascote sem tradução, e o
// compilador da web recusa a divergência (o `BotAvatar` recebe um `BotRunState` na prop de estado).
import { z } from 'zod';
// Só tipos de conversation.ts (apagados na compilação): um import de valor fecharia um ciclo (conversation -> memory -> bots -> live-state -> conversation).
import type { RunStatus } from './conversation';

export const BOT_RUN_STATES = ['idle', 'working', 'waiting', 'done', 'error', 'sleep'] as const;
export const botRunStateSchema = z.enum(BOT_RUN_STATES);
export type BotRunState = z.infer<typeof botRunStateSchema>;

/** Quanto tempo uma execução concluída deixa o bot em `done` ("Concluiu agora"), contado a partir de `finished_at`. Depois disso o bot fica livre. */
export const RUN_DONE_WINDOW_MS = 60_000;

/**
 * Estados "em movimento": o bot trabalha, espera uma aprovação ou acabou de concluir. Quem acompanha a lista (o store da web) consulta com mais
 * frequência enquanto algum bot está num deles, porque o estado muda logo (o `done` expira sozinho depois de `RUN_DONE_WINDOW_MS`).
 */
export const BUSY_RUN_STATES: readonly BotRunState[] = ['working', 'waiting', 'done'];

/** Estado do mascote para cada status de execução, sem considerar o tempo nem o bot (por isso a conclusão é sempre `done` aqui). */
const MASCOT_STATE_OF_RUN_STATUS: Record<RunStatus, BotRunState> = {
  queued: 'idle', // a fila conta como livre: a execução ainda não começou
  running: 'working',
  waiting_approval: 'waiting',
  completed: 'done',
  failed: 'error',
  expired: 'error',
  limit_reached: 'error',
  interrupted: 'idle', // o dono parou a execução: não é falha
  cancelled: 'idle', // saiu da fila sem começar (rotina pausada, bot arquivado): não é falha
};

/**
 * A função única de status de execução para estado do mascote. Pura e sem tempo: a janela de 60 s do `done` e a precedência entre execução,
 * arquivamento e rotinas são do bot (`botRunStateOf`); a tela Atividades usa esta direto, porque mostra o histórico de cada execução.
 * O `Record` exige uma entrada por status: um status novo em `RUN_STATUSES` não compila até ganhar o estado dele.
 */
export const mascotStateOfRunStatus = (status: RunStatus): BotRunState => MASCOT_STATE_OF_RUN_STATUS[status];

/** O que o banco diz sobre um bot, no que importa para o estado. O serviço de bots monta isto numa consulta só. */
export interface BotRunFacts {
  /** O bot está arquivado (`bots.archived_at` preenchido). */
  archived: boolean;
  /** Status da execução que ocupa o bot (`ACTIVE_RUN_STATUSES`), se houver. A fila (`queued`) e as terminais não entram aqui. */
  activeStatus: Extract<RunStatus, 'running' | 'waiting_approval'> | null;
  /** A última execução TERMINAL (a que terminou por último), se houver. A fila e as execuções ativas não entram. */
  lastTerminal: { status: RunStatus; finishedAt: Date | null } | null;
  /** Rotinas do bot: quantas existem e quantas estão pausadas (`routines.status = 'paused'`; ativa e concluída não contam como pausadas). */
  routines: { total: number; paused: number };
}

/**
 * Estado ao vivo de um bot em `now`, na ordem de precedência da spec (F10):
 *  1. execução ativa: `running` é trabalhando, `waiting_approval` é aguardando;
 *  2. bot arquivado: dormindo;
 *  3. última execução terminal: concluída vale `done` por `RUN_DONE_WINDOW_MS` e depois deixa de valer; falhou, expirou ou atingiu o limite
 *     vale `error` até a próxima execução COMEÇAR (então a regra 1 assume e, ao terminar, essa passa a ser a última); interrompida e
 *     cancelada não valem;
 *  4. o bot tem rotinas e TODAS estão pausadas: dormindo;
 *  5. livre.
 * "Deixa de valer" significa passar para a regra seguinte (uma conclusão antiga de um bot sem rotinas ativas cai em 4 ou 5), e a fila nunca
 * muda o estado. Os 60 s acabam no instante exato (`now - finishedAt >= 60 s` já é livre); um `finishedAt` no futuro (relógios um pouco
 * diferentes) conta como recém-concluído.
 */
export function botRunStateOf(facts: BotRunFacts, now: Date): BotRunState {
  const { activeStatus, lastTerminal, routines } = facts;
  if (activeStatus !== null) return mascotStateOfRunStatus(activeStatus);
  if (facts.archived) return 'sleep';
  if (lastTerminal !== null) {
    const fromLast = mascotStateOfRunStatus(lastTerminal.status);
    if (fromLast === 'error') return 'error';
    const recent = lastTerminal.finishedAt !== null && now.getTime() - lastTerminal.finishedAt.getTime() < RUN_DONE_WINDOW_MS;
    if (fromLast === 'done' && recent) return 'done';
  }
  if (routines.total > 0 && routines.paused === routines.total) return 'sleep';
  return 'idle';
}
