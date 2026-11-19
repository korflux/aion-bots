// Prova do mapa da navegação do celular (phase 5, T6; spec A5 e A6, Suposição 6): quais caminhos são telas de aba (as únicas com barra inferior) e para onde "Voltar" leva em
// cada tela que não é de aba. O pai é fixo, calculado só do caminho: vale igual com a tela aberta por push, atalho do ícone ou link digitado. Função pura, sem navegador; o
// comportamento renderizado (barra, selo, teclado e cabeçalhos) é provado no E2E em 375 e 320 px. Também guarda os redirects das listas antigas de tabelas para Artefatos
// (phase 14, A31), que vivem em `next.config.ts`: o arquivo roda em node, onde o config carrega; o 308 e a query string no HTTP são do E2E.
import { describe, expect, it } from 'vitest';
import nextConfig from '../../../next.config';
import { sectionForPath } from './nav-config';
import { TAB_ROUTES, backHrefFor, tabForPath } from './mobile-nav';

const BOT = '3f0e6c2e-8b1f-4c53-9d0e-6a5f2d7b9c11';
const SESSION = '7a1d2b9c-4e55-4f0a-8c3b-1d9e6f0a2b34';
const ROUTINE = 'c4b8e1f0-2d36-4a7b-9e51-0f3a6d8c5e72';
const TABLE = '9d2c4f6a-1b3e-4d5f-8a7c-6e0b2d4f8a13';
const DOC = '2c9d1a3e-6f1b-4d5a-9a53-0a6f0a1b2c3d';

describe('telas de aba', () => {
  it('são quatro, na ordem da barra: Início, Chats, Rotinas e Aprovações', () => {
    expect(TAB_ROUTES.map((tab) => [tab.id, tab.href])).toEqual([
      ['inicio', '/'],
      ['chats', '/chats'],
      ['rotinas', '/rotinas'],
      ['aprovacoes', '/aprovacoes'],
    ]);
  });

  it('cada aba é a rota exata; nenhuma outra tela tem barra', () => {
    for (const tab of TAB_ROUTES) expect(tabForPath(tab.href)).toBe(tab.id);
    const sem = [
      `/bots/${BOT}`,
      `/bots/${BOT}/editar`,
      '/bots/novo',
      '/bots',
      '/chat',
      `/chat/${SESSION}`,
      '/rotinas/nova',
      `/rotinas/${ROUTINE}`,
      `/rotinas/${ROUTINE}/historico`,
      '/configuracoes',
      '/configuracoes/preferencias',
      '/configuracoes/arquivos',
      '/nao-existe',
    ];
    for (const path of sem) expect(tabForPath(path), path).toBeNull();
  });

  it('as abas não têm "Voltar"', () => {
    for (const tab of TAB_ROUTES) expect(backHrefFor(tab.href), tab.href).toBeNull();
  });
});

