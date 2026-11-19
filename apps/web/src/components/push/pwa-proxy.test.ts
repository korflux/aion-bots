// Prova, pelo proxy do Next de verdade, de dois requisitos do push (T10): os arquivos da PWA (manifesto, ícones, service worker) abrem sem
// sessão, porque o navegador os busca sem cookies, e a CSP libera para conexão SÓ os dois domínios do SDK do Firebase, nenhum outro destino
// externo. As páginas do app continuam exigindo sessão.
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import appIcons from '@/lib/app-icons.json';
import { proxy } from '../../proxy';

afterEach(() => vi.unstubAllEnvs());

describe('arquivos da PWA e CSP do push', () => {
  it('manifesto, ícones e service worker são públicos; as páginas seguem protegidas', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AION_PUBLIC_ORIGIN', 'https://aion.exemplo.com');
    // Os ícones são os endereços com hash do conteúdo (phase 5, T9), lidos do registro que o gerador grava: todos abrem sem sessão.
    for (const path of ['/manifest.webmanifest', '/sw.js', ...Object.values(appIcons)]) {
      const response = proxy(new NextRequest(`http://web:3000${path}`));
      expect(response.status, path).toBe(200);
      expect(response.headers.get('location'), path).toBeNull();
    }
    for (const path of ['/configuracoes/notificacoes', '/bots', '/icons-privados']) {
      expect(proxy(new NextRequest(`http://web:3000${path}`)).status, path).toBe(307);
    }
  });

  it('a CSP libera só os domínios do FCM para o navegador obter o token, e o service worker só do próprio app', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AION_PUBLIC_ORIGIN', 'https://aion.exemplo.com');
    const csp = proxy(new NextRequest('http://web:3000/login')).headers.get('content-security-policy') ?? '';
    const directive = (name: string) => csp.split('; ').find((entry) => entry.startsWith(`${name} `))?.split(' ').slice(1).sort();
    expect(directive('connect-src')).toEqual(["'self'", 'https://fcmregistrations.googleapis.com', 'https://firebaseinstallations.googleapis.com']);
    expect(directive('worker-src')).toEqual(["'self'"]);
    expect(directive('default-src')).toEqual(["'self'"]);
  });
});
