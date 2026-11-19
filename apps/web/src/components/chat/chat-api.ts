// Chamadas da web à API das sessões do chat geral (F16). Único lugar que conhece os caminhos /api/chat/sessions; a conversa DENTRO da
// sessão usa `conversation-api` (mesmas rotas do bot, outro prefixo). Toda alteração leva o token CSRF da sessão; "salvar" atualiza a lista
// do painel na hora (fonte: chat-store), sem esperar uma recarga.
import type { ChatSession, ChatSettingsUpdate, ModelChoiceView } from '@aion/shared';
import { apiFetch } from '@/lib/api-client';
import { upsertChatSession } from './chat-store';

/**
 * "Novo chat": a API devolve o rascunho vazio que já existe ou cria um. Ele NÃO entra na lista do painel (só ganha lugar ali na primeira
 * mensagem, quando `onSent` recarrega a lista); por isso aqui não há `upsertChatSession`.
 */
export const createChatSession = (csrfToken: string): Promise<ChatSession> => apiFetch<ChatSession>('/api/chat/sessions', { method: 'POST', csrfToken });

/** Liga ou desliga "salvar" (suspende ou volta a contar a exclusão em 7 dias). */
export const setChatSessionSaved = (id: string, saved: boolean, csrfToken: string): Promise<ChatSession> =>
  apiFetch<ChatSession>(`/api/chat/sessions/${id}`, { method: 'PATCH', body: { saved }, csrfToken }).then(upsertChatSession);

/** O modelo e o effort padrão do Chat geral (T23); `model` nulo enquanto o dono não definiu. */
export const fetchChatSettings = (): Promise<ModelChoiceView> => apiFetch<ModelChoiceView>('/api/chat/settings');

/** Define o modelo e o effort padrão do Chat geral; o servidor confere com a lista do provedor e devolve o padrão como ficou. */
export const saveChatSettings = (settings: ChatSettingsUpdate, csrfToken: string): Promise<ModelChoiceView> =>
  apiFetch<ModelChoiceView>('/api/chat/settings', { method: 'PUT', body: settings, csrfToken });
