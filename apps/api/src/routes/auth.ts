// Rotas de autenticação e sessão (F1), todas sob /api/auth. Casca fina: a regra vive em AuthService (core).
//
// Cookie de sessão: HttpOnly, SameSite=Lax e Secure em produção. Ele dura mais que a sessão de propósito
// (a validade real, de 30 dias renovada pelo uso, é imposta no servidor), assim o navegador nunca descarta
// o cookie antes do servidor e a renovação não depende de reemitir Set-Cookie.
//
// Login com TOTP (A2): a senha correta com autenticador ativo não cria sessão; responde `totp_required` e define o
// cookie do desafio (HttpOnly, SameSite=Strict, restrito a /api/auth, 5 min). O código vai a /auth/totp/verify, que
// lê o desafio do cookie: o JavaScript da página nunca vê o desafio nem o segredo.
import { DomainError, type AuthContext, type AuthService } from '@aion/core';
import {
  SESSION_COOKIE_NAME,
  TOTP_CHALLENGE_COOKIE_NAME,
  TOTP_CHALLENGE_TTL_SECONDS,
  loginRequestSchema,
  loginResponseSchema,
  sessionIdParamsSchema,
  sessionInfoSchema,
  sessionListSchema,
  totpVerifyRequestSchema,
} from '@aion/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';

export interface AuthRoutesOptions {
  auth: AuthService;
  secureCookies: boolean;
}

const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** Sessão da requisição; nas rotas protegidas o hook de segurança já a preencheu. */
export function sessionOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new DomainError('AUTH_SESSION_EXPIRED');
  return request.auth;
}

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = async (app, { auth, secureCookies }) => {
  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies } as const;
  // Strict: o desafio só acompanha chamadas do próprio site. O caminho restrito impede que ele siga para /api/*.
  const challengeCookieOptions = { path: '/api/auth', httpOnly: true, sameSite: 'strict', secure: secureCookies } as const;

  /** Entrega a sessão ao navegador. Único ponto que define o cookie de sessão (login direto e login com TOTP). */
  const startSession = (reply: FastifyReply, token: string) => {
    void reply.setCookie(SESSION_COOKIE_NAME, token, { ...cookieOptions, maxAge: COOKIE_MAX_AGE_SECONDS });
    return { status: 'authenticated' as const };
  };

  // Login: pública, mas protegida por Origin (CSRF), bloqueio por IP/global e mensagem única de erro.
  app.post(
    '/auth/login',
    {
      config: { public: true },
      schema: { body: loginRequestSchema, response: { 200: loginResponseSchema } },
    },
    async (request, reply) => {
      const result = await auth.login({ ...request.body, ...originOf(request) });
      if (result.status === 'totp_required') {
        void reply.setCookie(TOTP_CHALLENGE_COOKIE_NAME, result.challenge, {
          ...challengeCookieOptions,
          maxAge: TOTP_CHALLENGE_TTL_SECONDS,
        });
        return { status: 'totp_required' as const };
      }
      return startSession(reply, result.token);
    },
  );

  // Segundo passo do login com TOTP: pública (ainda não há sessão), protegida por Origin, pelo desafio do cookie e
  // pelo mesmo bloqueio de tentativas do login. Sem o cookie (vencido no navegador), equivale a desafio expirado.
  app.post(
    '/auth/totp/verify',
    {
      config: { public: true },
      schema: { body: totpVerifyRequestSchema, response: { 200: loginResponseSchema } },
    },
    async (request, reply) => {
      const challenge = request.cookies[TOTP_CHALLENGE_COOKIE_NAME];
      if (!challenge) throw new DomainError('AUTH_TOTP_EXPIRED');
      const { token } = await auth.completeTotpLogin({ challenge, code: request.body.code, ...originOf(request) });
      void reply.clearCookie(TOTP_CHALLENGE_COOKIE_NAME, challengeCookieOptions);
      return startSession(reply, token);
    },
  );

  // Sessão atual: dono, id público e token CSRF que a web envia nas requisições que alteram estado.
  app.get('/auth/session', { schema: { response: { 200: sessionInfoSchema } } }, async (request) => {
    const session = sessionOf(request);
    return {
      owner: { email: session.ownerEmail },
      sessionId: session.sessionId,
      csrfToken: auth.csrfTokenFor(session.sessionId),
    };
  });

  app.get('/auth/sessions', { schema: { response: { 200: sessionListSchema } } }, async (request) => ({
    sessions: await auth.listSessions(sessionOf(request).sessionId),
  }));

  // Sair: revoga a sessão atual no servidor e remove o cookie.
  app.post('/auth/logout', async (request, reply) => {
    await auth.logout(sessionOf(request).sessionId, originOf(request));
    void reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
    return reply.status(204).send();
  });

  // Encerrar uma sessão listada em Conta. Se for a própria, equivale a sair e o cookie também é removido.
  app.delete('/auth/sessions/:id', { schema: { params: sessionIdParamsSchema } }, async (request, reply) => {
    const current = sessionOf(request);
    await auth.revokeSession(request.params.id, originOf(request));
    if (request.params.id === current.sessionId) void reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
    return reply.status(204).send();
  });
};
