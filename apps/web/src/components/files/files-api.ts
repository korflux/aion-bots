// Transporte da gestão global; valida respostas no schema que já é usado pelo servidor.
import { attachmentPageSchema, attachmentDeleteResultSchema, type AttachmentListQuery } from '@aion/shared';
import { apiFetch } from '@/lib/api-client';
/** Consulta uma página com os filtros explícitos, sem enviar filtros vazios. */
export async function fetchFiles(query: AttachmentListQuery) {
  const search = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return attachmentPageSchema.parse(await apiFetch(`/api/attachments?${search}`));
}
/** Exclui uma referência individual sem corpo HTTP. */
export const deleteFile = (id: string, csrfToken: string) => apiFetch(`/api/attachments/${id}`, { method: 'DELETE', csrfToken });
/** Um lote limitado pelo contrato; o chamador conserva os resultados dos lotes anteriores. */
export async function deleteFiles(ids: string[], csrfToken: string) { return attachmentDeleteResultSchema.parse(await apiFetch('/api/attachments/delete-batch', { method: 'POST', body: { ids }, csrfToken })); }
