// Prova da curadoria de modelos em Conexões (phase 17, passo 10; A7 e A8 na tela): o filtro por provedor e por busca, a seção recolhida com o contador e o total de ocultos, e a lista aberta com
// um interruptor "Visível" ou "Oculto" por modelo (nome do provedor na Anthropic, id local no OpenCode Go). Renderização no servidor, sem DOM, como os demais testes de componente da web; o clique
// no interruptor, a gravação, a persistência depois de recarregar e o efeito no seletor são provados no E2E (`e2e/settings-keys.spec.ts`).
import type { CredentialStatus, ModelEntry } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionProvider } from '@/lib/session-context';
import { ProviderCard } from './provider-settings';
import { modelName } from '@/components/models/model-label';
import { ProviderModelsView, providerModels, type ProviderModelsViewProps } from './provider-models';

const SESSION = { owner: { email: 'dono@example.com' }, sessionId: '0b6d4b8e-7d63-4a54-9f55-3a2a0c1e0003', csrfToken: 'csrf' };

const entry = (id: string, patch: Partial<ModelEntry> = {}): ModelEntry => ({ id, favorite: false, favoritedAt: null, test: null, acceptsImages: null, hidden: false, displayName: null, price: null, ...patch });
const MODELS: ModelEntry[] = [
  entry('opencode/glm-5.1'),
  entry('opencode/deepseek-v4.1-flash'),
  entry('anthropic/claude-haiku-5-5', { displayName: 'Claude Haiku 5.5' }),
  entry('anthropic/claude-opus-5-5', { displayName: 'Claude Opus 5.5', hidden: true }),
  entry('anthropic/claude-haiku-4-5', { displayName: 'Claude Haiku 4.5' }),
];

describe('providerModels: o filtro da lista de um provedor', () => {
  it('só os modelos do provedor, na ordem recebida; a busca vale para o nome, o id local e o id completo, sem diferença de caixa', () => {
    expect(providerModels(MODELS, 'anthropic', '').map((model) => model.id)).toEqual(['anthropic/claude-haiku-5-5', 'anthropic/claude-opus-5-5', 'anthropic/claude-haiku-4-5']);
    expect(providerModels(MODELS, 'opencode', '').map((model) => model.id)).toEqual(['opencode/glm-5.1', 'opencode/deepseek-v4.1-flash']);
    expect(providerModels(MODELS, 'anthropic', 'HAIKU').map((model) => model.id)).toEqual(['anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-4-5']);
    expect(providerModels(MODELS, 'anthropic', '5.5').map((model) => model.id)).toEqual(['anthropic/claude-haiku-5-5', 'anthropic/claude-opus-5-5']); // pelo nome, que tem o ponto
    expect(providerModels(MODELS, 'anthropic', 'claude-opus-5-5').map((model) => model.id)).toEqual(['anthropic/claude-opus-5-5']); // pelo id local
    expect(providerModels(MODELS, 'opencode', '  glm ').map((model) => model.id)).toEqual(['opencode/glm-5.1']); // espaços nas pontas não contam
    expect(providerModels(MODELS, 'opencode', 'claude')).toEqual([]); // o modelo de outro provedor não aparece mesmo casando
  });

  it('o nome mostrado é o do provedor quando existe, ou o id local', () => {
    expect(modelName(MODELS[2]!)).toBe('Claude Haiku 5.5');
    expect(modelName(MODELS[0]!)).toBe('glm-5.1');
  });
});

const view = (patch: Partial<ProviderModelsViewProps> = {}): string => {
  const models = providerModels(MODELS, 'anthropic', '');
  return renderToStaticMarkup(
    <ProviderModelsView serviceName="Anthropic" models={models} shown={models} query="" onQuery={() => undefined} open={false} onToggleOpen={() => undefined} busyId={null} onToggle={() => undefined} {...patch} />,
  );
};

