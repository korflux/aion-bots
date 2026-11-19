// Rotas da memória global e por bot (F11, T8): ler, salvar, histórico de versões, restaurar e desfazer pelo cartão. Casca fina: a
// regra (limite de 8.000 caracteres, versão esperada, versões imutáveis, retenção) vive em MemoryService (core) e o formato dos
// dados (campos permitidos, versão como inteiro, texto sem caracteres de controle, tetos de tamanho) nos schemas de @aion/shared.
//
// Segurança: nenhuma rota é pública, então o hook de segurança exige sessão válida e, nas que alteram estado, Origin e token CSRF. O
// id do bot é UUID validado antes de chegar ao serviço, que confere que o bot existe (BOT_NOT_FOUND), e o desfazer só aceita um
// cartão da conversa DESTE bot (sem IDOR entre bots). Não existe rota para o bot escrever: a ferramenta do bot roda no worker e só
// alcança a memória do próprio bot.
import type { MemoryService } from '@aion/core';
import {
  botIdParamsSchema,
  botMemoryVersionParamsSchema,
  memoryVersionDetailSchema,
  memoryVersionListSchema,
  memoryVersionParamsSchema,
  memoryViewSchema,
  restoreMemoryRequestSchema,
  saveMemoryRequestSchema,
  undoMemoryRequestSchema,
} from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';

export interface MemoryRoutesOptions {
  memory: MemoryService;
}

const GLOBAL = { scope: 'global' } as const;
const botOf = (botId: string) => ({ scope: 'bot', botId }) as const;

export const memoryRoutes: FastifyPluginAsyncZod<MemoryRoutesOptions> = async (app, { memory }) => {
  // ---- Memória global (tela Configurações → Memória global) ----
  app.get('/memory/global', { schema: { response: { 200: memoryViewSchema } } }, async () => memory.read(GLOBAL));

  app.put(
    '/memory/global',
    { schema: { body: saveMemoryRequestSchema, response: { 200: memoryViewSchema } } },
    async (request) => memory.save(GLOBAL, request.body.content, request.body.expectedVersion, originOf(request)),
  );

  app.get('/memory/global/versions', { schema: { response: { 200: memoryVersionListSchema } } }, async () => memory.listVersions(GLOBAL));

  app.get(
    '/memory/global/versions/:version',
    { schema: { params: memoryVersionParamsSchema, response: { 200: memoryVersionDetailSchema } } },
    async (request) => memory.getVersion(GLOBAL, request.params.version),
  );

  app.post(
    '/memory/global/restore',
    { schema: { body: restoreMemoryRequestSchema, response: { 200: memoryViewSchema } } },
    async (request) => memory.restore(GLOBAL, request.body.version, request.body.expectedVersion, originOf(request)),
  );

  // ---- Memória do bot (tela /bots/[id]/memoria) ----
  app.get(
    '/bots/:id/memory',
    { schema: { params: botIdParamsSchema, response: { 200: memoryViewSchema } } },
    async (request) => memory.read(botOf(request.params.id)),
  );

  app.put(
    '/bots/:id/memory',
    { schema: { params: botIdParamsSchema, body: saveMemoryRequestSchema, response: { 200: memoryViewSchema } } },
    async (request) => memory.save(botOf(request.params.id), request.body.content, request.body.expectedVersion, originOf(request)),
  );

  app.get(
    '/bots/:id/memory/versions',
    { schema: { params: botIdParamsSchema, response: { 200: memoryVersionListSchema } } },
    async (request) => memory.listVersions(botOf(request.params.id)),
  );

  app.get(
    '/bots/:id/memory/versions/:version',
    { schema: { params: botMemoryVersionParamsSchema, response: { 200: memoryVersionDetailSchema } } },
    async (request) => memory.getVersion(botOf(request.params.id), request.params.version),
  );

  app.post(
    '/bots/:id/memory/restore',
    { schema: { params: botIdParamsSchema, body: restoreMemoryRequestSchema, response: { 200: memoryViewSchema } } },
    async (request) => memory.restore(botOf(request.params.id), request.body.version, request.body.expectedVersion, originOf(request)),
  );

  // Desfazer pelo cartão "Memória atualizada" da conversa: restaura o texto de antes da edição do bot, como versão nova.
  app.post(
    '/bots/:id/memory/undo',
    { schema: { params: botIdParamsSchema, body: undoMemoryRequestSchema, response: { 200: memoryViewSchema } } },
    async (request) => memory.undoCard(request.params.id, request.body.cardId, originOf(request)),
  );
};
