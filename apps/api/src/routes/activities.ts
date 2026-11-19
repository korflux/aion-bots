// Rota da tela Atividades (F15, A14; T11): uma página das aprovações pendentes e das execuções recentes de todos os bots. Casca fina: a
// montagem da visão vive em ActivityService (core) e o formato dos dados nos schemas de @aion/shared.
//
// Segurança: não é pública, então o hook de segurança exige sessão válida. É uma consulta (GET, sem CSRF) e a única entrada é o cursor,
// um id de dígitos validado na borda (campos extras recusados); o cursor só desloca a página e nunca escolhe um recurso. Parar uma
// execução e responder a uma aprovação NÃO são feitos aqui: usam as rotas de F7 (`POST /bots/:id/runs/stop`) e de F9.
import type { ActivityService } from '@aion/core';
import { activitiesPageSchema, activitiesQuerySchema } from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

export interface ActivityRoutesOptions {
  activities: ActivityService;
}

export const activityRoutes: FastifyPluginAsyncZod<ActivityRoutesOptions> = async (app, { activities }) => {
  app.get(
    '/activities',
    { schema: { querystring: activitiesQuerySchema, response: { 200: activitiesPageSchema } } },
    async (request) => activities.list(request.query.cursor),
  );
};
