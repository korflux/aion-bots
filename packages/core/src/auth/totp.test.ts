// Prova das primitivas do TOTP contra os vetores OFICIAIS do RFC 6238 (Apêndice B, SHA-1) e do RFC 4648.
// É a âncora das demais provas: os testes de jornada calculam os códigos com estas mesmas funções, então
// aqui se garante que elas produzem o que qualquer app autenticador produz.
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  matchTotpStep,
  totpCodeForStep,
  totpStepAt,
} from './totp';

/** Segredo de teste do RFC 6238: a string ASCII "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('primitivas do TOTP (RFC 6238)', () => {
  it('gera os códigos dos vetores oficiais do RFC (os 6 últimos dígitos dos valores de 8) e o base32 do RFC 4648', () => {
    // Apêndice B do RFC 6238, SHA-1: [instante em segundos, código de 8 dígitos]. O de 6 dígitos é o sufixo.
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, eightDigits] of vectors) {
      const step = totpStepAt(new Date(seconds * 1000));
      expect(totpCodeForStep(RFC_SECRET, step), `t=${seconds}`).toBe(eightDigits.slice(2));
    }

    // Vetores do RFC 4648 §10 (sem preenchimento) e ida e volta.
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('fooba'))).toBe('MZXW6YTB');
    expect(base32Decode('MZXW6YTBOI')?.toString()).toBe('foobar');
    expect(base32Decode('mzxw6ytboi')?.toString()).toBe('foobar');
    expect(base32Decode('MZXW6YT1')).toBeNull(); // '1' fora do alfabeto
  });

  it('aceita a janela atual e uma de cada lado e recusa duas de distância', () => {
    const at = new Date('2026-03-01T12:00:10Z');
    const step = totpStepAt(at);
    const codeOf = (delta: number) => totpCodeForStep(RFC_SECRET, step + delta);

    expect(matchTotpStep(RFC_SECRET, codeOf(0), at)).toBe(step);
    expect(matchTotpStep(RFC_SECRET, codeOf(-1), at)).toBe(step - 1);
    expect(matchTotpStep(RFC_SECRET, codeOf(1), at)).toBe(step + 1);
    expect(matchTotpStep(RFC_SECRET, codeOf(-2), at)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, codeOf(2), at)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, '12345', at)).toBeNull(); // tamanho errado nunca bate
  });

  it('segredo novo tem 20 bytes aleatórios em base32, e a URI otpauth leva os parâmetros que os apps leem', () => {
    const first = generateTotpSecret();
    expect(first).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(first)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(first);

    const uri = new URL(buildOtpauthUri(first, 'dono+teste@aion.test'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Aion:dono+teste@aion.test');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: first,
      issuer: 'Aion',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});
