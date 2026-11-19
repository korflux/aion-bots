// Proxy do Next (antigo middleware): roda antes de toda página, exceto /api.
//
// Responsabilidades, na ordem:
//   1. Gerar o nonce da CSP e repassá-lo ao Next (que o aplica aos scripts do framework) por cabeçalho de request.
//   2. Sem cookie de sessão fora das rotas públicas, redirecionar ao login preservando o destino. A validação
//      REAL da sessão é do servidor: o layout autenticado consulta a API a cada carga (ver (app)/layout.tsx).
//   3. Aplicar os cabeçalhos de segurança (HSTS, nosniff, Referrer-Policy, frame-ancestors, CSP) a toda resposta.
import { SESSION_COOKIE_NAME, buildSecurityHeaders, buildWebCsp, isHttpsOrigin, resolvePublicOrigin } from '@aion/shared';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Rotas acessíveis sem sessão. Estáticos do Next e o favicon nunca exigem login. O mesmo vale para os arquivos da PWA (manifesto,
 * ícones e service worker): o navegador busca o manifesto e os ícones SEM cookies (a instalação falharia com um redirect ao login), e
 * nenhum deles tem dado do dono.
 */
function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname.startsWith('/login/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    pathname.startsWith('/icons/')
  );
}

/** Ponto de entrada do proxy: nonce da CSP, redirect para o login sem sessão e cabeçalhos de segurança em toda resposta. */
export function proxy(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  // Mesma função da API (`loadApiConfig`): em produção, sem a variável, lança `PublicOriginMissingError` e a página responde 500,
  // em vez de servir com o origin errado (a API, que também a exige, nem sobe).
  const publicOrigin = resolvePublicOrigin(process.env.AION_PUBLIC_ORIGIN, process.env.NODE_ENV);
  const headers = buildSecurityHeaders({
    csp: buildWebCsp({ nonce, isDev: process.env.NODE_ENV === 'development', https: isHttpsOrigin(publicOrigin) }),
    https: isHttpsOrigin(publicOrigin),
  });

  const { pathname, search } = request.nextUrl;
  let response: NextResponse;

  if (!isPublicPath(pathname) && !request.cookies.has(SESSION_COOKIE_NAME)) {
    // A base é o origin PÚBLICO configurado, não `request.url`: atrás do proxy reverso o host e o esquema que o
    // Next enxerga são os internos (http), e o redirect precisa apontar para o endereço que o navegador usa.
    const next = encodeURIComponent(`${pathname}${search}`);
    response = NextResponse.redirect(new URL(`/login?next=${next}`, publicOrigin), 307);
  } else {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('content-security-policy', headers['Content-Security-Policy'] ?? '');
    // Caminho atual, lido pelo layout autenticado para montar o `next` do redirect de sessão inválida.
    requestHeaders.set('x-aion-path', `${pathname}${search}`);
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  // Só assets públicos têm cache: hashes do Next são imutáveis; os ícones têm o hash do conteúdo no nome (phase 5, T9: um desenho novo é OUTRO endereço, então a borda
  // e o navegador nunca o confundem com o antigo), mas seguem com um dia em vez de `immutable`: o prazo curto limita o estrago de qualquer arquivo de `/icons/` que
  // um dia entre sem hash. HTML, manifesto, service worker e qualquer conteúdo do dono continuam sem armazenamento.
  const cacheControl = process.env.NODE_ENV === 'production' && pathname.startsWith('/_next/static/')
    ? 'public, max-age=31536000, immutable'
    : process.env.NODE_ENV === 'production' && pathname.startsWith('/icons/')
      ? 'public, max-age=86400'
      : 'no-store';
  response.headers.set('Cache-Control', cacheControl);
  return response;
}

export const config = {
  // Tudo, menos a API (que define os próprios cabeçalhos e é roteada direto ao serviço `api`).
  matcher: ['/((?!api/).*)'],
};
