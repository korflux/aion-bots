// Prova do contrato "Como te chamar" (phase 5, T4): a regra do nome do dono (aparado, de 0 a 40 caracteres contados por ponto de código, sem
// caractere de controle) é a mesma na borda da API, no core e na conferência da tela, porque os três usam este schema. O servidor e o banco a
// provam de novo nos testes deles; aqui ficam os casos de borda da regra em si.
import { describe, expect, it } from 'vitest';
import { OWNER_NAME_MAX_CHARS, appSettingsSchema, ownerNameSchema } from './settings';

describe('ownerNameSchema', () => {
  it('apara os espaços das pontas antes de contar e aceita vazio (sem nome)', () => {
    expect(ownerNameSchema.parse('  Marco  ')).toBe('Marco');
    expect(ownerNameSchema.parse('')).toBe('');
    expect(ownerNameSchema.parse('   ')).toBe('');
    expect(ownerNameSchema.parse(`${'a'.repeat(OWNER_NAME_MAX_CHARS)}   `)).toHaveLength(OWNER_NAME_MAX_CHARS);
  });

  it('conta caracteres, não unidades UTF-16: 40 com emoji passam, 41 não', () => {
    expect(ownerNameSchema.safeParse('ã'.repeat(39) + '😀').success).toBe(true);
    expect(ownerNameSchema.safeParse('a'.repeat(OWNER_NAME_MAX_CHARS + 1)).success).toBe(false);
    expect(ownerNameSchema.safeParse('😀'.repeat(OWNER_NAME_MAX_CHARS + 1)).success).toBe(false);
  });

  it('recusa caractere de controle no meio do texto (C0, DEL, C1 e separadores de linha), mas não o das pontas, que o aparar remove', () => {
    for (const bad of ['Mar\u0000co', 'Mar\nco', 'Mar\tco', 'Mar\u007Fco', 'Mar\u0085co', 'Mar co', 'Mar co']) {
      expect(ownerNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ownerNameSchema.parse('Marco\n')).toBe('Marco');
  });

  it('não aceita o que não é texto', () => {
    for (const bad of [7, null, undefined, ['Marco'], { name: 'Marco' }]) expect(ownerNameSchema.safeParse(bad).success).toBe(false);
  });
});

describe('appSettingsSchema', () => {
  it('leva idioma, fuso e nome, todos obrigatórios, e recusa campo extra', () => {
    const base = { language: 'pt-BR', timeZone: 'America/Sao_Paulo', ownerName: 'Marco' };
    expect(appSettingsSchema.parse(base)).toEqual(base);
    expect(appSettingsSchema.safeParse({ language: 'pt-BR', timeZone: 'America/Sao_Paulo' }).success).toBe(false);
    expect(appSettingsSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