describe('ProviderModelsView: a seção de modelos do cartão', () => {
  it('recolhida mostra o contador e quantos estão ocultos, com o botão que a abre, e nenhuma lista', () => {
    const html = view();
    expect(html).toContain('Modelos (3)');
    expect(html).toContain('1 oculto');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/);
    expect(html).not.toContain('<ul');
    expect(html).not.toContain('role="switch"');
    expect(view({ models: providerModels(MODELS, 'opencode', ''), shown: [] })).not.toContain('oculto'); // nenhum oculto: sem o sufixo
  });

  it('aberta lista cada modelo com o nome, o id local (só quando há nome do provedor) e um interruptor com o estado em texto e em aria-checked', () => {
    const html = view({ open: true });
    expect(html).toMatch(/<button[^>]*aria-expanded="true"/);
    expect(html).toContain('aria-label="Modelos de Anthropic"');
    expect(html).toContain('Claude Haiku 5.5');
    expect(html).toContain('>claude-haiku-5-5<'); // o id local em mono sob o nome
    // Haiku 5.5 e 4.5 visíveis; Opus 5.5 oculto: o texto e o `aria-checked` dizem o mesmo.
    const switches = [...html.matchAll(/<button[^>]*role="switch"[^>]*aria-checked="(true|false)"[^>]*aria-label="([^"]+)"/g)].map((match) => [match[2], match[1]]);
    expect(switches).toEqual([
      ['Mostrar Claude Haiku 5.5 ao escolher um modelo', 'true'],
      ['Mostrar Claude Opus 5.5 ao escolher um modelo', 'false'],
      ['Mostrar Claude Haiku 4.5 ao escolher um modelo', 'true'],
    ]);
    expect(html.match(/>Visível</g)).toHaveLength(2);
    expect(html.match(/>Oculto</g)).toHaveLength(1);
    expect(html).toContain('type="search"');
    expect(html).toContain('Buscar modelo');
  });

  it('o OpenCode Go mostra só o id local, sem a linha repetida, e o interruptor ocupado fica marcado para o leitor de tela', () => {
    const models = providerModels(MODELS, 'opencode', '');
    const html = view({ serviceName: 'OpenCode Go', models, shown: models, open: true, busyId: 'opencode/glm-5.1' });
    expect(html).toContain('>glm-5.1<');
    expect(html).not.toContain('font-mono');
    expect(html).toMatch(/aria-busy="true"[^>]*aria-disabled="true"[^>]*aria-label="Mostrar glm-5.1 ao escolher um modelo"|aria-label="Mostrar glm-5.1 ao escolher um modelo"[^>]*aria-busy="true"/);
    expect(html.match(/aria-busy="true"/g)).toHaveLength(1); // só o interruptor que está gravando
  });

  it('uma busca sem resultado diz que nenhum modelo foi encontrado, em vez de uma lista vazia', () => {
    const html = view({ open: true, shown: [], query: 'xyz' });
    expect(html).toContain('Nenhum modelo encontrado');
    expect(html).not.toContain('<ul');
  });
});

describe('o cartão do provedor com a curadoria', () => {
  const status = (configured: boolean): CredentialStatus => ({ kind: 'anthropic', configured, masked: configured ? '••••7777' : null, updatedAt: configured ? '2026-11-14T12:00:00.000Z' : null, modelCount: configured ? 8 : null });
  const card = (configured: boolean, modelProvider?: 'anthropic'): string =>
    renderToStaticMarkup(
      <SessionProvider session={SESSION}>
        <ProviderCard
          headingId="provedor-anthropic"
          title="Provedor de IA · Anthropic"
          description="Opcional."
          kind="anthropic"
          serviceName="Anthropic"
          disconnectEffect="Os modelos Claude deixam de rodar."
          state={{ status: status(configured), error: null, setStatus: () => undefined, reload: () => undefined }}
          {...(modelProvider ? { modelProvider } : {})}
        />
      </SessionProvider>,
    );

  it('com a chave salva a seção de modelos entra no cartão (carregando enquanto a lista não chega); sem a chave, ou sem o provedor informado, não existe', () => {
    expect(card(true, 'anthropic')).toContain('Carregando modelos de Anthropic');
    expect(card(false, 'anthropic')).not.toContain('modelos de Anthropic');
    expect(card(true)).not.toContain('modelos de Anthropic');
  });
});
