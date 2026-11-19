// Rotas das rotinas agendadas (F12; T9), todas sob /api/routines: listar, criar, editar, excluir, pausar, retomar, executar agora,
// histórico, a prévia das próximas execuções, a confirmação de uma proposta antiga de alteração do bot (T21) e, desde a phase 10 (rotina aplicada pelo
// bot na hora), a recusa pelo cartão e a edição ligada ao cartão. Casca fina: a regra (validação da agenda, fila do bot, limite de execuções, perdidas)
// vive em RoutineService (core) e o formato dos dados (allowlist, tamanhos, campos extras recusados) nos schemas de @aion/shared.
//
// Segurança: nenhuma rota é pública, então o hook de segurança exige sessão válida e, nas que alteram estado (inclusive a prévia, que é
// POST por levar a agenda no corpo), Origin e token CSRF. O id da URL é UUID validado antes de chegar ao serviço, que ainda confere que
// a rotina existe (ROUTINE_NOT_FOUND). O bot de uma rotina vem do corpo e é conferido no serviço (existe e não está arquivado); o
// cartão de proposta, quando informado, só vale se for da conversa desse bot. A recusa e a edição pelo cartão recebem só o id da mensagem do cartão: o que
// desfazer ou conferir é o que o servidor gravou nele, e o serviço confere que o cartão é de rotina aplicada pelo bot (anti-IDOR) e que a rotina não mudou depois.
import type { RoutineService } from '@aion/core';
import {
  routineChangeParamsSchema,
  routineChangeResultSchema,
  routineEditSchema,
  routineHistoryQuerySchema,
  routineHistorySchema,
  routineIdParamsSchema,
  routineInputSchema,
  routineListSchema,
  routinePreviewSchema,
  routineScheduleSettingsSchema,
  routineViewSchema,
  runViewSchema,
} from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';

export interface RoutineRoutesOptions {
  routines: RoutineService;
}

export const routineRoutes: FastifyPluginAsyncZod<RoutineRoutesOptions> = async (app, { routines }) => {
  app.get('/routines', { schema: { response: { 200: routineListSchema } } }, async () => routines.list());

  // Prévia de uma agenda ainda não salva. Agenda inválida volta 200 com `valid: false` e o motivo (a tela o mostra na prévia).
  app.post('/routines/preview', { schema: { body: routineScheduleSettingsSchema, response: { 200: routinePreviewSchema } } }, async (request) =>
    routines.preview(request.body),
  );

  app.post('/routines', { schema: { body: routineInputSchema, response: { 201: routineViewSchema } } }, async (request, reply) => {
    const routine = await routines.create(request.body, originOf(request));
    return reply.status(201).send(routine);
  });

  app.get('/routines/:id', { schema: { params: routineIdParamsSchema, response: { 200: routineViewSchema } } }, async (request) =>
    routines.get(request.params.id),
  );

  // Editar substitui a rotina inteira (o editor sempre a envia completa); a agenda nova vale a partir do próximo horário. Com `cardId` (editor aberto
  // pelo cartão da rotina que o bot criou ou alterou) a edição também liga ao cartão: ROUTINE_CHANGED (409) se a rotina mudou depois dele, NOT_FOUND se o
  // cartão não é de rotina aplicada pelo bot ou não é desta rotina.
  app.put(
    '/routines/:id',
    { schema: { params: routineIdParamsSchema, body: routineEditSchema, response: { 200: routineViewSchema } } },
    async (request) => {
      const { cardId, ...replace } = request.body;
      return routines.update(request.params.id, replace, originOf(request), cardId === undefined ? undefined : { cardId });
    },
  );

  app.delete('/routines/:id', { schema: { params: routineIdParamsSchema } }, async (request, reply) => {
    await routines.remove(request.params.id, originOf(request));
    return reply.status(204).send();
  });

  // Pausar e retomar são ações idempotentes.
  app.post('/routines/:id/pause', { schema: { params: routineIdParamsSchema, response: { 200: routineViewSchema } } }, async (request) =>
    routines.pause(request.params.id, originOf(request)),
  );

  app.post('/routines/:id/resume', { schema: { params: routineIdParamsSchema, response: { 200: routineViewSchema } } }, async (request) =>
    routines.resume(request.params.id, originOf(request)),
  );

  // Executar agora: 202, porque a execução só ENTRA NA FILA do bot; quem a roda é o worker.
  app.post('/routines/:id/run', { schema: { params: routineIdParamsSchema, response: { 202: runViewSchema } } }, async (request, reply) => {
    const run = await routines.runNow(request.params.id, originOf(request));
    return reply.status(202).send(run);
  });

  // Confirma a proposta de alteração que um bot deixou num cartão (mudar, pausar, retomar, excluir). O id é o da MENSAGEM do cartão e o
  // corpo não existe: o que aplicar é o que o servidor gravou no cartão, nunca algo vindo do navegador. ROUTINE_CHANGED (409) quando a
  // rotina mudou depois da proposta; NOT_FOUND quando a mensagem não é um cartão de alteração.
  app.post(
    '/routines/changes/:messageId/confirm',
    { schema: { params: routineChangeParamsSchema, response: { 200: routineChangeResultSchema } } },
    async (request) => routines.confirmChange(request.params.messageId, originOf(request)),
  );

  // Recusa o que o bot aplicou (rotina criada ou alteração): o servidor desfaz pelo cartão e grava o aviso ao bot. O id é o da MENSAGEM do cartão e não há
  // corpo. Idempotente; ROUTINE_CHANGED (409) quando a rotina mudou depois do cartão; NOT_FOUND quando a mensagem não é um cartão de rotina aplicada pelo bot.
  app.post(
    '/routines/cards/:messageId/refuse',
    { schema: { params: routineChangeParamsSchema, response: { 200: routineChangeResultSchema } } },
    async (request) => routines.refuse(request.params.messageId, originOf(request)),
  );

  app.get(
    '/routines/:id/history',
    { schema: { params: routineIdParamsSchema, querystring: routineHistoryQuerySchema, response: { 200: routineHistorySchema } } },
    async (request) => routines.history(request.params.id, request.query.cursor),
  );
};
