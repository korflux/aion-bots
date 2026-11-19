// Primitivas do TOTP (RFC 6238 sobre HOTP do RFC 4226), só com `node:crypto`: geração do segredo, código de uma
// janela, verificação com tolerância e a URI `otpauth://` que os apps autenticadores leem no QR.
//
// Este módulo é PURO (sem banco, sem relógio global, sem segredo em estado): o serviço (`totp-service.ts`) cuida
// de cifrar, persistir e impedir reuso. Fica separado para ser provado contra os vetores oficiais do RFC.
//
// Decisões:
// - HMAC-SHA1: é o algoritmo que Google Authenticator, Authy, 1Password e afins implementam de fato (a maioria
//   ignora `algorithm=SHA256` da URI). O uso aqui é como HMAC, não como hash de senha, então SHA-1 é seguro.
// - Segredo de 20 bytes (160 bits), o tamanho recomendado pelo RFC 4226, em base32 sem preenchimento.
// - Comparação do código em tempo constante, e as TRÊS janelas são sempre calculadas e comparadas (sem `return`
//   antecipado), para o tempo de resposta não revelar em qual janela o código caiu.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from '@aion/shared';

/** Janelas aceitas para cada lado da atual (spec: "tolerância de uma janela"), cobrindo relógios levemente fora. */
export const TOTP_WINDOW_TOLERANCE = 1;
const SECRET_BYTES = 20;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 do RFC 4648 sem `=`: o formato que os apps pedem quando o dono digita o segredo no lugar do QR. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Inverso de `base32Encode`. Devolve `null` para qualquer caractere fora do alfabeto (sem ecoar o valor). */
export function base32Decode(text: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Segredo novo e aleatório, em base32 (32 caracteres). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** Número da janela de 30 s que contém o instante dado (o "contador" do HOTP). */
export function totpStepAt(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** Código de 6 dígitos da janela `step` para o segredo em base32. Lança se o segredo não for base32 válido. */
export function totpCodeForStep(secretBase32: string, step: number): string {
  const key = base32Decode(secretBase32);
  if (!key || key.length === 0) throw new Error('totp: segredo inválido');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  // Truncamento dinâmico do RFC 4226 §5.3: 31 bits a partir do deslocamento dado pelo último nibble.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Janela do código informado entre as aceitas em torno de `at` (atual ± tolerância), ou `null` se nenhuma bate.
 * Não impede reuso: quem consome o código (`TotpService.consume`) só o aceita se a janela for mais nova que a última usada.
 */
export function matchTotpStep(secretBase32: string, code: string, at: Date): number | null {
  const current = totpStepAt(at);
  const provided = Buffer.from(code);
  let matched: number | null = null;
  for (let delta = -TOTP_WINDOW_TOLERANCE; delta <= TOTP_WINDOW_TOLERANCE; delta += 1) {
    const step = current + delta;
    const expected = Buffer.from(totpCodeForStep(secretBase32, step));
    // Sem curto-circuito: todas as janelas são avaliadas mesmo depois de um acerto.
    const equal = provided.length === expected.length && timingSafeEqual(provided, expected);
    if (equal) matched = step;
  }
  return matched;
}

/**
 * URI `otpauth://` do formato de chaves do Google Authenticator, que o dono escaneia. O rótulo é `Aion:<e-mail>` e
 * o `issuer` repete `Aion` para o app agrupar a conta. Só o navegador desenha o QR a partir dela.
 */
export function buildOtpauthUri(secretBase32: string, accountEmail: string): string {
  const label = encodeURIComponent(`Aion:${accountEmail}`);
  const query = new URLSearchParams({
    secret: secretBase32,
    issuer: 'Aion',
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
