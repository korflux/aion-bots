// Prova do texto do botão "Modelo padrão" (phase 17): o gatilho mostra o NOME COMPLETO `provedor/nome` (A28; passo 3 mostrava o id local e o passo 11 o trocou pelo critério), com o nome do
// provedor da Anthropic e a marca "(oculto)" quando a entrada do modelo as traz. O texto é função pura do modelo, do effort e da entrada, então se prova sem DOM.
import { describe, expect, it } from 'vitest';
import { valueText } from './model-field';

describe('texto do campo Modelo padrão', () => {
  it('mostra o nome completo do modelo, com o effort quando há um', () => {
    expect(valueText('opencode/glm-5.1', null, false)).toBe('opencode/glm-5.1');
    expect(valueText('opencode/glm-5.1', 'high', false)).toBe('opencode/glm-5.1 · Alto');
    // Sem a entrada (a lista ainda não chegou) o nome é o id local depois do prefixo.
    expect(valueText('anthropic/claude-haiku-5-5', 'medium', true)).toBe('anthropic/claude-haiku-5-5 · Médio');
  });

  it('com a entrada do modelo, a Anthropic mostra o nome do provedor e o oculto ganha a marca, antes do effort', () => {
    expect(valueText('anthropic/claude-haiku-5-5', 'medium', true, { displayName: 'Claude Haiku 5.5', hidden: false })).toBe('anthropic/Claude Haiku 5.5 · Médio');
    expect(valueText('anthropic/claude-opus-5-5', null, false, { displayName: 'Claude Opus 5.5', hidden: true })).toBe('anthropic/Claude Opus 5.5 (oculto)');
    expect(valueText('opencode/kimi-k2.7-code', 'low', true, { displayName: null, hidden: true })).toBe('opencode/kimi-k2.7-code (oculto) · Baixo');
  });

  it('um id sem provedor conhecido aparece como veio, e sem modelo vale o texto de cada modo', () => {
    expect(valueText('modelo-antigo', null, false)).toBe('modelo-antigo');
    expect(valueText(null, null, false)).toBe('Sem modelo padrão');
    expect(valueText(null, null, true)).toBe('Escolher modelo');
  });
});
