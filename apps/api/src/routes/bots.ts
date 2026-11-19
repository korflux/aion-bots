// Rotas de bots (F5 e F6), todas sob /api/bots. Casca fina: a regra vive em BotService (core) e o formato dos dados
// (allowlist, tamanhos, campos extras recusados) nos schemas de @aion/shared, aplicados pelo Fastify na borda.
//
// Segurança: nenhuma rota é pública, então o hook de segurança exige sessão válida e, nas que alteram estado,
// Origin e token CSRF. O id da URL é um UUID validado antes de chegar ao serviço, que ainda confere que o bot
// existe (BOT_NOT_FOUND). Corpos nunca carregam id, datas ou campos internos (strictObject recusa o excesso).
import type { ObjectiveService, BotService } from '@aion/core';
import {
  objectiveViewSchema, objectiveUndoSchema, bigintIdSchema,
  botCreateSchema,
  botDeleteSchema,
  botIdParamsSchema,
  botListSchema,
  botSchema,
  botUpdateSchema,
} from '@aion/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';

export interface BotRoutesOptions {
  bots: BotService;
  objectives: ObjectiveService;
}

export const botRoutes: FastifyPluginAsyncZod<BotRoutesOptions> = async (app, { bots, objectives }) => {
  // Objetivo é somente leitura/convite/desfazer para o dono; aprendizado passa pela ferramenta sob lease.
  app.get('/bots/:id/objective', { schema: { params: botIdParamsSchema, response: { 200: objectiveViewSchema } } }, async (request) => (await bots.get(request.params.id)).objective!);
  app.post('/bots/:id/objective/invitation', { bodyLimit: 1024, schema: { params: botIdParamsSchema, body: z.strictObject({}), response: { 200: z.object({ objective: objectiveViewSchema, presentedNow: z.boolean() }) } } }, async (request) => objectives.presentInvitation(request.params.id));
  app.post('/bots/:id/objective/cards/:cardId/undo', { bodyLimit: 1024, schema: { params: z.strictObject({ id: z.uuid(), cardId: bigintIdSchema }), body: objectiveUndoSchema, response: { 200: objectiveViewSchema } } }, async (request) => objectives.undo(request.params.id, request.params.cardId, request.body.expectedVersion, originOf(request)));

  // Lista para o painel: ativos e arquivados juntos, só o resumo (sem instruções).
  app.get('/bots', { schema: { response: { 200: botListSchema } } }, async () => ({ bots: await bots.list() }));

  app.get(
    '/bots/:id',
    { schema: { params: botIdParamsSchema, response: { 200: botSchema } } },
    async (request) => bots.get(request.params.id),
  );

  // Criar: devolve o bot completo; a conversa única e a memória vazia nascem na mesma transação.
  app.post('/bots', { schema: { body: botCreateSchema, response: { 201: botSchema } } }, async (request, reply) => {
    const bot = await bots.create(request.body, originOf(request));
    return reply.status(201).send(bot);
  });

  // Editar: parcial, só os campos enviados mudam.
  app.patch(
    '/bots/:id',
    { schema: { params: botIdParamsSchema, body: botUpdateSchema, response: { 200: botSchema } } },
    async (request) => bots.update(request.params.id, request.body, originOf(request)),
  );

  // Arquivar e desarquivar são ações (não campos editáveis) e idempotentes.
  app.post(
    '/bots/:id/archive',
    { schema: { params: botIdParamsSchema, response: { 200: botSchema } } },
    async (request) => bots.archive(request.params.id, originOf(request)),
  );

  app.post(
    '/bots/:id/unarchive',
    { schema: { params: botIdParamsSchema, response: { 200: botSchema } } },
    async (request) => bots.unarchive(request.params.id, originOf(request)),
  );

  // Excluir definitivamente (F6, DATA-01; irreversível): o corpo estrito `{ confirmName }` é validado aqui na borda e as regras (bot
  // arquivado, sem execução aberta, nome igual, limite de 5 por minuto) são do serviço. Responde 204 sem corpo.
  // ponytail: DELETE com corpo JSON depende de o proxy do Easypanel repassar o corpo, trocar o verbo para POST se ele o descartar (prova na T15).
  app.delete('/bots/:id', { schema: { params: botIdParamsSchema, body: botDeleteSchema } }, async (request, reply) => {
    await bots.deleteArchived(request.params.id, request.body.confirmName, originOf(request));
    return reply.status(204).send();
  });
};
