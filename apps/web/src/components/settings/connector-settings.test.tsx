// Prova da linha de conta de Configurações → Conexões (phase 13, R8): "Remover" existe SÓ na conta desconectada (a que o Composio não lista mais) e a confirmação não aparece antes
// do clique. Renderização no servidor, sem DOM, como os demais testes de componente da web; o clique, a confirmação, o foco e a lista depois da remoção são provados no E2E
// (`e2e/settings-keys.spec.ts`), e o pedido HTTP, em `credentials-api.test.ts`.
import type { ConnectorAccountStatus, ConnectorAccountView } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionProvider } from '@/lib/session-context';
import { AccountRow } from './connector-settings';

const SESSION = { owner: { email: 'dono@example.com' }, sessionId: '0b6d4b8e-7d63-4a54-9f55-3a2a0c1e0002', csrfToken: 'csrf' };
const BOT_ID = '64c4da7d-9c2b-455f-a270-8a2399d6f498';

const account = (status: ConnectorAccountStatus, patch: Partial<ConnectorAccountView> = {}): ConnectorAccountView => ({
  id: 'ca_1',
  appSlug: 'gmail',
  appName: 'Gmail',
  name: 'Pessoal',
  label: 'Pessoal',
  status,
  botIds: [],
  version: 3,
  ...patch,
});

const render = (view: ConnectorAccountView): string =>
  renderToStaticMarkup(
    <SessionProvider session={SESSION}>
      <ul>
        <AccountRow account={view} bots={{ status: 'ready', bots: [] }} onSaved={() => undefined} onStale={() => undefined} onRemoved={() => undefined} />
      </ul>
    </SessionProvider>,
  );

describe('Remover na linha da conta (R8)', () => {
  it('só a conta desconectada tem "Remover", com o nome da conta no nome acessível', () => {
    const html = render(account('disconnected'));
    expect(html).toMatch(/<button [^>]*aria-label="Remover Pessoal"[^>]*>Remover<\/button>/);
    // Renomear e Escolher bots continuam na conta desconectada (ela mantém nome e liberações).
    expect(html).toContain('aria-label="Renomear Pessoal"');
    expect(html).toContain('aria-label="Escolher bots de Pessoal"');
  });

  it('a conta ativa, pendente ou que requer atenção não tem "Remover" (o Composio ainda a lista e o servidor também a recusaria)', () => {
    for (const status of ['active', 'pending', 'attention'] as const) {
      const html = render(account(status));
      expect(html, status).not.toContain('Remover');
      expect(html, status).toContain('aria-label="Renomear Pessoal"');
    }
  });

  it('a confirmação só abre no clique: a linha renderizada não traz o diálogo nem erro de remoção, e a desconectada explica por que pode ser removida', () => {
    const html = render(account('disconnected', { botIds: [BOT_ID] }));
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('O Composio não lista mais esta conta.');
    expect(html).toContain('Reconectar o app no Composio cria outra conta, então esta pode ser removida.');
  });
});
