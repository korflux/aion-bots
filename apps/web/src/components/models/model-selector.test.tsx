// Prova das regras do seletor de modelo da phase 17 (UI-05; A9, A21, A23, A25 a A28) sem tela: como a lista do servidor vira Favoritos, Recentes e um grupo por provedor, o que a busca e o chip
// filtram, o que o modelo oculto e o indisponível fazem, os nomes (sem prefixo na linha, completo em Favoritos, Recentes e gatilhos) e o selo de preço (o texto dos gatilhos, `valueText`, é de `model-field.test.ts`). O desenho, o teclado, o drawer em 375 px, o
// popover em 1440 px e o axe são provados no E2E (`e2e/model-selector.spec.ts`).
import type { ModelEntry } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { summaryModelOptions } from '@/components/settings/context-preferences';
import { buildSections, chipProviders, hasEffort, hasVision, modelFullName, modelName, priceLabel, providerLabelOf } from './model-label';

const entry = (id: string, patch: Partial<ModelEntry> = {}): ModelEntry => ({ id, favorite: false, favoritedAt: null, test: null, acceptsImages: null, hidden: false, displayName: null, price: null, unavailable: null, ...patch });
const ids = (entries: readonly ModelEntry[]) => entries.map((model) => model.id);

const MODELS: ModelEntry[] = [
  entry('opencode/deepseek-v4.1-flash', { price: { input: 0.3, output: 1.2 }, favorite: true, favoritedAt: '2026-11-01T10:00:00.000Z' }),
  entry('opencode/glm-5.1'),
  entry('opencode/kimi-k2.7-code', { hidden: true }),
  entry('anthropic/claude-haiku-5-5', { displayName: 'Claude Haiku 5.5', price: { input: 0.1, output: 0.5 }, favorite: true, favoritedAt: '2026-11-02T10:00:00.000Z', acceptsImages: true }),
  entry('anthropic/claude-opus-5-5', { displayName: 'Claude Opus 5.5', price: { input: 4, output: 20 }, hidden: true }),
  entry('anthropic/claude-sonnet-5-5', { displayName: 'Claude Sonnet 5.5', price: { input: 2, output: 10 }, unavailable: 'credits_exhausted' }),
];
const RECENTS = ['anthropic/claude-sonnet-5-5', 'opencode/kimi-k2.7-code', 'opencode/glm-5.1', 'anthropic/claude-haiku-5-5', 'opencode/inexistente'];
const BASE = { query: '', provider: null, recents: RECENTS, current: null } as const;

