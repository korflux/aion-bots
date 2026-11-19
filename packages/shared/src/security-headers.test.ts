// Prova da fonte única do origin público (R9): a API e o proxy da web resolvem o origin pela mesma função.
import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders, DEVELOPMENT_PUBLIC_ORIGIN, PublicOriginMissingError, isHttpsOrigin, resolvePublicOrigin } from './security-headers';

describe('resolvePublicOrigin', () => {
  it('libera somente o microfone da própria origem em HTTP e HTTPS', () => {
    for (const https of [false, true]) {
      expect(buildSecurityHeaders({ csp: "default-src 'none'", https })['Permissions-Policy']).toBe('camera=(), microphone=(self), geolocation=()');
    }
  });
  it('usa o valor configurado; sem ele (ausente ou em branco) produção recusa, sem padrão fixo, e fora dela vale o Next local', () => {
    expect(resolvePublicOrigin('https://exemplo.com.br', 'production')).toBe('https://exemplo.com.br');
    expect(resolvePublicOrigin('  https://exemplo.com.br  ', 'development')).toBe('https://exemplo.com.br');

    for (const blank of [undefined, '', '   ']) {
      expect(() => resolvePublicOrigin(blank, 'production')).toThrow(PublicOriginMissingError);
      for (const env of ['development', 'test', undefined]) expect(resolvePublicOrigin(blank, env)).toBe(DEVELOPMENT_PUBLIC_ORIGIN);
    }
    expect(isHttpsOrigin('https://exemplo.com.br')).toBe(true);
    expect(isHttpsOrigin(DEVELOPMENT_PUBLIC_ORIGIN)).toBe(false);
  });
});
