// Prova do destino pós-login: só caminhos internos passam (proteção contra open redirect).
import { describe, expect, it } from 'vitest';
import { DEFAULT_AFTER_LOGIN, safeNextPath } from './next-path';

describe('destino pós-login seguro', () => {
  it('o destino padrão é o Início (`/`), e um `next` válido, inclusive `/bots` e o próprio `/`, continua respeitado', () => {
    expect(DEFAULT_AFTER_LOGIN).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('/?aviso=1')).toBe('/?aviso=1');
    expect(safeNextPath('/bots')).toBe('/bots');
  });

  it('aceita caminhos internos com query e recusa tudo que sairia do app', () => {
    expect(safeNextPath('/rotinas?filtro=ativas')).toBe('/rotinas?filtro=ativas');
    expect(safeNextPath('/bots/abc#fim')).toBe('/bots/abc#fim');

    const hostile = [
      '//evil.example',
      '//evil.example/bots',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      'bots',
      '/bots\r\nSet-Cookie: x=1',
      '/bots\\..\\..',
      '/login',
      '/login?next=/bots',
      '',
    ];
    for (const value of hostile) expect(safeNextPath(value), value).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
    expect(safeNextPath(null, '/atividades')).toBe('/atividades');
  });
});
