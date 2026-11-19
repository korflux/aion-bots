// Rotas do web push (F14; T10, T13; phase 3 T3), todas sob /api/push: a configuração pública do Firebase, listar, registrar e remover
// dispositivos, a matriz de silenciar por bot e por tipo, a abertura do app, a conferência do service worker, o registro do que o service worker fez com o aviso e os interruptores "Mostrar conteúdo" (phase 16). Casca fina: a regra (token único, rótulo do dispositivo, auditoria, matriz) vive em
// PushService (core) e o formato dos dados (token em ASCII imprimível de até 4.096 caracteres, tipos na allowlist, campos extras
// recusados) nos schemas de @aion/shared. O ENVIO dos pushes, e a consulta à matriz na hora de enviar, não passam pela API: são do
// despachante do worker.
//
// Segurança: nenhuma rota é pública, então o hook de segurança exige sessão válida e, nas que alteram estado, Origin e token CSRF. O
// token do dispositivo só entra pelo corpo do registro e nunca volta nas respostas. A configuração entregue ao navegador é só a PÚBLICA
// do app web do Firebase e a chave VAPID pública; a conta de serviço que envia fica apenas no worker.
import type { PushService } from '@aion/core';
import {
  pushConfigSchema,
  pushDeviceCreateSchema,
  pushDeviceIdParamsSchema,
  pushDeviceListSchema,
  pushDeviceSchema,
  pushContentSetSchema,
  pushContentSettingsSchema,
  pushEventCheckQuerySchema,
  pushEventCheckSchema,
  pushMuteSetSchema,
  pushMuteTargetSchema,
  PUSH_RECEIPT_BODY_LIMIT,
  pushPreferencesSchema,
  pushReceiptCreateSchema,
} from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sessionOf } from './auth';
import { originOf } from './origin';

export interface PushRoutesOptions {
  push: PushService;
}

export const pushRoutes: FastifyPluginAsyncZod<PushRoutesOptions> = async (app, { push }) => {
  app.get('/push/config', { schema: { response: { 200: pushConfigSchema } } }, async () => push.config());

  app.get('/push/devices', { schema: { response: { 200: pushDeviceListSchema } } }, async () => ({ devices: await push.listDevices() }));

  // Registrar é idempotente por token (a web o chama a cada carga com o push ativo), por isso 200 e não 201.
  app.post('/push/devices', { schema: { body: pushDeviceCreateSchema, response: { 200: pushDeviceSchema } } }, async (request) =>
    push.registerDevice(request.body.token, originOf(request)),
  );

  app.delete('/push/devices/:id', { schema: { params: pushDeviceIdParamsSchema } }, async (request, reply) => {
    await push.removeDevice(request.params.id, originOf(request));
    return reply.status(204).send();
  });

  // Matriz de silenciar (T13): bots ativos e o Chat geral, cada um com os tipos silenciados.
  app.get('/push/preferences', { schema: { response: { 200: pushPreferencesSchema } } }, async () => push.listPreferences());

  // Um tipo por chamada, com o estado final no corpo (idempotente); devolve a linha da matriz atualizada. `botId: null` é o Chat geral.
  app.put('/push/preferences', { schema: { body: pushMuteSetSchema, response: { 200: pushMuteTargetSchema } } }, async (request) =>
    push.setMute(request.body.botId, request.body.kind, request.body.muted, originOf(request)),
  );

  // Abertura do app (phase 3, T3; F3): escrita SEM corpo (o Fastify exige bodyLimit > 0; com 1 byte, qualquer
  // corpo JSON real é recusado com PAYLOAD_TOO_LARGE, e nada do corpo é lido), com sessão, Origin e CSRF
  // pelo hook de segurança. O instante gravado é o do servidor e só avança; 10 por minuto por sessão.
  app.put('/push/opened', { bodyLimit: 1 }, async (request, reply) => {
    await push.recordAppOpen(sessionOf(request).sessionId);
    return reply.status(204).send();
  });

  // Conferência do service worker (phase 3, T3; F2): leitura com sessão (o cookie vai junto no fetch do service worker), até 21 ids e 60 por
  // minuto por sessão (no-store). Responde se cada aviso ainda vale e, para o evento válido de uma origem com "Mostrar conteúdo" ligado (phase 16, SEC-07), também título, corpo e
  // id da aprovação, que não passam por log nem por auditoria.
  app.get('/push/events/check', { schema: { querystring: pushEventCheckQuerySchema, response: { 200: pushEventCheckSchema } } }, async (request) =>
    push.checkEvents(sessionOf(request).sessionId, request.query.ids),
  );

  // Registro do service worker (phase 16; A1, A9): sessão, Origin e CSRF pelo hook de segurança (o worker pega o token em GET /api/auth/session), corpo de
  // até 1 KB (acima, 413 PAYLOAD_TOO_LARGE), quatro campos em allowlist (VALIDATION_FAILED fora dela), 120 por minuto por sessão (RATE_LIMITED) e, conferidos
  // à parte, dispositivo e evento existentes (NOT_FOUND). Idempotente por evento, dispositivo e estado. 204 sem corpo; a recusa não grava nada.
  app.post('/push/receipts', { bodyLimit: PUSH_RECEIPT_BODY_LIMIT, schema: { body: pushReceiptCreateSchema } }, async (request, reply) => {
    await push.recordReceipt(sessionOf(request).sessionId, request.body);
    return reply.status(204).send();
  });

  // Interruptores "Mostrar conteúdo" (phase 16, passo 4; NOTIF-02): o estado dos dois e a mudança de UMA origem por chamada, com o estado final no corpo (idempotente). Sessão, Origin e
  // CSRF pelo hook de segurança; a regra e a auditoria (só a origem e o booleano) moram em `PushService.setContent`.
  app.get('/push/content', { schema: { response: { 200: pushContentSettingsSchema } } }, async () => push.contentSettings());

  app.put('/push/content', { schema: { body: pushContentSetSchema, response: { 200: pushContentSettingsSchema } } }, async (request) =>
    push.setContent(request.body.origin, request.body.enabled, originOf(request)),
  );
};
