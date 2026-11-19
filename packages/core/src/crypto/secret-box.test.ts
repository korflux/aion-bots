// Prova da cifra autenticada: ida e volta, IV novo a cada cifra e recusa de adulteração, chave ou finalidade errada.
import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from './secret-box';

describe('cifra de segredos (AES-256-GCM)', () => {
  const master = Buffer.alloc(32, 7);

  it('abre o que cifrou, sem expor o texto claro, com IV diferente a cada cifra', () => {
    const a = sealSecret(master, 'totp', 'JBSWY3DPEHPK3PXP');
    const b = sealSecret(master, 'totp', 'JBSWY3DPEHPK3PXP');
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(openSecret(master, 'totp', a)).toBe('JBSWY3DPEHPK3PXP');
    expect(openSecret(master, 'totp', sealSecret(master, 'totp', 'ação é ✓'))).toBe('ação é ✓');
  });

  it('recusa adulteração, outra chave mestra, outra finalidade e formato inválido', () => {
    const sealed = sealSecret(master, 'totp', 'segredo');
    const parts = sealed.split('.');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('xxxxxxx').toString('base64url')].join('.');
    expect(() => openSecret(master, 'totp', tampered)).toThrow('falha de autenticação');
    expect(() => openSecret(Buffer.alloc(32, 8), 'totp', sealed)).toThrow('falha de autenticação');
    expect(() => openSecret(master, 'provider-key', sealed)).toThrow('falha de autenticação');
    expect(() => openSecret(master, 'totp', 'lixo')).toThrow('formato inválido');
    expect(() => openSecret(master, 'totp', `${sealed}.extra`)).toThrow('formato inválido');
  });
});
