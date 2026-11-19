// Prova dos contratos de bots (F5) e do utilitário de contraste: limites por pontos de código, campos extras,
// normalização da cor, padrões de criação x edição parcial, a ausência do personagem do mascote (removido na phase 5) e as 12 cores
// pré-definidas sobre o fundo do app.
import { describe, expect, it } from 'vitest';
import {
  BOT_COLORS,
  BOT_DEFAULT_COLOR,
  BOT_PREVIEW_EMPTY,
  BOT_PREVIEW_MAX,
  botCreateSchema,
  botSchema,
  botSummarySchema,
  botUpdateSchema,
  countChars,
} from './bots';
import {
  APP_BACKGROUND,
  BOT_MIN_CONTRAST,
  MARKER_TEXT_DARK,
  MARKER_TEXT_LIGHT,
  TEXT_MIN_CONTRAST,
  contrastRatio,
  hasLowBotContrast,
  readableTextOn,
  relativeLuminance,
} from './contrast';

/** Motivos de falha de um `safeParse`, como `campo:código`, para comparar sem depender do texto do Zod. */
const failures = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; code: string }[] } }): string[] =>
  result.error?.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`) ?? [];

describe('contraste (WCAG 2.x)', () => {
  it('reproduz as razões de referência e a escolha da cor da inicial', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // Razão é simétrica e insensível a maiúsculas.
    expect(contrastRatio('#0f0f10', '#ffffff')).toBeCloseTo(contrastRatio('#FFFFFF', '#0F0F10'), 10);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(() => relativeLuminance('vermelho')).toThrow(RangeError);

    expect(readableTextOn('#FBBF24')).toBe(MARKER_TEXT_DARK); // âmbar: texto escuro
    expect(readableTextOn('#1E3A8A')).toBe(MARKER_TEXT_LIGHT); // azul escuro: texto claro
    // Seja qual for a cor do bot, a inicial fica acima de 4,3:1. O pior caso é um cinza médio: com o texto escuro
    // #0F0F10 do design dá cerca de 4,38:1 (com preto puro seria 4,58:1).
    for (let step = 0; step <= 255; step += 5) {
      const gray = `#${step.toString(16).padStart(2, '0').repeat(3)}`;
      expect(contrastRatio(gray, readableTextOn(gray))).toBeGreaterThanOrEqual(4.3);
    }
  });

  it('o aviso de pouco contraste dispara abaixo de 3:1 sobre o fundo do app e só nele', () => {
    expect(hasLowBotContrast('#222222')).toBe(true);
    expect(hasLowBotContrast('#0F0F10')).toBe(true);
    expect(hasLowBotContrast('#FFFFFF')).toBe(false);
    // Fronteira: um cinza logo abaixo e logo acima de 3:1.
    const below = '#5C5C5C';
    const above = '#6A6A6A';
    expect(contrastRatio(below, APP_BACKGROUND)).toBeLessThan(BOT_MIN_CONTRAST);
    expect(contrastRatio(above, APP_BACKGROUND)).toBeGreaterThan(BOT_MIN_CONTRAST);
    expect(hasLowBotContrast(below)).toBe(true);
    expect(hasLowBotContrast(above)).toBe(false);
  });

  it('as 12 cores pré-definidas são distintas, nomeadas e passam de 4,5:1 sobre o fundo (logo, de 3:1)', () => {
    expect(BOT_COLORS).toHaveLength(12);
    expect(new Set(BOT_COLORS.map((color) => color.hex)).size).toBe(12);
    expect(new Set(BOT_COLORS.map((color) => color.name)).size).toBe(12);
    expect(BOT_COLORS.map((color) => color.hex)).toContain(BOT_DEFAULT_COLOR);
    for (const color of BOT_COLORS) {
      expect(color.hex).toMatch(/^#[0-9A-F]{6}$/);
      expect(contrastRatio(color.hex, APP_BACKGROUND), color.name).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
      expect(hasLowBotContrast(color.hex)).toBe(false);
    }
  });
});

