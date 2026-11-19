// Chave mestra (AION_MASTER_KEY) e derivação de subchaves por finalidade.
//
// A chave mestra nunca é usada diretamente: cada uso (impressão da credencial, CSRF, futuramente a cifra das
// chaves de terceiros e do segredo TOTP) deriva a própria subchave via HKDF-SHA256. Assim o vazamento de uma
// subchave não compromete as demais, e trocar a mestra invalida tudo que dela deriva.
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

const MASTER_KEY_BYTES = 32;

/**
 * Aceita 32 bytes em hexadecimal (64 caracteres) ou base64/base64url. Devolve `null` se o formato ou o
 * tamanho não bater, sem nunca incluir o valor em mensagem alguma.
 */
export function parseMasterKey(raw: string): Buffer | null {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === MASTER_KEY_BYTES ? decoded : null;
}

/** Subchave de 32 bytes derivada da mestra para uma finalidade nomeada (ex.: `csrf`). */
export function deriveKey(masterKey: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `aion:${purpose}:v1`, 32));
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function hmacBase64Url(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

/** Comparação em tempo constante; tamanhos diferentes são apenas "diferentes" (digests têm tamanho fixo). */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function safeEqualStrings(a: string, b: string): boolean {
  return safeEqual(Buffer.from(a), Buffer.from(b));
}
