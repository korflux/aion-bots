// Prova da seção "Contas do conector" do editor do bot (phase 13, A13): as contas do Composio liberadas ao bot aparecem SÓ PARA LEITURA (nome ou rótulo, app, estado), sem
// nenhum controle de edição, com o caminho para Configurações → Conexões, que é a única tela onde a liberação se edita (decisão 7). Os estados da carga (carregando, vazio, erro
// seguro, Composio não conectado) vêm da mesma visão, e o "não conectado" chega como 200 `configured: false` da API (`botAccountsLoadOf`), nunca como erro. Renderização no servidor, sem DOM, como os demais testes de componente da web: o componente com busca só renderiza o
// "carregando" no servidor, então o conteúdo é provado pela visão pura (`BotConnectorAccountsView`), que ele alimenta.
import type { BotConnectorAccounts } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotConnectorAccountsView, botAccountsLoadOf, type BotAccountsLoad } from './bot-connector-accounts';

type Account = BotConnectorAccounts['accounts'][number];

const PESSOAL: Account = { id: 'ca_1', appSlug: 'gmail', appName: 'Gmail', name: 'Pessoal', label: 'Pessoal', status: 'active' };
const AUTOMATICA: Account = { id: 'ca_3', appSlug: 'github', appName: 'GitHub', name: null, label: 'GitHub · ca_…3', status: 'active' };

const render = (load: BotAccountsLoad): string => renderToStaticMarkup(<BotConnectorAccountsView load={load} onRetry={() => undefined} />);
const ready = (...accounts: Account[]): BotAccountsLoad => ({ status: 'ready', accounts });

/** Todo elemento que o dono poderia usar para alterar algo: botão, campo, seleção, caixa de marcação ou formulário. */
const EDIT_CONTROLS = /<(button|input|select|textarea|form)\b|role="(checkbox|switch|radio|combobox|textbox)"/;

describe('seção Contas do conector no editor do bot', () => {
  it('mostra as contas liberadas só para leitura, sem controle de edição (A13)', () => {
    const html = render(ready(PESSOAL, AUTOMATICA));
    // O nome dado pelo dono, com o app dele; sem nome, o rótulo automático (que já traz o app).
    expect(html).toContain('Pessoal');
    expect(html).toContain('Gmail');
    expect(html).toContain('GitHub · ca_…3');
    expect(html.match(/<li\b/g)).toHaveLength(2);
    expect(html).not.toMatch(EDIT_CONTROLS);
  });

  it('aponta Configurações → Conexões como o lugar de liberar e revogar', () => {
    for (const load of [ready(PESSOAL), ready(), { status: 'loading' } as const]) {
      const html = render(load);
      expect(html, load.status).toMatch(/<a [^>]*href="\/configuracoes\/conexoes"[^>]*>Configurações → Conexões<\/a>/);
    }
  });

  it('diz o estado de cada conta em texto, inclusive a conta que sumiu do Composio, que segue liberada e é recusada na execução', () => {
    const html = render(
      ready(
        PESSOAL,
        { ...AUTOMATICA, status: 'pending' },
        { id: 'ca_9', appSlug: 'slack', appName: 'Slack', name: 'Equipe', label: 'Equipe', status: 'attention' },
        { id: 'ca_7', appSlug: 'gmail', appName: 'Gmail', name: 'Antiga', label: 'Antiga', status: 'disconnected' },
      ),
    );
    for (const text of ['Ativa', 'Pendente', 'Requer atenção', 'Desconectada']) expect(html, text).toContain(`>${text}</span>`);
    expect(html).toContain('Antiga');
  });

  it('sem conta liberada diz que nenhuma está liberada e que o bot fica sem o Composio', () => {
    const html = render(ready());
    expect(html).toContain('Nenhuma conta liberada a este bot.');
    expect(html).not.toContain('<ul');
    expect(html).not.toMatch(EDIT_CONTROLS);
  });

  it('carregando anuncia o estado a leitores de tela, sem lista', () => {
    const html = render({ status: 'loading' });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Carregando contas do bot');
    expect(html).not.toContain('<ul');
  });

  it('erro mostra só a mensagem segura da API e oferece tentar de novo, sem expor detalhe', () => {
    const html = render({ status: 'error', message: 'Composio indisponível. Tente novamente.' });
    expect(html).toContain('Composio indisponível. Tente novamente.');
    expect(html).toContain('Tentar novamente');
    expect(html).not.toContain('<ul');
  });

  it('Composio ainda não conectado não é erro: orienta a conectar e não oferece nova tentativa', () => {
    const html = render({ status: 'not-configured' });
    expect(html).toContain('Conecte o Composio');
    expect(html).not.toContain('Tentar novamente');
    expect(html).not.toMatch(EDIT_CONTROLS);
  });
});

describe('estado da carga a partir da resposta 200 da API', () => {
  it('configured: false vira "não conectado" (orientação), e não "sem conta liberada"', () => {
    const load = botAccountsLoadOf({ configured: false, accounts: [] });
    expect(load).toEqual({ status: 'not-configured' });
    expect(render(load)).toContain('Conecte o Composio');
    expect(render(load)).not.toContain('Nenhuma conta liberada');
  });

  it('configured: true entrega as contas, inclusive a lista vazia, que diz que nenhuma está liberada', () => {
    expect(botAccountsLoadOf({ configured: true, accounts: [PESSOAL] })).toEqual({ status: 'ready', accounts: [PESSOAL] });
    const empty = botAccountsLoadOf({ configured: true, accounts: [] });
    expect(empty).toEqual({ status: 'ready', accounts: [] });
    expect(render(empty)).toContain('Nenhuma conta liberada a este bot.');
    expect(render(empty)).not.toContain('Conecte o Composio');
  });
});
