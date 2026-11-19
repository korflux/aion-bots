// Rotas do chat geral (F16, A15; T12, T16, T23): sob /api/chat/sessions, listar, abrir o "Novo chat", ler uma sessão e ligar ou desligar
// "salvar"; sob /api/chat/settings, ler e definir o modelo padrão do chat. Casca fina: as regras vivem em GeneralChatService e
// ConversationService (core) e o formato dos dados nos schemas de @aion/shared. A conversa DENTRO da sessão
// (mensagens, parar, SSE) são as rotas de `conversation.ts` sob /chat/sessions/:id, registradas junto das do bot.
//
// Segurança: nenhuma rota é pública, então o hook de segurança exige sessão válida e, nas que alteram estado, Origin e token CSRF. O id
// da sessão é um UUID validado antes de chegar ao serviço, que confere que ele é de uma sessão (SESSION_NOT_FOUND: o id de um bot nunca
// abre uma sessão por aqui). O corpo do PATCH aceita só `saved` (campos extras recusados): título e datas nunca vêm do cliente.
import type { ConversationService, GeneralChatService } from '@aion/core';
import {
  chatSessionListQuerySchema,
  chatSessionListSchema,
  chatSessionParamsSchema,
  chatSessionSaveRequestSchema,
  chatSessionSchema,
  chatSettingsUpdateSchema,
  modelChoiceSchema,
} from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';

export interface ChatRoutesOptions {
  chat: GeneralChatService;
  conversations: ConversationService;
}

export const chatRoutes: FastifyPluginAsyncZod<ChatRoutesOptions> = async (app, { chat, conversations }) => {
  // Modelo padrão do Chat geral (T23): `model` nulo = ainda não definido (o chat geral não deixa conversar). Definir exige um modelo da
  // lista do provedor (MODEL_UNAVAILABLE) e um effort que ele aceite (VALIDATION_FAILED); campos extras e modelo nulo são recusados na borda.
  app.get('/chat/settings', { schema: { response: { 200: modelChoiceSchema } } }, async () => conversations.sessionDefault());
  app.put(
    '/chat/settings',
    { schema: { body: chatSettingsUpdateSchema, response: { 200: modelChoiceSchema } } },
    async (request) => conversations.setSessionDefault(request.body.model, request.body.effort, originOf(request)),
  );

  // Lista para o painel: as sessões mais recentemente ativas, com a data de expiração de cada uma (nula nas salvas). O rascunho vazio fica fora. `?saved=true` (única
  // consulta aceita, por allowlist) devolve só as salvas: é a vista "Salvos" de /chats, filtrada aqui para uma sessão salva antiga não ficar fora do teto da lista.
  app.get('/chat/sessions', { schema: { querystring: chatSessionListQuerySchema, response: { 200: chatSessionListSchema } } }, async (request) =>
    chat.list({ saved: request.query.saved === 'true' }),
  );

  // "Novo chat": devolve o rascunho vazio que já existe ou cria um (nunca acumula sessões vazias); ele só ganha título e entra na lista
  // na primeira mensagem. 201 nos dois casos: do ponto de vista de quem chama, sempre há um chat novo à disposição.
  app.post('/chat/sessions', { schema: { response: { 201: chatSessionSchema } } }, async (_request, reply) => reply.status(201).send(await chat.openDraft()));

  app.get('/chat/sessions/:id', { schema: { params: chatSessionParamsSchema, response: { 200: chatSessionSchema } } }, async (request) =>
    chat.get(request.params.id),
  );

  // Salvar suspende a exclusão por retenção; desligar volta a contar 7 dias a partir da última mensagem. Idempotente.
  app.patch(
    '/chat/sessions/:id',
    { schema: { params: chatSessionParamsSchema, body: chatSessionSaveRequestSchema, response: { 200: chatSessionSchema } } },
    async (request) => chat.setSaved(request.params.id, request.body.saved),
  );
};
