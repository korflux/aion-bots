// Rotas binárias de anexos, protegidas pelos hooks centrais de sessão e CSRF.
import { DomainError, type AttachmentContent, type AttachmentService, type ConversationRef } from '@aion/core';
import { ATTACHMENT_PRIVATE_CACHE, XLSX_MEDIA_TYPE, type GeneratedFormat, ATTACHMENT_UPLOAD_MAX, attachmentParamsSchema, attachmentUploadHeadersSchema, attachmentViewSchema, botIdParamsSchema, attachmentListQuerySchema, attachmentPageSchema, attachmentGlobalParamsSchema, attachmentDeleteBatchSchema, attachmentDeleteResultSchema } from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply } from 'fastify';
import { originOf } from './origin';

/** Tipo de mídia de cada formato de arquivo gerado pelo Python (phase 4, T7); o texto declara UTF-8, que o worker conferiu antes de gravar. */
const GENERATED_MEDIA_TYPES: Record<GeneratedFormat, string> = {
  png: 'image/png',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xlsx: XLSX_MEDIA_TYPE,
};

/** Como cada tipo de anexo é entregue: tipo de mídia, extensão do nome ASCII de reserva, se abre inline e se o navegador pode guardar por uma hora. */
function deliveryOf(content: AttachmentContent): { type: string; extension: string; inline: boolean; cacheable: boolean } {
  switch (content.kind) {
    case 'image':
      return { type: 'image/jpeg', extension: '.jpg', inline: true, cacheable: true };
    case 'spreadsheet':
      return { type: XLSX_MEDIA_TYPE, extension: '.xlsx', inline: false, cacheable: true };
    case 'document':
      return { type: 'text/plain; charset=utf-8', extension: '.txt', inline: false, cacheable: false };
    case 'generated': {
      // O CHECK da migration 0027 garante o formato em todo arquivo gerado; o `txt` é só a reserva do tipo.
      const format = content.format ?? 'txt';
      return { type: GENERATED_MEDIA_TYPES[format], extension: `.${format}`, inline: format === 'png', cacheable: true };
    }
  }
}

/**
 * Mesma entrega de conteúdo nas rotas de conversa e na tela global do dono. JPEG abre inline; o texto extraído de documento baixa como `.txt`
 * (sem cache); a planilha (phase 4, ATT-01) baixa o original `.xlsx` sempre como anexo; o arquivo gerado pelo Python (phase 4, T7) baixa como
 * anexo com o tipo do formato conferido, e só o PNG abre inline como imagem. O nome já foi sanitizado na gravação e vai percent-encoded em
 * `filename*`, com um nome ASCII fixo de reserva. `nosniff` vem do hook de segurança em toda resposta; o cache privado de uma hora é decidido
 * aqui pelo tipo do anexo (`ATTACHMENT_PRIVATE_CACHE`), e o hook só o mantém numa resposta 200 autenticada de rota de conteúdo.
 */
function sendContent(reply: FastifyReply, content: AttachmentContent): FastifyReply {
  const delivery = deliveryOf(content);
  const downloadName = content.kind === 'document' ? content.name.replace(/\.[^.]*$/, '') + '.txt' : content.name;
  return reply.header('Content-Type', delivery.type)
    .header('Content-Disposition', `${delivery.inline ? 'inline' : 'attachment'}; filename="arquivo${delivery.extension}"; filename*=UTF-8''${encodeURIComponent(downloadName).replace(/['()]/g, (value) => `%${value.charCodeAt(0).toString(16)}`)}`)
    .header('Cache-Control', delivery.cacheable ? ATTACHMENT_PRIVATE_CACHE : 'no-store').send(content.bytes);
}

/** Sessão e CSRF centrais protegem operações globais do único dono; uploads continuam por ConversationRef. */
export const attachmentRoutes: FastifyPluginAsyncZod<{ attachments: AttachmentService }> = async (app, { attachments }) => {
  app.get('/attachments', { schema: { querystring: attachmentListQuerySchema, response: { 200: attachmentPageSchema } } }, (request) => attachments.list(request.query));
  app.get('/attachments/:attachmentId/content', { schema: { params: attachmentGlobalParamsSchema }, config: { attachmentContent: true } }, async (request, reply) => sendContent(reply, await attachments.globalContent(request.params.attachmentId)));
  app.delete('/attachments/:attachmentId', { schema: { params: attachmentGlobalParamsSchema } }, async (request, reply) => {
    if (request.body !== undefined) throw new DomainError('VALIDATION_FAILED');
    await attachments.remove(request.params.attachmentId, originOf(request));
    return reply.status(204).send();
  });
  app.post('/attachments/delete-batch', { schema: { body: attachmentDeleteBatchSchema, response: { 200: attachmentDeleteResultSchema } } }, (request) => attachments.removeBatch(request.body.ids, originOf(request)));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: ATTACHMENT_UPLOAD_MAX }, (_request, body, done) => done(null, body));
  const owners: { prefix: string; ref: (id: string) => ConversationRef }[] = [
    { prefix: '/bots/:id', ref: (id) => id },
    { prefix: '/chat/sessions/:id', ref: (id) => ({ sessionId: id }) },
  ];
  for (const { prefix, ref } of owners) {
    app.post(`${prefix}/attachments`, {
      config: { attachmentUpload: true },
      bodyLimit: ATTACHMENT_UPLOAD_MAX,
      schema: { params: botIdParamsSchema, headers: attachmentUploadHeadersSchema, response: { 201: attachmentViewSchema } },
    }, async (request, reply) => {
      if (!Buffer.isBuffer(request.body) || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream') throw new DomainError('ATTACHMENT_TYPE_UNSUPPORTED');
      return reply.status(201).send(await attachments.upload(ref(request.params.id), request.headers['x-attachment-name'], request.body));
    });
    app.delete(`${prefix}/attachments/:attachmentId`, { schema: { params: attachmentParamsSchema } }, async (request, reply) => {
      await attachments.discard(ref(request.params.id), request.params.attachmentId);
      return reply.status(204).send();
    });
    app.get(`${prefix}/attachments/:attachmentId/content`, { schema: { params: attachmentParamsSchema }, config: { attachmentContent: true } }, async (request, reply) => {
      const content = await attachments.content(ref(request.params.id), request.params.attachmentId);
      return sendContent(reply, content);
    });
  }
};
