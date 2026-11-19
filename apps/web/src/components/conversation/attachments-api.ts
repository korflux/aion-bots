// Transporte binário com os mesmos controles da API JSON, prazo próprio e cancelamento da composição.
import { CSRF_HEADER, attachmentViewSchema, isErrorEnvelope, type AttachmentView } from '@aion/shared';
import { ApiError, apiFetch, redirectToLogin } from '@/lib/api-client';
import { conversationBase, type ConversationSource } from './conversation-api';

/** Endereço autenticado do conteúdo; não revela conteúdo em metadados. */
export const attachmentContentUrl = (source: ConversationSource, id: string): string => `${conversationBase(source)}/attachments/${id}/content`;
/** Conteúdo autenticado na tela global, com a mesma autorização do servidor. */
export const globalAttachmentContentUrl = (id: string): string => `/api/attachments/${id}/content`;
/** Remove apenas um upload ainda pendente da própria conversa. */
export const removePendingAttachment = (source: ConversationSource, id: string, csrfToken: string): Promise<void> => apiFetch(`${conversationBase(source)}/attachments/${id}`, { method: 'DELETE', csrfToken });

/** Envia um único arquivo sem serializar bytes em JSON. */
export async function uploadAttachment(source: ConversationSource, file: Blob, name: string, csrfToken: string, signal: AbortSignal): Promise<AttachmentView> {
  if (name.length > 255 || encodeURIComponent(name).length > 3072) throw new ApiError(400, 'UNKNOWN', 'O nome do arquivo é muito longo.');
  let response: Response;
  try {
    response = await fetch(`${conversationBase(source)}/attachments`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/octet-stream', 'x-attachment-name': encodeURIComponent(name), [CSRF_HEADER]: csrfToken }, body: file, signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) });
  } catch { throw new ApiError(0, 'NETWORK_ERROR', 'Sem conexão com o servidor. Tente novamente.'); }
  if (response.ok) {
    try { return attachmentViewSchema.parse(await response.json()); }
    catch { throw new ApiError(response.status, 'UNKNOWN', 'Não foi possível anexar o arquivo.'); }
  }
  const payload: unknown = await response.json().catch(() => null);
  if (isErrorEnvelope(payload)) {
    if (payload.code === 'AUTH_SESSION_EXPIRED') redirectToLogin();
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ApiError(response.status, payload.code as ApiError['code'], payload.message, { retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined });
  }
  throw new ApiError(response.status, 'UNKNOWN', 'Não foi possível anexar o arquivo.');
}