describe('A26: as seções de "Todos"', () => {
  it('Favoritos (do mais antigo ao mais novo), Recentes (na ordem do servidor, só os que existem e não estão ocultos) e um grupo por provedor, na ordem dos provedores', () => {
    const sections = buildSections(MODELS, BASE);
    expect(ids(sections.favorites)).toEqual(['opencode/deepseek-v4.1-flash', 'anthropic/claude-haiku-5-5']);
    // O Kimi está oculto e sai das escolhas novas; o inexistente não consta na lista; o Sonnet segue, porque indisponível é selo e não filtro.
    expect(ids(sections.recents)).toEqual(['anthropic/claude-sonnet-5-5', 'opencode/glm-5.1', 'anthropic/claude-haiku-5-5']);
    expect(sections.groups.map((group) => [group.provider, ids(group.entries)])).toEqual([
      ['opencode', ['opencode/deepseek-v4.1-flash', 'opencode/glm-5.1']],
      ['anthropic', ['anthropic/claude-haiku-5-5', 'anthropic/claude-sonnet-5-5']],
    ]);
    expect(sections.results).toBeNull();
  });

  it('os recentes valem no máximo `recentLimit` (5 por padrão), do mais novo ao mais antigo', () => {
    const many = Array.from({ length: 8 }, (_, index) => entry(`opencode/m-${index}`));
    expect(buildSections(many, { ...BASE, recents: many.map((model) => model.id) }).recents).toHaveLength(5);
    expect(ids(buildSections(many, { ...BASE, recents: many.map((model) => model.id).reverse(), recentLimit: 2 }).recents)).toEqual(['opencode/m-7', 'opencode/m-6']);
  });

  it('A7 e A9: o oculto some das escolhas novas, mas a escolha atual continua na lista (com o selo "Oculto" na linha), inclusive em Recentes', () => {
    const current = buildSections(MODELS, { ...BASE, current: 'opencode/kimi-k2.7-code' });
    expect(ids(current.groups[0]!.entries)).toEqual(['opencode/deepseek-v4.1-flash', 'opencode/glm-5.1', 'opencode/kimi-k2.7-code']);
    expect(ids(current.recents)).toContain('opencode/kimi-k2.7-code');
    // Outro modelo oculto, que não é o atual, continua fora.
    expect(ids(current.groups[1]!.entries)).not.toContain('anthropic/claude-opus-5-5');
    // Reexibido pelo dono, volta como qualquer outro.
    const shown = buildSections(MODELS.map((model) => (model.id === 'anthropic/claude-opus-5-5' ? { ...model, hidden: false } : model)), BASE);
    expect(ids(shown.groups[1]!.entries)).toContain('anthropic/claude-opus-5-5');
  });

  it('A25: o chip filtra tudo por provedor (favoritos, recentes e grupos); "Todos" (nulo) não filtra', () => {
    const anthropic = buildSections(MODELS, { ...BASE, provider: 'anthropic' });
    expect(ids(anthropic.favorites)).toEqual(['anthropic/claude-haiku-5-5']);
    expect(ids(anthropic.recents)).toEqual(['anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5']);
    expect(anthropic.groups.map((group) => group.provider)).toEqual(['anthropic']);
    expect(buildSections(MODELS, { ...BASE, provider: 'opencode' }).groups.map((group) => group.provider)).toEqual(['opencode']);
  });

  it('os chips só existem com mais de um provedor na lista, na ordem Anthropic e OpenCode Go', () => {
    expect(chipProviders(MODELS)).toEqual(['anthropic', 'opencode']);
    expect(chipProviders(MODELS.filter((model) => model.id.startsWith('opencode/')))).toEqual(['opencode']);
    expect(chipProviders([])).toEqual([]);
  });
});

describe('A27: a busca', () => {
  it('acha em todos os provedores, por nome, id e nome do provedor, sem diferença de caixa, e devolve uma lista só (sem favoritos, recentes nem grupos)', () => {
    const byName = buildSections(MODELS, { ...BASE, query: 'HAIKU' });
    expect(ids(byName.results ?? [])).toEqual(['anthropic/claude-haiku-5-5']);
    expect(byName.groups).toEqual([]);
    expect(byName.favorites).toEqual([]);
    expect(ids(buildSections(MODELS, { ...BASE, query: 'glm' }).results ?? [])).toEqual(['opencode/glm-5.1']);
    // Pelo nome do provedor: todos os visíveis dele.
    expect(ids(buildSections(MODELS, { ...BASE, query: 'anthropic' }).results ?? [])).toEqual(['anthropic/claude-haiku-5-5', 'anthropic/claude-sonnet-5-5']);
    expect(ids(buildSections(MODELS, { ...BASE, query: 'opencode go' }).results ?? [])).toEqual(['opencode/deepseek-v4.1-flash', 'opencode/glm-5.1']);
    expect(buildSections(MODELS, { ...BASE, query: 'xyz' }).results).toEqual([]);
    // A busca respeita o oculto (a menos que seja o atual) e o chip.
    expect(ids(buildSections(MODELS, { ...BASE, query: 'opus' }).results ?? [])).toEqual([]);
    expect(ids(buildSections(MODELS, { ...BASE, query: 'opus', current: 'anthropic/claude-opus-5-5' }).results ?? [])).toEqual(['anthropic/claude-opus-5-5']);
    expect(ids(buildSections(MODELS, { ...BASE, query: 'claude', provider: 'opencode' }).results ?? [])).toEqual([]);
  });

  it('cada resultado mostra o provedor: o nome do provedor sai do prefixo do id', () => {
    expect(providerLabelOf('anthropic/claude-haiku-5-5')).toBe('Anthropic');
    expect(providerLabelOf('opencode/glm-5.1')).toBe('OpenCode Go');
    expect(providerLabelOf('sem-prefixo')).toBe('OpenCode Go'); // o provedor de antes da phase 17
  });
});

