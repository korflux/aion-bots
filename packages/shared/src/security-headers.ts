// Cabeçalhos de segurança HTTP e CSP, definidos uma única vez para api e web.
//
// - A API responde JSON, então a CSP dela é a mais fechada possível (`default-src 'none'`).
// - A web responde HTML: usa CSP com nonce por requisição (gerado no proxy do Next) e `strict-dynamic`.
//
// ponytail: style-src aceita 'unsafe-inline' porque Radix/Sonner/Next emitem estilos inline no SSR, trocar por
// nonce/hash de estilo quando o custo de manter compatibilidade com esses componentes compensar.
// connect-src libera 'self' e SÓ os dois domínios que o SDK web do Firebase usa para obter o token de push (T10): nenhum outro
// destino externo é permitido ao navegador. O envio do push é do servidor e a entrega passa pelo serviço de push do navegador, que
// não está sujeito à CSP da página.

/** Domínios que o SDK do Firebase Messaging contata no navegador: instalação (id do app) e registro do token de push. */
export const FCM_CLIENT_ORIGINS = ['https://firebaseinstallations.googleapis.com', 'https://fcmregistrations.googleapis.com'] as const;

/** CSP da API: nada é carregado a partir de respostas JSON, nem embutido em frames. */
export const API_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface WebCspOptions {
  /** Nonce único por requisição, em base64. */
  nonce: string;
  /** Dev precisa de 'unsafe-eval' (React usa eval para reconstruir stacks); produção não. */
  isDev: boolean;
  /** Só força upgrade de requisições inseguras quando o app é servido por HTTPS. */
  https: boolean;
}

/** CSP das páginas HTML do Next.js, com nonce e sem scripts inline arbitrários. */
export function buildWebCsp({ nonce, isDev, https }: WebCspOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${FCM_CLIENT_ORIGINS.join(' ')}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export interface SecurityHeaderOptions {
  csp: string;
  /** HSTS só faz sentido (e só é honrado) sobre HTTPS. */
  https: boolean;
}

/**
 * Conjunto de cabeçalhos aplicado a toda resposta (api e web): HSTS, nosniff, Referrer-Policy,
 * proteção contra framing e Permissions-Policy: câmera/geolocalização fechadas, microfone só na própria origem para o ditado.
 */
export function buildSecurityHeaders({ csp, https }: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (https) headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  return headers;
}

/** O origin público configurado usa HTTPS? Decide HSTS e `upgrade-insecure-requests`. */
export function isHttpsOrigin(origin: string): boolean {
  return origin.startsWith('https://');
}

/** Origin público em desenvolvimento e testes: o servidor do Next local. */
export const DEVELOPMENT_PUBLIC_ORIGIN = 'http://localhost:3000';

/** Produção sem `AION_PUBLIC_ORIGIN`: a API converte em `ConfigError` na subida; o proxy da web deixa a requisição falhar. */
export class PublicOriginMissingError extends Error {
  constructor() {
    super('AION_PUBLIC_ORIGIN ausente (obrigatória em produção: origin exato da web, ex.: https://aion.exemplo.com)');
    this.name = 'PublicOriginMissingError';
  }
}

/**
 * FONTE ÚNICA do origin público (base do CSRF, do HSTS, da CSP e do destino do redirect de login). A API (`loadApiConfig`) e o
 * proxy da web usam esta função, então a regra não diverge entre os dois serviços. Em produção a variável é obrigatória e não
 * há padrão: um domínio fixo no código faria cada instalação herdar o origin de outra (CSRF recusando tudo, login redirecionado
 * para fora), e `localhost` desligaria HSTS e `upgrade-insecure-requests` sem nenhum erro. Fora de produção vale o Next local.
 */
export function resolvePublicOrigin(configured: string | undefined, nodeEnv: string | undefined): string {
  const value = configured?.trim();
  if (value) return value;
  if (nodeEnv === 'production') throw new PublicOriginMissingError();
  return DEVELOPMENT_PUBLIC_ORIGIN;
}
