// Prova dos cartões de provedor de IA de Configurações → Conexões (phase 17, passo 5; A1 e A2 na tela): o cartão da Anthropic mostra só a versão mascarada da chave e o total de
// modelos depois de salva, o erro seguro da API quando ela recusa a chave (sem o valor digitado) e o OpenCode Go segue igual. Renderização no servidor, sem DOM, como os demais testes
// de componente da web; o clique em Salvar, a chave recusada na tela, o foco e o modal de desconectar são provados no E2E (`e2e/settings-keys.spec.ts`), e o pedido HTTP, em `credentials-api.test.ts`.
import type { CredentialStatus } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionProvider } from '@/lib/session-context';
import { ApiError } from '@/lib/api-client';
import { credentialErrorMessage } from './credentials-api';
import { AnthropicSettings, ProviderCard, ProviderSettings, type CredentialState } from './provider-settings';

const SESSION = { owner: { email: 'dono@example.com' }, sessionId: '0b6d4b8e-7d63-4a54-9f55-3a2a0c1e0002', csrfToken: 'csrf' };
const NEVER_RENDERED_KEY = 'sk-ant-chave-que-o-dono-digitou-WXYZ7777';

const status = (patch: Partial<CredentialStatus> = {}): CredentialStatus => ({ kind: 'anthropic', configured: false, masked: null, updatedAt: null, modelCount: null, ...patch });
const state = (patch: Partial<CredentialState> = {}): CredentialState => ({ status: status(), error: null, setStatus: () => undefined, reload: () => undefined, ...patch });

const render = (cardState: CredentialState): string =>
  renderToStaticMarkup(
    <SessionProvider session={SESSION}>
      <ProviderCard
        headingId="provedor-anthropic"
        title="Provedor de IA · Anthropic"
        description="Opcional."
        kind="anthropic"
        serviceName="Anthropic"
        disconnectEffect="Os modelos Claude deixam de rodar."
        state={cardState}
      />
    </SessionProvider>,
  );

describe('A1: cartão da Anthropic com a chave salva', () => {
  it('mostra só a versão mascarada, o selo e o total de modelos; nunca a chave nem um campo para ela', () => {
    const html = render(state({ status: status({ configured: true, masked: '••••7777', modelCount: 7, updatedAt: '2026-11-13T12:00:00.000Z' }) }));
    expect(html).toContain('••••7777');
    expect(html).toContain('7 modelos disponíveis');
    expect(html).toContain('Conectado');
    expect(html).toContain('>Substituir<');
    expect(html).toContain('>Desconectar<');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain(NEVER_RENDERED_KEY);
    expect(html).not.toContain('sk-ant');
    // O título nomeia a seção para quem usa leitor de tela.
    expect(html).toMatch(/<section[^>]*aria-labelledby="provedor-anthropic"/);
    expect(html).toContain('Provedor de IA · Anthropic');
  });

  it('com um modelo só, usa o singular', () => {
    expect(render(state({ status: status({ configured: true, masked: '••••7777', modelCount: 1 }) }))).toContain('1 modelo disponível');
  });

  it('sem a chave: campo de senha sem preenchimento automático e "Salvar" (sem total de modelos)', () => {
    const html = render(state());
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('>Salvar<');
    expect(html).not.toContain('modelos disponíveis');
    expect(html).not.toContain('••••');
  });
});

describe('A2: cartão da Anthropic quando a leitura ou a prova falha', () => {
  it('mostra o erro seguro da API, "Tentar novamente" e nenhum campo; o texto é o que a API devolve, sem a chave', () => {
    const message = credentialErrorMessage(new ApiError(422, 'PROVIDER_KEY_INVALID', 'Chave recusada pelo provedor.'));
    expect(message).toBe('Chave recusada pelo provedor.');
    const html = render(state({ status: null, error: message }));
    expect(html).toMatch(/<p[^>]*role="alert"[^>]*>Chave recusada pelo provedor\.<\/p>/);
    expect(html).toContain('Tentar novamente');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain(NEVER_RENDERED_KEY);
  });

  it('um erro que não é da API vira a frase genérica, nunca o texto interno', () => {
    expect(credentialErrorMessage(new Error(`falha com ${NEVER_RENDERED_KEY}`))).toBe('Não foi possível concluir. Tente novamente.');
  });

  it('enquanto a leitura está em curso, o cartão mostra o esqueleto de carregamento', () => {
    expect(render(state({ status: null }))).toContain('aria-busy="true"');
  });
});

describe('os dois cartões da área Conexões', () => {
  it('o OpenCode Go e a Anthropic têm título próprio e a Anthropic é descrita como opcional', () => {
    const html = renderToStaticMarkup(
      <SessionProvider session={SESSION}>
        <ProviderSettings />
        <AnthropicSettings />
      </SessionProvider>,
    );
    expect(html.indexOf('Provedor de IA · OpenCode Go')).toBeGreaterThan(-1);
    expect(html.indexOf('Provedor de IA · Anthropic')).toBeGreaterThan(html.indexOf('Provedor de IA · OpenCode Go'));
    expect(html).toContain('Opcional: libera os modelos Claude.');
  });
});
