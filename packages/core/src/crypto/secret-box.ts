// Cifra autenticada (AES-256-GCM) de segredos guardados no banco: segredo TOTP (T2) e chaves do OpenCode Go e
// do Composio (T3). Fonte única dessa cifra; nenhum módulo implementa a própria.
//
// Formato armazenado: `v1.<iv>.<tag>.<texto cifrado>` (base64url). A subchave vem da chave mestra por finalidade
// (`deriveKey`), e a finalidade também entra como dado autenticado (AAD): um texto cifrado de um uso não abre em
// outro, nem que alguém copie a coluna errada no banco.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from './keys';

const VERSION = 'v1';
const IV_BYTES = 12; // tamanho recomendado para GCM
const TAG_BYTES = 16;

/** Cifra `plaintext` para a finalidade dada. Cada chamada usa um IV aleatório novo. */
export function sealSecret(masterKey: Buffer, purpose: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(masterKey, `secret:${purpose}`), iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(
    '.',
  );
}

/**
 * Abre um valor produzido por `sealSecret`. Lança `Error` genérico (sem o valor) se o formato, a chave mestra, a
 * finalidade ou o conteúdo não baterem; quem chama decide como isso aparece ao usuário.
 */
export function openSecret(masterKey: Buffer, purpose: string, sealed: string): string {
  const [version, iv, tag, body, ...extra] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || !body || extra.length > 0) throw new Error('secret-box: formato inválido');
  const ivBytes = Buffer.from(iv, 'base64url');
  const tagBytes = Buffer.from(tag, 'base64url');
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) throw new Error('secret-box: formato inválido');
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(masterKey, `secret:${purpose}`), ivBytes);
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('secret-box: falha de autenticação');
  }
}
