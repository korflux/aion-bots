// Chamadas da web à API da conversa (F6, F7; F16). Único lugar que conhece esses caminhos; o restante da tela usa estas funções.
// O navegador só fala com a API do Aion: modelo, provedor e chaves nunca passam por aqui. Toda alteração leva o token CSRF.
//
// A conversa de um bot e a de uma sessão do chat geral têm as MESMAS rotas, sob prefixos diferentes (`/api/bots/:id` e
// `/api/chat/sessions/:id`); `ConversationSource` diz de quem é a conversa e `conversationBase` monta o prefixo.
import {
  PRESENCE_RENEW_MS,
  type ChooseVersionRequest,
  type ConversationPage,
  type ConversationSnapshot,
  type ContextState,
  type ContextMaintenanceRequest,
  type DraftView,
  type EffortLevel,
  type ModelChoiceView,
  type PresenceUpdate,
  type RunView,
  type SendResult,
} from '@aion/shared';
import { apiFetch } from '@/lib/api-client';

/** De quem é a conversa: de um bot (a conversa única dele) ou de uma sessão do chat geral. */
export type ConversationSource = { kind: 'bot' | 'session'; id: string };

/** Código de erro da API quando o dono da conversa não existe (bot removido, ou sessão apagada pela retenção de 7 dias). */
export const NOT_FOUND_CODE = { bot: 'BOT_NOT_FOUND', session: 'SESSION_NOT_FOUND' } as const;

export const conversationBase = ({ kind, id }: ConversationSource): string => (kind === 'bot' ? `/api/bots/${id}` : `/api/chat/sessions/${id}`);

/** Lê somente metadados autorizados de contexto, sem iniciar execução ou medição pelo modelo. */
export const fetchContextState = (source: ConversationSource): Promise<ContextState> => apiFetch(`${conversationBase(source)}/conversation/context`);

/** Solicita manutenção idempotente na revisão apresentada; o servidor decide elegibilidade e posse. */
export const maintainContext = (source: ConversationSource, request: ContextMaintenanceRequest, csrfToken: string): Promise<ContextState> =>
  apiFetch(`${conversationBase(source)}/conversation/context/maintenance`, { method: 'POST', body: request, csrfToken });

/** Cancela a operação identificada sem interferir na execução de mensagens da conversa. */
export const cancelContextMaintenance = (source: ConversationSource, requestId: string, csrfToken: string): Promise<ContextState> =>
  apiFetch(`${conversationBase(source)}/conversation/context/maintenance/${requestId}/cancel`, { method: 'POST', body: {}, csrfToken });

/** Estado inicial: última página, execuções abertas, modelo em uso e ponto de retomada do SSE. */
export const fetchConversation = (source: ConversationSource): Promise<ConversationSnapshot> =>
  apiFetch<ConversationSnapshot>(`${conversationBase(source)}/conversation`);

/** As rodadas anteriores a `before` (10 por vez, o padrão da API; rolagem para cima e busca do trecho de um link "ver na conversa"). */
export const fetchOlderMessages = (source: ConversationSource, before: string): Promise<ConversationPage> =>
  apiFetch<ConversationPage>(`${conversationBase(source)}/conversation/messages?before=${encodeURIComponent(before)}`);

/** Envia uma mensagem: entra na fila da conversa (`kind: 'run'`) ou, com execução ativa, vira complemento pendente dela (`kind: 'complement'`). */
export const sendMessage = (source: ConversationSource, content: string, csrfToken: string, attachmentIds: string[] = []): Promise<SendResult> =>
  apiFetch<SendResult>(`${conversationBase(source)}/messages`, { method: 'POST', body: { content, attachmentIds }, csrfToken });

/** "Cancelar" de um complemento pendente (phase 4, F5): ele volta como rascunho devolvido, que a resposta traz. */
export const cancelComplement = (source: ConversationSource, complementId: string, csrfToken: string): Promise<DraftView> =>
  apiFetch<DraftView>(`${conversationBase(source)}/complements/cancel`, { method: 'POST', body: { complementId }, csrfToken });

/** Pede o rascunho devolvido para este composer; só um aparelho o recebe (os outros recebem DRAFT_NOT_FOUND). */
export const consumeDraft = (source: ConversationSource, draftId: string, csrfToken: string): Promise<DraftView> =>
  apiFetch<DraftView>(`${conversationBase(source)}/draft/${draftId}/consume`, { method: 'POST', csrfToken });

/**
 * Pede a parada da execução ativa (assíncrona: o cartão chega pelo SSE). Telas que listam execuções (Atividades) informam `runId`:
 * a API só para essa execução, e recusa (RUN_NOT_ACTIVE) se a lista estava desatualizada e a ativa já é outra.
 */
