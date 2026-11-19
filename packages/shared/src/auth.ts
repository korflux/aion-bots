// Contratos de autenticação e sessão (F1) compartilhados entre a API (validação/serialização) e a web (tipos).
// Limites vêm da spec F1: e-mail até 254 caracteres, senha até 256. Campos extras são recusados (`strictObject`).
import { z } from 'zod';

/** Nome do cookie de sessão: HttpOnly, guarda só o token opaco; o servidor guarda o hash. */
export const SESSION_COOKIE_NAME = 'aion_session';

/** Cabeçalho que carrega o token CSRF vinculado à sessão nas requisições que alteram estado. */
export const CSRF_HEADER = 'x-csrf-token';

export const loginRequestSchema = z.strictObject({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Resposta do login: `authenticated` (sessão criada, cookie definido) ou `totp_required` (senha correta e
 * autenticador ativo: o cookie do desafio foi definido e falta o código em `/api/auth/totp/verify`).
 */
export const loginResponseSchema = z.object({ status: z.enum(['authenticated', 'totp_required']) });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** Sessão corrente: quem é o dono, id público da sessão e o token CSRF que a web deve enviar. */
export const sessionInfoSchema = z.object({
  owner: z.object({ email: z.string() }),
  sessionId: z.uuid(),
  csrfToken: z.string(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

/** Uma sessão por dispositivo, como aparece em Configurações → Conta → Sessões. */
export const sessionSummarySchema = z.object({
  id: z.uuid(),
  device: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionListSchema = z.object({ sessions: z.array(sessionSummarySchema) });

export const sessionIdParamsSchema = z.strictObject({ id: z.uuid() });