describe('schemas de bot', () => {
  it('contexto aceita apenas presets inteiros ou herança e edição ausente não aplica padrão', () => {
    for (const contextWindowTokens of [null, 65536, 131072, 262144, 524288]) {
      expect(botCreateSchema.parse({ name: 'Bot', color: '#60A5FA', contextWindowTokens }).contextWindowTokens).toBe(contextWindowTokens);
      expect(botUpdateSchema.parse({ contextWindowTokens })).toEqual({ contextWindowTokens });
    }
    // 32k saiu das opções (phase 11): criação e edição recusam, junto dos formatos inválidos de sempre.
    expect(botCreateSchema.safeParse({ name: 'Bot', color: '#60A5FA', contextWindowTokens: 32768 }).success).toBe(false);
    for (const contextWindowTokens of [32768, '65536', 32000, 65536.5, true, {}, -1]) {
      expect(botUpdateSchema.safeParse({ contextWindowTokens }).success).toBe(false);
    }
    expect(botUpdateSchema.parse({ name: 'Bot' })).not.toHaveProperty('contextWindowTokens');
  });
  it('criação: aplica os padrões, apara o nome e grava a cor em maiúsculas', () => {
    const parsed = botCreateSchema.parse({ name: '  Financeiro  ', color: '#60a5fa' });
    expect(parsed).toEqual({
      name: 'Financeiro',
      color: '#60A5FA',
      instructions: '',
      model: null,
      effort: null,
      stepLimit: 50,
      contextWindowTokens: null,
    });
  });

  it('sem personagem (phase 5): criar e editar recusam `mascot` como campo desconhecido, com qualquer valor, e nenhum padrão o reintroduz', () => {
    expect(botCreateSchema.parse({ name: 'Bot', color: '#60A5FA' })).not.toHaveProperty('mascot');
    expect(botUpdateSchema.parse({ name: 'Novo' })).not.toHaveProperty('mascot');
    for (const mascot of ['circle', 'hexagon', '', 'Circle', 'star', 7, null, ['circle']]) {
      expect(failures(botCreateSchema.safeParse({ name: 'Bot', color: '#60A5FA', mascot })), String(mascot)).toEqual([':unrecognized_keys']);
      expect(failures(botUpdateSchema.safeParse({ mascot })), String(mascot)).toEqual([':unrecognized_keys']);
    }
  });

  it('o resumo e o bot completo não têm personagem: só identidade (id, nome, cor, arquivamento), e um `mascot` que viesse nos dados é descartado', () => {
    const identity = { id: '5f8c9d2e-3a41-4b6c-8d7e-9a0b1c2d3e4f', name: 'Bot', color: '#60A5FA', archivedAt: null };
    const summary = { ...identity, runState: 'idle', unread: false, preview: BOT_PREVIEW_EMPTY };
    expect(botSummarySchema.parse(summary)).toEqual(summary);
    expect(botSummarySchema.parse({ ...summary, mascot: 'pill' })).toEqual(summary);
    const full = {
      ...identity,
      instructions: '',
      model: null,
      effort: null,
      stepLimit: 50,
      contextWindowTokens: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(botSchema.parse(full)).toEqual(full);
    expect(botSchema.parse({ ...full, mascot: 'pill' })).toEqual(full);
  });

  it('o estado ao vivo (runState, F10) é do item da lista: obrigatório e de uma lista fixa de seis; o bot completo não o carrega', () => {
    const identity = { id: '5f8c9d2e-3a41-4b6c-8d7e-9a0b1c2d3e4f', name: 'Bot', color: '#60A5FA', archivedAt: null };
    for (const runState of ['idle', 'working', 'waiting', 'done', 'error', 'sleep']) {
      expect(botSummarySchema.parse({ ...identity, runState, unread: false, preview: BOT_PREVIEW_EMPTY }).runState, runState).toBe(runState);
    }
    for (const runState of [undefined, '', 'Working', 'trabalhando', 'queued', null, 1]) {
      expect(botSummarySchema.safeParse({ ...identity, runState, unread: false, preview: BOT_PREVIEW_EMPTY }).success, String(runState)).toBe(false);
    }
    // Uma resposta de criação ou edição não tem estado ao vivo; se um dia ele vazasse para o bot completo, o contrato o descarta.
    const full = { ...identity, instructions: '', model: null, effort: null, stepLimit: 50, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    expect(Object.keys(botSchema.parse({ ...full, runState: 'working' }))).not.toContain('runState');
  });

  it('a novidade não lida (unread, phase 3 F4) é do item da lista: booleano obrigatório calculado no servidor', () => {
    const summary = { id: '5f8c9d2e-3a41-4b6c-8d7e-9a0b1c2d3e4f', name: 'Bot', color: '#60A5FA', archivedAt: null, runState: 'idle', preview: BOT_PREVIEW_EMPTY };
    expect(botSummarySchema.parse({ ...summary, unread: true }).unread).toBe(true);
    for (const unread of [undefined, null, 'sim', 1]) expect(botSummarySchema.safeParse({ ...summary, unread }).success, String(unread)).toBe(false);
  });

  it('a prévia da última novidade (phase 5, spec F4) é do item da lista: texto de 1 a 120 caracteres (emoji conta 1), obrigatório, e o bot completo não a carrega', () => {
    const summary = { id: '5f8c9d2e-3a41-4b6c-8d7e-9a0b1c2d3e4f', name: 'Bot', color: '#60A5FA', archivedAt: null, runState: 'idle', unread: false };
    expect(botSummarySchema.parse({ ...summary, preview: 'a'.repeat(BOT_PREVIEW_MAX) }).preview).toHaveLength(BOT_PREVIEW_MAX);
    expect(botSummarySchema.parse({ ...summary, preview: '😀'.repeat(BOT_PREVIEW_MAX) }).preview).toBe('😀'.repeat(BOT_PREVIEW_MAX));
    for (const preview of [undefined, null, '', 'a'.repeat(BOT_PREVIEW_MAX + 1), '😀'.repeat(BOT_PREVIEW_MAX + 1), 1]) {
      expect(botSummarySchema.safeParse({ ...summary, preview }).success, String(preview)).toBe(false);
    }
    const full = { ...summary, instructions: '', model: null, effort: null, stepLimit: 50, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    expect(Object.keys(botSchema.parse({ ...full, preview: 'x' }))).not.toContain('preview');
  });

  it('os limites da spec valem nas bordas, contando caracteres (emoji conta 1) e não unidades UTF-16', () => {
    const create = (overrides: Record<string, unknown>) =>
      botCreateSchema.safeParse({ name: 'Bot', color: '#60A5FA', ...overrides });

    expect(countChars('🤖a')).toBe(2);
    // Nome: 60 caracteres passam (60 emojis = 120 unidades UTF-16), 61 não; só espaços equivale a vazio.
    expect(create({ name: '🤖'.repeat(60) }).success).toBe(true);
    expect(failures(create({ name: '🤖'.repeat(61) }))).toEqual(['name:too_big']);
    expect(create({ name: 'a'.repeat(60) }).success).toBe(true);
    expect(create({ name: '   ' }).success).toBe(false);
    expect(create({ name: 'quebra\nde linha' }).success).toBe(false);
    expect(create({ name: 'nulo\u0000' }).success).toBe(false);

    // Instruções: 8.000 passam, 8.001 não; NUL é recusado, tabulação e quebra de linha valem.
    expect(create({ instructions: 'x'.repeat(8000) }).success).toBe(true);
    expect(failures(create({ instructions: 'x'.repeat(8001) }))).toEqual(['instructions:too_big']);
    expect(create({ instructions: 'linha 1\n\tlinha 2\r\n' }).success).toBe(true);
    expect(create({ instructions: 'a\u0000b' }).success).toBe(false);

    // Cor: só #RRGGBB.
    for (const color of ['60A5FA', '#60A5F', '#60A5FAA', '#GGGGGG', 'azul', '']) {
      expect(create({ color }).success, color).toBe(false);
    }
    // Limite de etapas: inteiro de 1 a 100.
    for (const stepLimit of [1, 25, 100]) expect(create({ stepLimit }).success, String(stepLimit)).toBe(true);
    for (const stepLimit of [0, 101, -1, 2.5, '25', null, Number.NaN]) {
      expect(create({ stepLimit }).success, String(stepLimit)).toBe(false);
    }
    // Modelo: id do provedor (formato frouxo, a lista atual é checada no core) ou nulo; effort: um nível conhecido ou nulo.
    expect(create({ model: 'opencode/glm-5.1', effort: 'high' }).success).toBe(true);
    expect(create({ model: null, effort: null }).success).toBe(true);
    expect(create({ model: 'm'.repeat(209) }).success).toBe(true); // o limite é o id local de 200 caracteres mais o prefixo 'opencode/' (MODEL_ID_MAX = 209)
    for (const model of ['', 'm'.repeat(210), 'quebra\nde linha', 7]) expect(create({ model }).success, String(model)).toBe(false);
    for (const effort of ['', 'altíssimo', 'HIGH', 3]) expect(create({ effort }).success, String(effort)).toBe(false);
  });

  it('campos extras são recusados na criação e na edição (mass assignment)', () => {
    for (const extra of ['id', 'archivedAt', 'nameKey', 'createdAt', 'conversationId']) {
      expect(botCreateSchema.safeParse({ name: 'Bot', color: '#60A5FA', [extra]: 'x' }).success, extra).toBe(false);
      expect(botUpdateSchema.safeParse({ [extra]: 'x' }).success, extra).toBe(false);
    }
  });

  it('edição parcial não aplica padrões: campo ausente continua ausente', () => {
    expect(botUpdateSchema.parse({})).toEqual({});
    expect(botUpdateSchema.parse({ stepLimit: 10 })).toEqual({ stepLimit: 10 });
    expect(botUpdateSchema.parse({ color: '#f472b6', name: ' Novo ' })).toEqual({ color: '#F472B6', name: 'Novo' });
  });
});