export const stopRun = (source: ConversationSource, csrfToken: string, runId?: string): Promise<RunView> =>
  apiFetch<RunView>(`${conversationBase(source)}/runs/stop${runId === undefined ? '' : `?runId=${encodeURIComponent(runId)}`}`, { method: 'POST', csrfToken });

/** Retry preserva seu contrato; a continuação explícita envia a revisão do cartão por uma ação separada. */
export const retryRun = (source: ConversationSource, runId: string, csrfToken: string, limitMessageId?: string): Promise<RunView> =>
  apiFetch<RunView>(`${conversationBase(source)}/runs/${runId}/${limitMessageId === undefined ? 'retry' : 'continue'}`, { method: 'POST', ...(limitMessageId === undefined ? {} : { body: { limitMessageId } }), csrfToken });

// Versões da sessão do Chat geral (phase 4, F1 a F4, CONV-01). Só existem sob `/api/chat/sessions/:id` (o bot é linear e responde 404); quem
// chama só as usa com uma origem `session`. Editar e gerar devolvem a execução criada; retroceder, restaurar e escolher devolvem o snapshot com o
// caminho novo, que a tela aplica no lugar do estado inteiro.

/** Editar (F1): versão nova da mensagem `messageId`, com o texto e os anexos da versão nova (pendentes do campo ou já ligados a versões). */
export const editMessage = (sessionId: string, messageId: string, content: string, attachmentIds: string[], csrfToken: string): Promise<RunView> =>
  apiFetch<RunView>(`/api/chat/sessions/${sessionId}/versions/edit`, { method: 'POST', body: { messageId, content, attachmentIds }, csrfToken });

/** Gerar outra resposta (F2) para uma resposta terminada do caminho ativo. */
export const regenerateRun = (sessionId: string, runId: string, csrfToken: string): Promise<RunView> =>
  apiFetch<RunView>(`/api/chat/sessions/${sessionId}/versions/regenerate`, { method: 'POST', body: { runId }, csrfToken });

/** Retroceder até a resposta `runId` (F3): as rodadas seguintes saem do caminho visível, recuperáveis por "Restaurar" e pelas versões. */
export const rewindTo = (sessionId: string, runId: string, csrfToken: string): Promise<ConversationSnapshot> =>
  apiFetch<ConversationSnapshot>(`/api/chat/sessions/${sessionId}/versions/rewind`, { method: 'POST', body: { runId }, csrfToken });

/** "Restaurar" (F3): devolve o caminho de antes do retrocesso em vigor. Sem corpo. */
export const restorePath = (sessionId: string, csrfToken: string): Promise<ConversationSnapshot> =>
  apiFetch<ConversationSnapshot>(`/api/chat/sessions/${sessionId}/versions/restore`, { method: 'POST', csrfToken });

/** Trocar de versão (F4): a versão de mensagem OU de resposta a exibir; abaixo dela vale a última escolha naquele ramo. */
export const chooseVersion = (sessionId: string, target: ChooseVersionRequest, csrfToken: string): Promise<ConversationSnapshot> =>
  apiFetch<ConversationSnapshot>(`/api/chat/sessions/${sessionId}/versions/choose`, { method: 'POST', body: target, csrfToken });

/** Grava a troca de modelo e effort do composer como preferência da conversa (não altera o padrão do bot). */
export const saveModelPreference = (source: ConversationSource, model: string, effort: EffortLevel | null, csrfToken: string): Promise<ModelChoiceView> =>
  apiFetch<ModelChoiceView>(`${conversationBase(source)}/conversation`, { method: 'PATCH', body: { model, effort }, csrfToken });

/** Endereço do SSE, retomando a partir do último evento já refletido no snapshot. */
export const eventsUrl = (source: ConversationSource, after: string): string =>
  `${conversationBase(source)}/conversation/events?after=${encodeURIComponent(after)}`;

/**
 * Presença e leitura (phase 3, T2): informa que o dono está olhando esta conversa (ou deixou de olhar) e até qual mensagem a tela mostrou. O
 * término usa `keepalive` para chegar mesmo com a página sendo fechada; sessão vencida não redireciona ao login daqui (o restante da tela
 * cuida disso), e a falha nunca vira aviso ao dono (quem chama trata o resultado).
 */
export const reportPresence = (source: ConversationSource, present: boolean, readThrough: string | null, csrfToken: string): Promise<undefined> =>
  apiFetch('/api/presence', {
    method: 'PUT',
    body: { conversationKind: source.kind === 'bot' ? 'bot' : 'chat', conversationId: source.id, readThrough, present } satisfies PresenceUpdate,
    csrfToken,
    keepalive: !present,
    redirectOnExpired: false,
    timeoutMs: PRESENCE_RENEW_MS,
  });
