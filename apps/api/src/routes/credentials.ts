// Rotas das chaves de terceiros (F3 OpenCode Go, F4 Composio e, desde a phase 17, a chave da Anthropic), todas sob /api/credentials e protegidas por
// sessão e CSRF pelos hooks de segurança (nenhuma é pública). Casca fina: a regra vive em CredentialService (core).
//
// Contrato de segurança (SEC-01, C2): a chave entra só no corpo do POST. NENHUMA resposta a contém, nem a de
// erro: o serviço devolve apenas o estado mascarado, os schemas de resposta abaixo descartam campos desconhecidos
// e o corpo de erro do serviço externo nunca é repassado (ver upstream-http.ts). O destino de rede dos serviços é
// fixo na configuração do servidor; nenhuma rota aceita URL, e campos extras no corpo são recusados.
//
// Usa POST (e não PUT) para salvar porque o cliente HTTP da web só expõe GET, POST e DELETE; o efeito é o de um
// "definir": cria a chave ou substitui a existente, sempre depois de validada.
import type { CredentialService } from '@aion/core';
import {
  credentialKindParamsSchema,
  credentialStatusSchema,
  credentialsOverviewSchema,
  saveCredentialRequestSchema,
} from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';

export interface CredentialsRoutesOptions {
  credentials: CredentialService;
}

export const credentialsRoutes: FastifyPluginAsyncZod<CredentialsRoutesOptions> = async (app, { credentials }) => {
  // Estado das chaves de provedor, conector e Anthropic (configurada ou não, versão mascarada, total de modelos). Sem chamada externa.
  app.get('/credentials', { schema: { response: { 200: credentialsOverviewSchema } } }, () => credentials.overview());

  // Salvar ou substituir: valida no serviço externo e só então grava (rate limit de 10 por minuto no serviço).
  app.post(
    '/credentials/:kind',
    {
      schema: {
        params: credentialKindParamsSchema,
        body: saveCredentialRequestSchema,
        response: { 200: credentialStatusSchema },
      },
    },
    (request) => credentials.save(request.params.kind, request.body.key, originOf(request)),
  );

  // Desconectar: apaga a chave. Idempotente.
  app.delete('/credentials/:kind', { schema: { params: credentialKindParamsSchema } }, async (request, reply) => {
    await credentials.disconnect(request.params.kind, originOf(request));
    return reply.status(204).send();
  });
};
