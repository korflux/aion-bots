// Contrato das janelas de contexto (phase 11, F8): a lista de opções, o padrão, a allowlist da borda e a janela efetiva
// (menor entre a escolhida e a capacidade confirmada do modelo EXATO). Só funções puras; o banco e as rotas têm suas provas no core e na API.
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_WINDOW_PRESETS,
  DEFAULT_CONTEXT_WINDOW,
  contextPreferenceUpdateSchema,
  contextPreferencesSchema,
  contextWindowLabel,
  contextWindowTokensSchema,
  modelContextCapacitySchema,
  resolveContextWindow,
} from './context-window';

/** Capacidade de teste de uma identidade exata (o provedor é fixo, o resto varia por caso). */
const capacity = (model: string, contextTokens: number) =>
  modelContextCapacitySchema.parse({ provider: 'opencode_go', model, contextTokens, outputTokens: 131072, source: 'https://exemplo.test/modelo', checkedAt: '2026-10-17T00:00:00.000Z' });

describe('opções de janela', () => {
  it('são 64k, 128k, 256k e 512k, com padrão 256k, e a allowlist aceita só esses quatro valores', () => {
    expect([...CONTEXT_WINDOW_PRESETS]).toEqual([65536, 131072, 262144, 524288]);
    expect(CONTEXT_WINDOW_PRESETS.map(contextWindowLabel)).toEqual(['64k', '128k', '256k', '512k']);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(262144);
    expect(CONTEXT_WINDOW_PRESETS).toContain(DEFAULT_CONTEXT_WINDOW);
    for (const tokens of CONTEXT_WINDOW_PRESETS) expect(contextWindowTokensSchema.parse(tokens)).toBe(tokens);
    // 32k saiu das opções; texto, fracionário, vizinhos dos presets e valores absurdos nunca passam.
    for (const refused of [32768, '65536', 65536.5, 65535, 524289, 1048576, 0, -1, null, true, {}]) {
      expect(contextWindowTokensSchema.safeParse(refused).success, String(refused)).toBe(false);
    }
  });

  it('a preferência global e a atualização por escopo refletem a mesma allowlist (32k recusado, corpo estrito)', () => {
    expect(contextPreferencesSchema.safeParse({ bots: 262144, generalChat: 524288 }).success).toBe(true);
    expect(contextPreferencesSchema.safeParse({ bots: 32768, generalChat: 262144 }).success).toBe(false);
    for (const scope of ['bots', 'general_chat'] as const) {
      expect(contextPreferenceUpdateSchema.safeParse({ scope, windowTokens: 524288 }).success).toBe(true);
      expect(contextPreferenceUpdateSchema.safeParse({ scope, windowTokens: 32768 }).success).toBe(false);
      expect(contextPreferenceUpdateSchema.safeParse({ scope, windowTokens: 262144, extra: 1 }).success).toBe(false);
    }
  });
});

describe('janela efetiva', () => {
  it('é a menor entre a escolhida e a capacidade confirmada do modelo exato, inclusive o MiMo V2.6 Pro de 1M', () => {
    const mimo = capacity('opencode/mimo-v2.6-pro', 1000000);
    // Capacidade maior que a escolhida: vale a escolha, em cada preset (512k cabe nos 1M do MiMo).
    for (const preferred of CONTEXT_WINDOW_PRESETS) {
      expect(resolveContextWindow(preferred, 'bot', mimo.model, mimo)).toMatchObject({ preferredTokens: preferred, effectiveTokens: preferred, origin: 'bot', capacity: mimo });
    }
    // Capacidade menor que a escolhida limita sem apagar a preferência.
    const small = capacity('modelo-pequeno', 100000);
    expect(resolveContextWindow(524288, 'global', small.model, small)).toMatchObject({ preferredTokens: 524288, effectiveTokens: 100000 });
    expect(resolveContextWindow(65536, 'global', small.model, small)).toMatchObject({ effectiveTokens: 65536 });
  });

  it('sem capacidade do modelo exato vale a escolhida; sem modelo não há janela efetiva', () => {
    const known = capacity('conhecido', 100000);
    for (const preferred of CONTEXT_WINDOW_PRESETS) {
      expect(resolveContextWindow(preferred, 'global', 'outro', null)).toMatchObject({ capacity: null, effectiveTokens: preferred });
      // A capacidade de outra identidade não vale (nada de teto por família ou aproximação).
      expect(resolveContextWindow(preferred, 'global', 'outro', known)).toMatchObject({ capacity: null, effectiveTokens: preferred });
      expect(resolveContextWindow(preferred, 'global', null, known)).toMatchObject({ capacity: null, effectiveTokens: null });
    }
  });

  it('o rótulo de um limite que não é preset aparece por extenso, sem arredondar', () => {
    expect(contextWindowLabel(32768)).toBe('32.768');
    expect(contextWindowLabel(100000)).toBe('100.000');
  });
});
