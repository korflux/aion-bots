// Rotas de gestão do autenticador TOTP (F2: Conta → Autenticador), sob /api/auth/totp. Todas exigem sessão e token
// CSRF (negação por padrão do hook de segurança). Casca fina: as regras, o bloqueio de tentativas (AUTH-04) e a
// auditoria vivem em AuthService (core). O segundo passo do login (`/auth/totp/verify`) está em routes/auth.ts.
//
// Sobre o segredo: `setup` é a ÚNICA resposta que o contém (a spec F2 exige mostrá-lo no modal antes da
// confirmação). Depois de ativo, nenhuma rota o devolve; `GET /auth/totp` informa só se está ativo.
import type { AuthService } from '@aion/core';
import {
  totpDisableRequestSchema,
  totpEnableRequestSchema,
  totpSetupResponseSchema,
  totpStatusSchema,
} from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';

export interface TotpRoutesOptions {
  auth: AuthService;
}

export const totpRoutes: FastifyPluginAsyncZod<TotpRoutesOptions> = async (app, { auth }) => {
  // Estado atual, para Conta mostrar "Ativar" ou "Desativar".
  app.get('/auth/totp', { schema: { response: { 200: totpStatusSchema } } }, () => auth.totpStatus());

  // Abre a ativação: segredo novo, URI do QR e token de ativação. Não grava nada.
  app.post('/auth/totp/setup', { schema: { response: { 200: totpSetupResponseSchema } } }, () =>
    auth.beginTotpEnrollment(),
  );

  // Confirma a ativação com o código do app; só então o segredo é gravado como ativo.
  app.post('/auth/totp/enable', { schema: { body: totpEnableRequestSchema } }, async (request, reply) => {
    await auth.enableTotp({ ...request.body, ...originOf(request) });
    return reply.status(204).send();
  });

  // Desativa com um código atual.
  app.post('/auth/totp/disable', { schema: { body: totpDisableRequestSchema } }, async (request, reply) => {
    await auth.disableTotp({ ...request.body, ...originOf(request) });
    return reply.status(204).send();
  });
};
