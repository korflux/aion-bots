// Prova de que as 6 áreas de Configurações e os redirecionamentos das rotas antigas (phase 5, T4; spec F9, Suposição 23) formam um conjunto consistente: o painel do desktop lista as
// mesmas áreas, na mesma ordem, que o índice; e cada rota antiga redireciona de forma permanente para uma área que existe (sem apontar para outra rota antiga nem colidir com uma área
// nova). O redirecionamento em si (308 e query string) é provado no E2E contra o servidor de produção. O conjunto aqui é só o das rotas de Configurações (destino em
// `/configuracoes/`): `next.config.ts` também redireciona as listas antigas de tabelas para `/artefatos` (phase 14, A31), e esses redirects são provados em `shell/mobile-nav.test.ts`.
import { describe, expect, it } from 'vitest';
import config from '../../../next.config';
import { NAV_SECTIONS } from '../shell/nav-config';
import { SETTINGS_AREAS } from './settings-areas';

describe('áreas de Configurações', () => {
  it('são 6, com endereço `/configuracoes/<id>` único e a ordem do design', () => {
    expect(SETTINGS_AREAS.map((area) => area.label)).toEqual(['Conexões', 'Preferências', 'Personalização', 'Notificações', 'Atividade e arquivos', 'Conta e segurança']);
    for (const area of SETTINGS_AREAS) expect(area.href).toBe(`/configuracoes/${area.id}`);
    expect(new Set(SETTINGS_AREAS.map((area) => area.href)).size).toBe(6);
  });

  it('o painel do desktop e o ícone da barra levam às mesmas áreas, o ícone ao índice', () => {
    const settings = NAV_SECTIONS.find((section) => section.id === 'configuracoes')!;
    expect(settings.href).toBe('/configuracoes');
    expect(settings.panel?.links).toEqual(SETTINGS_AREAS.map(({ href, label }) => ({ href, label })));
  });
});

describe('redirecionamento das rotas antigas de Configurações', () => {
  it('as 9 rotas antigas vão, de forma permanente, para uma das 6 áreas (a query string segue por conta do Next)', async () => {
    // Só os redirects de Configurações: os das listas antigas de tabelas (destino `/artefatos`) têm prova própria em `mobile-nav.test.ts`.
    const redirects = ((await config.redirects?.()) ?? []).filter((redirect) => redirect.destination.startsWith('/configuracoes/'));
    const bySource = Object.fromEntries(redirects.map((redirect) => [redirect.source, redirect]));
    const expected: Record<string, string> = {
      provedores: 'conexoes',
      conectores: 'conexoes',
      'pesquisa-na-web': 'conexoes',
      python: 'conexoes',
      'chat-geral': 'preferencias',
      'idioma-e-fuso': 'preferencias',
      'regras-globais': 'personalizacao',
      atividades: 'atividade-e-arquivos',
      conta: 'conta-e-seguranca',
    };
    expect(redirects).toHaveLength(Object.keys(expected).length);
    for (const [old, area] of Object.entries(expected)) {
      expect(bySource[`/configuracoes/${old}`], old).toMatchObject({ destination: `/configuracoes/${area}`, permanent: true });
    }
    const areaHrefs = new Set(SETTINGS_AREAS.map((area) => area.href as string));
    for (const redirect of redirects) {
      expect(areaHrefs.has(redirect.destination), redirect.destination).toBe(true); // nunca para outra rota antiga
      expect(areaHrefs.has(redirect.source), redirect.source).toBe(false); // nunca captura uma área nova
    }
    expect(redirects.some((redirect) => redirect.source === '/configuracoes/arquivos')).toBe(false); // a lista de arquivos continua existindo
  });
});
