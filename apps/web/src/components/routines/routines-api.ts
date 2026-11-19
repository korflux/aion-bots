// Chamadas da web à API de rotinas (F12). Único lugar que conhece os caminhos /api/routines; as telas só chamam estas funções. Toda
// alteração leva o token CSRF da sessão e, ao concluir, recarrega a lista do painel (fonte: routines-store).
import type { RoutineChangeResult, RoutineHistory, RoutineInput, RoutinePreview, RoutineReplace, RoutineScheduleSettings, RoutineView, RunView } from '@aion/shared';
import { apiFetch } from '@/lib/api-client';
import { refreshRoutines } from './routines-store';

/** Depois de qualquer alteração o painel precisa refletir o novo estado; a recarga não bloqueia a tela. */
function thenRefreshList<T>(value: T): T {
  void refreshRoutines();
  return value;
}

/** Uma rotina pelo id (ROUTINE_NOT_FOUND se não existe). */
export const fetchRoutine = (id: string): Promise<RoutineView> => apiFetch<RoutineView>(`/api/routines/${id}`);

/** Prévia das próximas execuções de uma agenda ainda não salva; agenda inválida volta com o motivo, não como erro. */
export const previewSchedule = (settings: RoutineScheduleSettings, csrfToken: string): Promise<RoutinePreview> =>
  apiFetch<RoutinePreview>('/api/routines/preview', { method: 'POST', body: settings, csrfToken });

/** Cria a rotina (e confirma a proposta do bot, quando `proposalMessageId` vem junto). */
export const createRoutine = (input: RoutineInput, csrfToken: string): Promise<RoutineView> =>
  apiFetch<RoutineView>('/api/routines', { method: 'POST', body: input, csrfToken }).then(thenRefreshList);

/**
 * Substitui a rotina pelo estado final enviado (a edição vale a partir do próximo horário previsto). Com `cardId` (editor aberto pelo cartão da rotina
 * que o bot criou ou alterou, `/rotinas/<id>?cartao=<cardId>`) o servidor também liga a edição ao cartão: ele passa a "Editada pelo dono" e o bot recebe o
 * aviso. ROUTINE_CHANGED (409) quando a rotina mudou depois do cartão ou o cartão já foi recusado ou editado.
 */
export const replaceRoutine = (id: string, input: RoutineReplace, csrfToken: string, cardId?: string): Promise<RoutineView> =>
  apiFetch<RoutineView>(`/api/routines/${id}`, { method: 'PUT', body: cardId === undefined ? input : { ...input, cardId }, csrfToken }).then(thenRefreshList);

/** Pausa a rotina e tira da fila o que ainda não começou. */
export const pauseRoutine = (id: string, csrfToken: string): Promise<RoutineView> =>
  apiFetch<RoutineView>(`/api/routines/${id}/pause`, { method: 'POST', csrfToken }).then(thenRefreshList);

/** Retoma a rotina pausada, com o próximo horário depois de agora. */
export const resumeRoutine = (id: string, csrfToken: string): Promise<RoutineView> =>
  apiFetch<RoutineView>(`/api/routines/${id}/resume`, { method: 'POST', csrfToken }).then(thenRefreshList);

/** Exclui a rotina e o histórico dela. */
export const deleteRoutine = (id: string, csrfToken: string): Promise<void> =>
  apiFetch(`/api/routines/${id}`, { method: 'DELETE', csrfToken }).then(thenRefreshList);

/** "Executar agora": enfileira já uma execução da rotina no bot dela. */
export const runRoutineNow = (id: string, csrfToken: string): Promise<RunView> =>
  apiFetch<RunView>(`/api/routines/${id}/run`, { method: 'POST', csrfToken }).then(thenRefreshList);

/**
 * Confirma a proposta de alteração que um bot deixou num cartão (o id é o da mensagem do cartão). O servidor aplica o que gravou no cartão;
 * a resposta traz a rotina como ficou (nula quando a alteração era excluí-la).
 */
export const confirmRoutineChange = (messageId: string, csrfToken: string): Promise<RoutineChangeResult> =>
  apiFetch<RoutineChangeResult>(`/api/routines/changes/${messageId}/confirm`, { method: 'POST', csrfToken }).then(thenRefreshList);

/**
 * Recusa o que o bot aplicou (rotina criada ou alteração), pelo cartão (o id é o da mensagem do cartão): o servidor desfaz a partir do que gravou nele e avisa
 * o bot. A resposta traz a rotina como ficou (nula quando a rotina criada foi excluída). Idempotente; ROUTINE_CHANGED (409) quando a rotina mudou depois do cartão.
 */
export const refuseRoutineCard = (messageId: string, csrfToken: string): Promise<RoutineChangeResult> =>
  apiFetch<RoutineChangeResult>(`/api/routines/cards/${messageId}/refuse`, { method: 'POST', csrfToken }).then(thenRefreshList);

/** Uma página do histórico da rotina, por cursor. */
export const fetchRoutineHistory = (id: string, cursor: string | null): Promise<RoutineHistory> =>
  apiFetch<RoutineHistory>(`/api/routines/${id}/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