describe('A28: nomes', () => {
  it('a linha mostra o nome sem prefixo; Favoritos, Recentes e o gatilho mostram o nome completo, com o display_name da Anthropic', () => {
    expect(modelName(MODELS[3]!)).toBe('Claude Haiku 5.5');
    expect(modelName(MODELS[1]!)).toBe('glm-5.1');
    expect(modelFullName('anthropic/claude-haiku-5-5', MODELS[3])).toBe('anthropic/Claude Haiku 5.5');
    expect(modelFullName('opencode/glm-5.1', MODELS[1])).toBe('opencode/glm-5.1');
    // Sem a entrada (a lista não chegou) vale o id local depois do prefixo; um id sem prefixo conhecido volta como veio.
    expect(modelFullName('anthropic/claude-haiku-5-5')).toBe('anthropic/claude-haiku-5-5');
    expect(modelFullName('modelo-antigo')).toBe('modelo-antigo');
  });

});

describe('A7 e A9: o modelo do resumo', () => {
  const tested = { status: 'ok' as const, reason: null, effortLevels: [], testedAt: '2026-11-14T10:00:00.000Z' };
  const validated = (id: string, patch: Partial<ModelEntry> = {}) => entry(id, { test: tested, ...patch });

  it('a lista do resumo não oferece o modelo oculto como escolha nova, mas mantém o que já está salvo (que segue valendo)', () => {
    const models = [validated('opencode/glm-5.1'), validated('opencode/kimi-k2.7-code', { hidden: true }), validated('anthropic/claude-haiku-5-5', { hidden: true }), entry('opencode/glm-5.3-flash')];
    expect(summaryModelOptions(models)).toEqual(['opencode/glm-5.1']);
    expect(summaryModelOptions(models, 'opencode/kimi-k2.7-code')).toEqual(['opencode/glm-5.1', 'opencode/kimi-k2.7-code']);
    expect(summaryModelOptions(models, 'anthropic/claude-haiku-5-5')).toEqual(['anthropic/claude-haiku-5-5', 'opencode/glm-5.1']);
  });
});

describe('A23: selos da linha', () => {
  it('o preço segue a tabela da spec (entrada/saída por milhão de tokens) e o modelo sem preço diz "preço desconhecido"', () => {
    expect(priceLabel({ input: 0.1, output: 0.5 })).toBe('US$ 0,10/0,50');
    expect(priceLabel({ input: 2, output: 10 })).toBe('US$ 2,00/10,00');
    expect(priceLabel({ input: 4, output: 20 })).toBe('US$ 4,00/20,00');
    expect(priceLabel({ input: 0.3, output: 1.2 })).toBe('US$ 0,30/1,20');
    expect(priceLabel(null)).toBe('preço desconhecido');
    expect(priceLabel(undefined)).toBe('preço desconhecido');
  });

  it('a visão só tem selo quando comprovada, e o effort só quando o teste mostrou ao menos um nível', () => {
    expect(hasVision(entry('x', { acceptsImages: true }))).toBe(true);
    expect(hasVision(entry('x', { acceptsImages: false }))).toBe(false);
    expect(hasVision(entry('x'))).toBe(false);
    const test = (effortLevels: ('low' | 'high')[]) => ({ status: 'ok' as const, reason: null, effortLevels, testedAt: '2026-11-14T10:00:00.000Z' });
    expect(hasEffort(entry('x', { test: test(['low', 'high']) }))).toBe(true);
    expect(hasEffort(entry('x', { test: test([]) }))).toBe(false);
    expect(hasEffort(entry('x'))).toBe(false);
  });
});
