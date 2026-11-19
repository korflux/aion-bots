// Rota de presença e leitura (phase 3, T2; F1/A2; NOTIF-01): `PUT /api/presence`, que a conversa aberta, visível e em foco chama ao começar,
// a cada 20 s e ao terminar (este último com `fetch keepalive`, para sobreviver ao fechamento da página). Casca fina: a regra (conversa
// existente, leitura monotônica e da própria conversa, presença por sessão, 30 por minuto) vive em PresenceService (core) e o formato do corpo
// no schema estrito de @aion/shared.
//
// Segurança: protegida por padrão pelo hook de segurança (sessão válida, Origin e token CSRF por ser PUT). A sessão gravada é SEMPRE a do
// cookie (`request.auth`), nunca um id enviado pelo navegador. O corpo é limitado a 1 KB aqui, antes do parse (excesso = PAYLOAD_TOO_LARGE).
// Nada da conversa vai ao log e não há auditoria (Contratos da spec: volume alto, nenhum risco).
import type { PresenceService } from '@aion/core';
import { PRESENCE_BODY_MAX_BYTES, presenceUpdateSchema } from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sessionOf } from './auth';

export interface PresenceRoutesOptions {
  presence: PresenceService;
}

export const presenceRoutes: FastifyPluginAsyncZod<PresenceRoutesOptions> = async (app, { presence }) => {
  // Idempotente (o corpo descreve o estado: presente ou não, lido até onde), por isso PUT; sem conteúdo na resposta.
  app.put('/presence', { bodyLimit: PRESENCE_BODY_MAX_BYTES, schema: { body: presenceUpdateSchema } }, async (request, reply) => {
    await presence.update(sessionOf(request).sessionId, request.body);
    return reply.status(204).send();
  });
};
