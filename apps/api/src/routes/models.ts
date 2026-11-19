// Rotas de modelos (F8, T5), todas sob /api/models e protegidas por sessão e CSRF pelos hooks de segurança (nenhuma é
// pública). Casca fina: a regra vive em ModelService (core) e o formato dos dados nos schemas de @aion/shared.
//
// Segurança: o id do modelo vem do cliente, mas só é aceito se constar na lista atual do provedor (allowlist no
// serviço); nenhum campo escolhe destino de rede nem a chave do provedor, que nunca sai do servidor. Corpos são estritos
// (campos extras recusados). Testar custa chamadas ao provedor e é limitado a 10 por minuto no serviço.
//
// Usa POST /models/test (e não /models/:id/test) e PATCH /models/favorite com o id no corpo: ids de modelo têm pontos e
// podem ter barras, e o corpo evita qualquer ambiguidade de codificação no caminho.
import type { ModelService } from '@aion/core';
import { modelEntrySchema, modelFavoriteRequestSchema, modelHiddenRequestSchema, modelListSchema, modelTestRequestSchema } from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

export interface ModelRoutesOptions {
  models: ModelService;
}

export const modelRoutes: FastifyPluginAsyncZod<ModelRoutesOptions> = async (app, { models }) => {
  // Lista do provedor com favorito e último teste de cada modelo (abre o seletor).
  // Traz também os recentes (até 5 ids, A26) e, por modelo, nome, preço e se o dono o ocultou.
  app.get('/models', { schema: { response: { 200: modelListSchema } } }, async () => {
    const list = await models.list();
    return { models: list, recents: await models.recents(list.map((entry) => entry.id)) };
  });
  // Preferências usam somente perfis persistidos; abrir uma tela não consulta o provedor.
  app.get('/models/profiles', { schema: { response: { 200: modelListSchema } } }, async () => ({ models: await models.profiles() }));

  // Visão usa a mesma allowlist, sessão, CSRF e orçamento de testes do seletor.
  app.post('/models/verify-image', { schema: { body: modelTestRequestSchema, response: { 200: modelEntrySchema } } },
    async (request) => models.verifyImage(request.body.model));

  // Testa o modelo (texto, streaming, ferramenta e effort) e grava o resultado por cima do anterior.
  app.post(
    '/models/test',
    { schema: { body: modelTestRequestSchema, response: { 200: modelEntrySchema } } },
    async (request) => models.test(request.body.model),
  );

  // Marca ou desmarca o favorito. Idempotente.
  app.patch(
    '/models/favorite',
    { schema: { body: modelFavoriteRequestSchema, response: { 200: modelEntrySchema } } },
    async (request) => models.setFavorite(request.body.model, request.body.favorite),
  );

  // Oculta ou reexibe o modelo (curadoria em Conexões, A7). Idempotente; o id vai no corpo, como no favorito.
  app.patch(
    '/models/hidden',
    { schema: { body: modelHiddenRequestSchema, response: { 200: modelEntrySchema } } },
    async (request) => models.setHidden(request.body.model, request.body.hidden),
  );
};
