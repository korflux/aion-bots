// Contrato do armazenamento de anexos; nenhuma resposta de metadados transporta conteúdo.
import { z } from 'zod';
import { ATTACHMENT_KINDS, GENERATED_FORMATS, bigintIdSchema } from './conversation';
import { activityBotSchema } from './activities';

export { ATTACHMENT_LIMIT } from './conversation';
export const ATTACHMENT_UPLOAD_MAX = 15 * 1024 * 1024;
/** Orçamento do leitor no servidor; o composer limita seu lote para não saturar os extratores. */
export const ATTACHMENT_PREPARATION_CONCURRENCY = 2;
export const ATTACHMENT_TEXT_MAX = 500_000;
export const ATTACHMENT_NAME_MAX = 200;
/** Tipo de mídia do `.xlsx` original devolvido no download da planilha (phase 4, ATT-01). */
export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/**
 * Cache dos conteúdos privados que o navegador pode guardar por uma hora: o JPEG, o original da planilha e os arquivos gerados pelo Python
 * (phase 4, T7). Quem decide é a rota de conteúdo, pelo tipo do anexo (o texto extraído de documento e qualquer erro continuam `no-store`); o hook
 * de segurança da API só mantém este valor numa resposta 200 autenticada de rota de conteúdo. Decidir pelo tipo de mídia não serviria: o TXT gerado
 * e o texto extraído de documento têm o mesmo.
 */
export const ATTACHMENT_PRIVATE_CACHE = 'private, max-age=3600';
export const attachmentParamsSchema = z.strictObject({ id: z.uuid(), attachmentId: bigintIdSchema });
// Nome via header ASCII percent-encoded, nunca em query/URL registrada nos logs. UTF-8 é validado na borda.
export const attachmentUploadHeadersSchema = z.object({
  'x-attachment-name': z.string().min(1).max(3072).transform((wire, context) => {
    try {
      if (/[^\x20-\x7e]/.test(wire)) throw new Error('header');
      const name = decodeURIComponent(wire);
      if (!name.length || name.length > 255) throw new Error('length');
      return name;
    } catch { context.addIssue({ code: 'custom', message: 'Nome inválido.' }); return z.NEVER; }
  }),
});
/** Metadados públicos do arquivo, sem bytes nem texto extraído. */
export const attachmentViewSchema = z.object({
  id: bigintIdSchema,
  kind: z.enum(ATTACHMENT_KINDS),
  name: z.string().refine((name) => [...name].length <= ATTACHMENT_NAME_MAX),
  originalBytes: z.number().int().nonnegative(),
  storedBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  createdAt: z.iso.datetime(),
  removedAt: z.iso.datetime().nullable(),
  /** Só no arquivo gerado pelo Python (`kind: generated`, origem "Gerado pelo Python"). */
  format: z.enum(GENERATED_FORMATS).optional(),
});
export type AttachmentView = z.infer<typeof attachmentViewSchema>;

/** Contratos globais do dono: origem ausente inclui bots arquivados e todas as sessões. O filtro `document` inclui planilhas (sem filtro novo, design). */
export const attachmentListQuerySchema = z.strictObject({ cursor: bigintIdSchema.optional(), origin: z.enum(['bot', 'chat']).optional(), botId: z.uuid().optional(), kind: z.enum(['image', 'document']).optional() });
export const attachmentGlobalParamsSchema = z.strictObject({ attachmentId: bigintIdSchema });
export const attachmentDeleteBatchSchema = z.strictObject({ ids: z.array(bigintIdSchema).min(1).max(100) });
export const attachmentFileSchema = attachmentViewSchema.extend({ bot: activityBotSchema.nullable(), sessionId: z.uuid().nullable(), sessionTitle: z.string().nullable(), inUse: z.boolean() });
export const attachmentPageSchema = z.object({ items: z.array(attachmentFileSchema), nextCursor: bigintIdSchema.nullable(), usedBytes: z.number().int().nonnegative(), count: z.number().int().nonnegative(), maxBytes: z.number().int().nonnegative() });
export const attachmentDeleteResultSchema = z.object({ deleted: z.array(bigintIdSchema), inUse: z.array(bigintIdSchema), alreadyRemoved: z.array(bigintIdSchema), freedBytes: z.number().int().nonnegative() });
export type AttachmentListQuery = z.infer<typeof attachmentListQuerySchema>;
export type AttachmentPage = z.infer<typeof attachmentPageSchema>;
export type AttachmentDeleteResult = z.infer<typeof attachmentDeleteResultSchema>;
