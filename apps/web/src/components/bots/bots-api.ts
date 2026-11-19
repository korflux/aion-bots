// Chamadas da web à API de bots (F5). Único lugar que conhece os caminhos /api/bots; as telas só chamam estas funções.
// Toda alteração leva o token CSRF da sessão e, ao concluir, recarrega a lista do painel (fonte: bots-store).
import type { Bot, EffortLevel, ContextWindowTokens } from '@aion/shared';
import { apiFetch } from '@/lib/api-client';
import { notifyApprovalsChanged } from '@/components/approvals/pending-approvals';
import { refreshRoutines } from '@/components/routines/routines-store';
import { refreshBots } from './bots-store';

/** Campos que o editor envia. Modelo e effort vêm do seletor de modelo (T5); nulos = sem modelo padrão. */
export interface BotDraft {
  name: string;
  color: string;
  instructions: string;
  model: string | null;
  effort: EffortLevel | null;
  stepLimit: number;
  contextWindowTokens: ContextWindowTokens | null;
}

/**
 * Depois de qualquer alteração o painel precisa refletir o novo estado; a recarga não bloqueia a tela. Arquivar pausa as rotinas do
 * bot, então a lista de rotinas também é recarregada.
 */
function thenRefreshList(bot: Bot): Bot {
  void refreshBots();
  void refreshRoutines();
  return bot;
}

export const createBot = (draft: BotDraft, csrfToken: string): Promise<Bot> =>
  apiFetch<Bot>('/api/bots', { method: 'POST', body: draft, csrfToken }).then(thenRefreshList);

export const updateBot = (id: string, draft: BotDraft, csrfToken: string): Promise<Bot> =>
  apiFetch<Bot>(`/api/bots/${id}`, { method: 'PATCH', body: draft, csrfToken }).then(thenRefreshList);

export const archiveBot = (id: string, csrfToken: string): Promise<Bot> =>
  apiFetch<Bot>(`/api/bots/${id}/archive`, { method: 'POST', csrfToken }).then(thenRefreshList);

export const unarchiveBot = (id: string, csrfToken: string): Promise<Bot> =>
  apiFetch<Bot>(`/api/bots/${id}/unarchive`, { method: 'POST', csrfToken }).then(thenRefreshList);

/**
 * Exclusão definitiva de um bot ARQUIVADO (F6, DATA-01; irreversível). `confirmName` é o nome digitado pelo dono: o servidor o compara ao
 * nome gravado e recusa se não conferir. A resposta é 204 sem corpo e o servidor apaga conversa, execuções, aprovações, memória, rotinas e
 * regras do bot numa transação. Em seguida recarrega TUDO o que a interface guarda em estado e mostra dados do bot: a lista do painel, a
 * lista de rotinas e o contador de aprovações pendentes. Como nas outras ações, a recarga não bloqueia a tela.
 *
 * ponytail: DELETE com corpo JSON depende de o proxy do Easypanel repassar o corpo (ver a rota em apps/api/src/routes/bots.ts), trocar
 * o verbo para POST se ele o descartar (prova na T15).
 */
export const deleteBot = (id: string, confirmName: string, csrfToken: string): Promise<void> =>
  apiFetch(`/api/bots/${id}`, { method: 'DELETE', body: { confirmName }, csrfToken }).then(() => {
    void refreshBots();
    void refreshRoutines();
    notifyApprovalsChanged();
  });
