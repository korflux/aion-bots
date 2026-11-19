// Chamadas da web à API das aprovações (F9 e F10; T7). Único lugar que conhece esses caminhos; o restante da tela usa estas funções.
// Toda alteração leva o token CSRF da sessão. As respostas de regras devolvem a lista atualizada: o servidor é a fonte da verdade.
import type {
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalRules,
  BotRule,
  BotRules,
  GlobalRule,
  PendingApprovals,
} from '@aion/shared';
import { closeApprovalNotification } from '@/components/push/close-notifications';
import { apiFetch } from '@/lib/api-client';

/** Pendências respondíveis (número do badge da barra). */
export const fetchPendingCount = (): Promise<PendingApprovals> => apiFetch<PendingApprovals>('/api/approvals/pending-count');

/**
 * Resposta do dono ao cartão de aprovação (permitir uma vez, negar, sempre permitir, negar sempre). Ponto ÚNICO das respostas dadas na tela (cartão da conversa e
 * tela Aprovações): decidida a aprovação, a notificação dela neste aparelho deixa de fazer sentido e é fechada (phase 16, A10; melhor esforço, só depois do sucesso).
 */
export const respondApproval = async (approvalId: string, decision: ApprovalDecision, csrfToken: string): Promise<ApprovalOutcome> => {
  const outcome = await apiFetch<ApprovalOutcome>(`/api/approvals/${encodeURIComponent(approvalId)}/respond`, { method: 'POST', body: { decision }, csrfToken });
  void closeApprovalNotification(approvalId);
  return outcome;
};

/** Ações conhecidas (catálogo do bot e já usadas), com a regra global e os bots que têm regra própria (tela Aprovações). */
export const fetchApprovalRules = (): Promise<ApprovalRules> => apiFetch<ApprovalRules>('/api/approval-rules');

/** Altera a regra global de uma ação; devolve a lista atualizada. */
export const setGlobalRule = (action: string, value: GlobalRule, csrfToken: string): Promise<ApprovalRules> =>
  apiFetch<ApprovalRules>(`/api/approval-rules/${encodeURIComponent(action)}`, { method: 'PUT', body: { value }, csrfToken });

/** Regras próprias de um bot (seção "Aprovações do bot" do editor). */
export const fetchBotRules = (botId: string): Promise<BotRules> => apiFetch<BotRules>(`/api/bots/${botId}/approval-rules`);

export const setBotRule = (botId: string, action: string, value: BotRule, csrfToken: string): Promise<BotRules> =>
  apiFetch<BotRules>(`/api/bots/${botId}/approval-rules/${encodeURIComponent(action)}`, { method: 'PUT', body: { value }, csrfToken });

/** Remove a regra do bot: volta a valer a global. */
export const removeBotRule = (botId: string, action: string, csrfToken: string): Promise<BotRules> =>
  apiFetch<BotRules>(`/api/bots/${botId}/approval-rules/${encodeURIComponent(action)}`, { method: 'DELETE', csrfToken });

/** "Permitir tudo", "Perguntar tudo", "Negar tudo" e "Neutro tudo" da tela Aprovações: a regra global de TODAS as ações conhecidas (F12); devolve a lista atualizada. */
export const setAllGlobalRules = (value: GlobalRule, csrfToken: string): Promise<ApprovalRules> =>
  apiFetch<ApprovalRules>('/api/approval-rules', { method: 'PUT', body: { value }, csrfToken });

/** Regra própria do bot em TODAS as ações conhecidas (mesmo as que a lista do bot não mostra); devolve as regras do bot. */
export const setAllBotRules = (botId: string, value: BotRule, csrfToken: string): Promise<BotRules> =>
  apiFetch<BotRules>(`/api/bots/${botId}/approval-rules`, { method: 'PUT', body: { value }, csrfToken });

/** "Neutro tudo" do bot: remove todas as regras próprias, e a global volta a valer em cada ação. */
export const removeAllBotRules = (botId: string, csrfToken: string): Promise<BotRules> =>
  apiFetch<BotRules>(`/api/bots/${botId}/approval-rules`, { method: 'DELETE', csrfToken });
