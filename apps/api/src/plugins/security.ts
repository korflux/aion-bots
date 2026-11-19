// Hooks de segurança de toda requisição, na ordem em que valem:
//   1. Autenticação (negação por padrão): exige sessão válida, exceto rotas marcadas `public`.
//   2. CSRF: requisição que altera estado exige `Origin` igual ao origin público configurado; e, quando há
//      sessão, também o token CSRF vinculado a ela. Rotas públicas mutáveis (login) só têm a checagem de
//      Origin, porque ainda não existe sessão a que vincular um token.
//   3. Cabeçalhos de segurança (HSTS, nosniff, Referrer-Policy, CSP, frame-ancestors) em TODA resposta,
//      inclusive erros, e `Cache-Control: no-store` para nada de JSON autenticado ficar em cache.
import { DomainError, type AuthService } from '@aion/core';
import {
  API_CSP,
  ATTACHMENT_PRIVATE_CACHE,
  CSRF_HEADER,
  SESSION_COOKIE_NAME,
  buildSecurityHeaders,
  isHttpsOrigin,
} from '@aion/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface SecurityOptions {
  auth: AuthService;
  /** Origin exato da web (ex.: https://aion.exemplo.com). */
  publicOrigin: string;
}

/** Exige sessão válida em toda rota que não declare `config: { public: true }`. */
async function requireSession(request: FastifyRequest, auth: AuthService): Promise<void> {
  if (request.routeOptions.config.public) return;
  const token = request.cookies[SESSION_COOKIE_NAME];
  const context = token ? await auth.authenticate(token) : null;
  if (!context) throw new DomainError('AUTH_SESSION_EXPIRED');
  request.auth = context;
}

/** Recusa requisição mutável sem Origin válido ou, com sessão, sem o token CSRF correspondente. */
function enforceCsrf(request: FastifyRequest, { auth, publicOrigin }: SecurityOptions): void {
  if (!MUTATING_METHODS.has(request.method)) return;
  if (request.headers.origin !== publicOrigin) throw new DomainError('CSRF_ORIGIN_INVALID');
  if (request.auth) {
    const provided = request.headers[CSRF_HEADER];
    if (!auth.isCsrfTokenValid(request.auth.sessionId, typeof provided === 'string' ? provided : undefined)) {
      throw new DomainError('CSRF_TOKEN_INVALID');
    }
  }
}

/** Instala autenticação, CSRF e cabeçalhos. Deve rodar depois do plugin de cookies. */
export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const headers = buildSecurityHeaders({ csp: API_CSP, https: isHttpsOrigin(options.publicOrigin) });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    await requireSession(request, options.auth);
    enforceCsrf(request, options);
  });
  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(headers)) void reply.header(name, value);
    // Exceção restrita ao conteúdo privado que a rota de conteúdo marcou como guardável (JPEG, original da planilha e arquivo gerado pelo Python),
    // autenticado e autorizado; texto de documento, qualquer outra rota e qualquer erro continuam sem cache.
    const privateFile = request.routeOptions.config.attachmentContent && request.auth && reply.statusCode === 200 && reply.getHeader('Cache-Control') === ATTACHMENT_PRIVATE_CACHE;
    void reply.header('Cache-Control', privateFile ? ATTACHMENT_PRIVATE_CACHE : 'no-store');
    return payload;
  });
}
