// Prova das primitivas de chave: formatos aceitos da chave mestra e independência das subchaves derivadas.
import { describe, expect, it } from 'vitest';
import { deriveKey, parseMasterKey, safeEqualStrings } from './keys';

describe('chave mestra e derivação', () => {
  it('aceita 32 bytes em hex/base64/base64url e recusa tamanho ou formato errado', () => {
    const raw = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 8 + 1));
    expect(parseMasterKey(raw.toString('hex'))?.equals(raw)).toBe(true);
    expect(parseMasterKey(raw.toString('base64'))?.equals(raw)).toBe(true);
    expect(parseMasterKey(raw.toString('base64url'))?.equals(raw)).toBe(true);
    expect(parseMasterKey(Buffer.alloc(16).toString('base64'))).toBeNull();
    expect(parseMasterKey('isto não é uma chave!')).toBeNull();
    expect(parseMasterKey('')).toBeNull();
  });

  it('deriva subchaves estáveis, distintas por finalidade e por chave mestra', () => {
    const master = Buffer.alloc(32, 1);
    expect(deriveKey(master, 'csrf').equals(deriveKey(master, 'csrf'))).toBe(true);
    expect(deriveKey(master, 'csrf').equals(deriveKey(master, 'credential-fingerprint'))).toBe(false);
    expect(deriveKey(master, 'csrf').equals(deriveKey(Buffer.alloc(32, 2), 'csrf'))).toBe(false);
    expect(safeEqualStrings('abc', 'abc')).toBe(true);
    expect(safeEqualStrings('abc', 'abd')).toBe(false);
    expect(safeEqualStrings('abc', 'abcd')).toBe(false);
  });
});
