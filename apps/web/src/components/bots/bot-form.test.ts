// Prova da validação do formulário do bot no cliente: o que é enviado (normalizado) e a frase de cada erro.
import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, errorsFromApi, formFromBot, isPresetColor, validateBotForm, type BotFormValues } from './bot-form';
import { initialOf, readableNameColor } from './bot-display';

const form = (overrides: Partial<BotFormValues> = {}): BotFormValues => ({ ...EMPTY_FORM, name: 'Financeiro', ...overrides });

describe('validateBotForm', () => {
  it('contexto preserva herança e os quatro presets (64k a 512k) sem confundir com a troca do modelo', () => {
    for (const contextWindowTokens of [null, 65536, 131072, 262144, 524288] as const) {
      const values = form({ contextWindowTokens });
      expect(validateBotForm({ ...values, model: 'opencode/deepseek-v4.1-flash' }).draft?.contextWindowTokens).toBe(contextWindowTokens);
      // Ao editar um bot salvo, a escolha própria volta ao formulário igual.
      expect(formFromBot({ id: 'x', name: 'Bot', color: '#60A5FA', archivedAt: null, instructions: '', model: null, effort: null, stepLimit: 30, contextWindowTokens } as never).contextWindowTokens).toBe(contextWindowTokens);
    }
    // 32k saiu das opções: um valor fora da lista (ex.: de uma versão antiga) não vira escolha própria, o formulário cai em "Usar global".
    expect(formFromBot({ id: 'x', name: 'Bot', color: '#60A5FA', archivedAt: null, instructions: '', model: null, effort: null, stepLimit: 30, contextWindowTokens: 32768 } as never).contextWindowTokens).toBeNull();
  });
  it('envia o rascunho normalizado: nome aparado, cor em maiúsculas e limite numérico', () => {
    const result = validateBotForm(form({ name: '  Financeiro  ', color: '#abcdef', instructions: 'Controle.', stepLimit: ' 40 ' }));
    expect(result).toEqual({
      draft: { name: 'Financeiro', color: '#ABCDEF', instructions: 'Controle.', model: null, effort: null, stepLimit: 40, contextWindowTokens: null },
      errors: null,
    });
  });

  it('o formulário inicial só falta o nome; com nome, os padrões passam (50 etapas, cor azul)', () => {
    expect(validateBotForm(EMPTY_FORM).errors).toEqual({ name: 'Informe um nome.' });
    expect(validateBotForm(form()).draft).toMatchObject({ color: '#60A5FA', stepLimit: 50, instructions: '', model: null, effort: null });
  });

  it('não há personagem: o formulário e o rascunho não levam `mascot` (a Faísca é única), nem ao partir de um bot salvo', () => {
    expect(EMPTY_FORM).not.toHaveProperty('mascot');
    expect(validateBotForm(form()).draft).not.toHaveProperty('mascot');
    const saved = { id: 'x', name: 'Contábil', color: '#F472B6', archivedAt: null, instructions: 'a', model: null, effort: null, stepLimit: 30 } as never;
    expect(formFromBot(saved)).toMatchObject({ name: 'Contábil', color: '#F472B6' });
    expect(formFromBot(saved)).not.toHaveProperty('mascot');
  });

  it('modelo e effort escolhidos no seletor seguem no rascunho; um effort fora do vocabulário é recusado com a frase do campo', () => {
    expect(validateBotForm(form({ model: 'opencode/glm-5.1', effort: 'high' })).draft).toMatchObject({ model: 'opencode/glm-5.1', effort: 'high' });
    const invalid = validateBotForm(form({ model: 'opencode/glm-5.1', effort: 'altissimo' as never }));
    expect(invalid.errors).toEqual({ effort: 'Escolha um effort da lista do modelo.' });
  });

  it('cada campo recusado mostra a própria frase, e todos aparecem de uma vez', () => {
    const result = validateBotForm(form({ name: 'n'.repeat(61), color: 'azul', instructions: 'i'.repeat(8001), stepLimit: '0' }));
    expect(result.draft).toBeNull();
    expect(result.errors).toEqual({
      name: 'Use até 60 caracteres.',
      color: 'Use o formato #RRGGBB, por exemplo #60A5FA.',
      instructions: 'As instruções passaram de 8.000 caracteres.',
      stepLimit: 'Informe um número inteiro de 1 a 100.',
    });
  });

  it('limite de etapas: só inteiros de 1 a 100 (texto, fração, vazio e sinal são recusados)', () => {
    for (const value of ['1', '100', '25']) expect(validateBotForm(form({ stepLimit: value })).draft?.stepLimit).toBe(Number(value));
    for (const value of ['', '  ', '0', '101', '2.5', '2,5', '-1', 'dez', '1e2', '٣']) {
      expect(validateBotForm(form({ stepLimit: value })).errors?.stepLimit, JSON.stringify(value)).toBeDefined();
    }
  });

  it('nome só com espaços ou com quebra de linha é recusado; emoji conta como um caractere', () => {
    expect(validateBotForm(form({ name: '   ' })).errors?.name).toBe('Informe um nome.');
    expect(validateBotForm(form({ name: 'duas\nlinhas' })).errors?.name).toContain('quebra de linha');
    expect(validateBotForm(form({ name: '🤖'.repeat(60) })).draft).not.toBeNull();
    expect(validateBotForm(form({ name: '🤖'.repeat(61) })).errors?.name).toBe('Use até 60 caracteres.');
  });
});

describe('erros da API e cores', () => {
  it('traduz os campos de VALIDATION_FAILED e ignora os que o formulário não tem', () => {
    expect(
      errorsFromApi([
        { field: 'name', reason: 'Valor curto demais.' },
        { field: 'name', reason: 'Formato inválido.' },
        { field: 'stepLimit', reason: 'Valor longo demais.' },
        { field: 'effort', reason: 'O modelo não aceita este effort.' },
        { field: 'corpo', reason: 'Campo não permitido.' },
      ]),
    ).toEqual({ name: 'Valor curto demais.', stepLimit: 'Valor longo demais.', effort: 'O modelo não aceita este effort.' });
    expect(errorsFromApi(undefined)).toEqual({});
  });

  it('reconhece as cores pré-definidas (sem diferenciar maiúsculas) e trata as demais como personalizadas', () => {
    expect(isPresetColor('#60A5FA')).toBe(true);
    expect(isPresetColor('#60a5fa')).toBe(true);
    expect(isPresetColor('#123456')).toBe(false);
  });

  it('a inicial do marcador vem do primeiro caractere do nome, em maiúscula', () => {
    expect(initialOf('financeiro')).toBe('F');
    expect(initialOf('  ação')).toBe('A');
    expect(initialOf('🤖 Robô')).toBe('🤖');
    expect(initialOf('   ')).toBe('?');
  });

  it('o nome destacado usa a cor do bot só quando ela é legível como texto (4,5:1), senão o texto padrão', () => {
    expect(readableNameColor('#60A5FA')).toBe('#60A5FA');
    expect(readableNameColor('#222222')).toBe('var(--text)');
    // Entre 3:1 (sem aviso no editor) e 4,5:1 o nome também cai para o texto padrão.
    expect(readableNameColor('#6A6A6A')).toBe('var(--text)');
  });
});