describe('"Voltar" leva ao pai fixo (Suposição 6)', () => {
  it('a área Artefatos volta ao Início e as páginas de tabela e de doc voltam a ela, sem aba inferior (A3)', () => {
    const paths = ['/artefatos', `/artefatos/tabelas/${TABLE}`, `/artefatos/docs/${DOC}`];
    expect(paths.map(backHrefFor)).toEqual(['/', '/artefatos', '/artefatos']);
    for (const path of paths) expect(tabForPath(path), path).toBeNull();
  });

  it('as páginas próprias antigas da tabela (por bot e em Configurações) também voltam a Artefatos (A31)', () => {
    const paths = [`/bots/${BOT}/tabelas/${TABLE}`, `/configuracoes/tabelas/${TABLE}`];
    expect(paths.map(backHrefFor)).toEqual(['/artefatos', '/artefatos']);
    for (const path of paths) expect(tabForPath(path), path).toBeNull();
  });

  it('a lista antiga de tabelas do bot já não tem tela (redirecionada a Artefatos) e saiu do mapa', () => {
    expect(backHrefFor(`/bots/${BOT}/tabelas`)).toBeNull();
  });

  it('o mapa não casa caminhos parecidos com Artefatos', () => {
    for (const path of ['/artefatos/', '/artefatos/outra-coisa', `/artefatos/tabelas/${TABLE}/extra`, `/artefatos/docs`]) expect(backHrefFor(path), path).toBeNull();
  });
  it('conversa do bot, editor de bot (editar e criar) e a seção Bots voltam ao Início', () => {
    expect(backHrefFor(`/bots/${BOT}`)).toBe('/');
    expect(backHrefFor(`/bots/${BOT}/editar`)).toBe('/');
    expect(backHrefFor('/bots/novo')).toBe('/');
    expect(backHrefFor('/bots')).toBe('/');
  });

  it('sessão do Chat geral volta a Chats (e a abertura de /chat também)', () => {
    expect(backHrefFor(`/chat/${SESSION}`)).toBe('/chats');
    expect(backHrefFor('/chat')).toBe('/chats');
  });

  it('editor de rotina (nova e existente) e histórico voltam a Rotinas', () => {
    expect(backHrefFor('/rotinas/nova')).toBe('/rotinas');
    expect(backHrefFor(`/rotinas/${ROUTINE}`)).toBe('/rotinas');
    expect(backHrefFor(`/rotinas/${ROUTINE}/historico`)).toBe('/rotinas');
  });

  it('cada área de Configurações volta ao índice, e o índice volta ao Início', () => {
    for (const area of ['conexoes', 'preferencias', 'personalizacao', 'notificacoes', 'atividade-e-arquivos', 'conta-e-seguranca']) {
      expect(backHrefFor(`/configuracoes/${area}`), area).toBe('/configuracoes');
    }
    expect(backHrefFor('/configuracoes')).toBe('/');
  });

  it('a lista de arquivos volta a Atividade e arquivos, e a memória e os arquivos de um bot voltam à conversa dele', () => {
    expect(backHrefFor('/configuracoes/arquivos')).toBe('/configuracoes/atividade-e-arquivos');
    expect(backHrefFor(`/bots/${BOT}/memoria`)).toBe(`/bots/${BOT}`);
    expect(backHrefFor(`/bots/${BOT}/arquivos`)).toBe(`/bots/${BOT}`);
  });

  it('caminho fora do mapa não tem pai (a tela de erro leva ao Início por conta própria)', () => {
    for (const path of ['/nao-existe', `/bots/${BOT}/outra-coisa`, '/chats/extra', '/rotinas/']) expect(backHrefFor(path), path).toBeNull();
  });
});

describe('listas antigas de tabelas redirecionam para a área Artefatos (A31)', () => {
  const redirects = async () => (await nextConfig.redirects?.()) ?? [];

  it('a lista por bot e a de Configurações levam, de forma permanente (308), a /artefatos', async () => {
    for (const source of ['/bots/:id/tabelas', '/configuracoes/tabelas']) {
      expect((await redirects()).find((item) => item.source === source), source).toMatchObject({ destination: '/artefatos', permanent: true });
    }
  });

  it('não redireciona as páginas próprias de tabela, que continuam, nem desfaz os redirects de Configurações de antes da phase 5', async () => {
    const all = await redirects();
    expect(all.filter((item) => /tabelas\/:/.test(item.source))).toEqual([]);
    expect(all.find((item) => item.source === '/configuracoes/conta')).toMatchObject({ destination: '/configuracoes/conta-e-seguranca', permanent: true });
  });
});

describe('seção do desktop para as rotas novas', () => {
  it('/chats é da seção Chat geral (a lista abre com o painel de sessões ao lado)', () => {
    expect(sectionForPath('/chats')?.id).toBe('chat');
    expect(sectionForPath('/chat')?.id).toBe('chat');
    expect(sectionForPath(`/chat/${SESSION}`)?.id).toBe('chat');
  });

  it('Início não pertence a nenhuma seção (sem painel)', () => {
    expect(sectionForPath('/')).toBeNull();
  });
});
