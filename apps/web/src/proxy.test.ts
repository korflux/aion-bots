// Prova do origin público no proxy da web (R9 da review do Marco 1; spec "Segurança e operação": HSTS, CSP e redirect).
// O proxy roda antes de toda página: aqui ele é chamado de verdade, com `NextRequest`, variando só o ambiente. O que se prova é o
// efeito observável (cabeçalhos e destino do redirect), e não a presença de um texto no código.
import { PublicOriginMissingError } from '@aion/shared';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import appIcons from '@/lib/app-icons.json';
import { proxy } from './proxy';

afterEach(() => vi.unstubAllEnvs());

/** Requisição sem cookie de sessão a uma página protegida, como chega ao `web` atrás do proxy reverso do Easypanel (http interno). */
const anonymousVisit = () => proxy(new NextRequest('http://web:3000/bots?aba=1'));

describe('origin público do proxy da web', () => {
  it('cacheia somente chunks e ícones públicos em produção, preservando segurança e páginas privadas', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AION_PUBLIC_ORIGIN', 'https://aion.exemplo.com');
    // Os ícones têm o hash do conteúdo no nome (phase 5, T9) e seguem com o cache público de um dia: o endereço troca quando o desenho troca, e esse prazo curto
    // também vale para qualquer arquivo de `/icons/` que um dia entre sem hash (um ano `immutable` ali prenderia um desenho antigo).
    for (const [path, cache] of [
      ['/_next/static/chunks/hash.js', 'public, max-age=31536000, immutable'],
      ...Object.values(appIcons).map((icon) => [icon, 'public, max-age=86400']),
      ['/login', 'no-store'], ['/sw.js', 'no-store'], ['/manifest.webmanifest', 'no-store'],
      ['/bots', 'no-store'], ['/_next/image?url=privada', 'no-store'], ['/icons-extra/arquivo', 'no-store'],
    ]) {
      const response = proxy(new NextRequest(`https://aion.exemplo.com${path}`));
      expect(response.headers.get('cache-control'), path).toBe(cache);
      expect(response.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'");
      expect(response.headers.get('strict-transport-security'), path).toContain('max-age=');
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('referrer-policy'), path).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('x-frame-options'), path).toBe('DENY');
      expect(response.headers.get('permissions-policy'), path).toBe('camera=(), microphone=(self), geolocation=()');
    }
    vi.stubEnv('NODE_ENV', 'development');
    expect(proxy(new NextRequest('http://localhost:3000/_next/static/chunks/dev.js')).headers.get('cache-control')).toBe('no-store');
  });

  it('em produção, sem AION_PUBLIC_ORIGIN (ausente ou vazia), recusa a requisição em vez de servir com um origin adivinhado', () => {
    for (const configured of [undefined, '', '   ']) {
      vi.stubEnv('NODE_ENV', 'production');
      if (configured === undefined) vi.stubEnv('AION_PUBLIC_ORIGIN', undefined);
      else vi.stubEnv('AION_PUBLIC_ORIGIN', configured);
      expect(anonymousVisit).toThrow(PublicOriginMissingError);
    }
  });

  it('com AION_PUBLIC_ORIGIN em produção: HSTS, CSP https e login no endereço configurado', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AION_PUBLIC_ORIGIN', 'https://aion.exemplo.com');
    const response = anonymousVisit();
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://aion.exemplo.com/login?next=%2Fbots%3Faba%3D1');
    expect(response.headers.get('strict-transport-security')).toContain('max-age=');
    expect(response.headers.get('content-security-policy')).toContain('upgrade-insecure-requests');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(self), geolocation=()');
  });

  it('o valor configurado vence o padrão, e em desenvolvimento o padrão é o servidor local, sem HSTS', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AION_PUBLIC_ORIGIN', 'https://outro.exemplo.com.br');
    expect(anonymousVisit().headers.get('location')).toBe('https://outro.exemplo.com.br/login?next=%2Fbots%3Faba%3D1');

    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AION_PUBLIC_ORIGIN', undefined);
    const dev = anonymousVisit();
    expect(dev.headers.get('location')).toBe('http://localhost:3000/login?next=%2Fbots%3Faba%3D1');
    expect(dev.headers.get('strict-transport-security')).toBeNull();
    expect(dev.headers.get('permissions-policy')).toBe('camera=(), microphone=(self), geolocation=()');
    expect(dev.headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests');
  });
});
