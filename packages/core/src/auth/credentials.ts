// Credencial do dono (AUTH-02): e-mail e senha vêm do ambiente em texto, mas o processo só retém derivados.
//
// - Verificação: Argon2id (nativo do Node, sem dependência) com sal por processo. A senha em texto é usada
//   uma vez na subida para gerar o hash e para a impressão; depois quem chama deve descartá-la.
// - Tempo constante: e-mail e senha são SEMPRE ambos calculados e comparados com timingSafeEqual antes de
//   decidir, para não revelar qual dos dois errou nem por tempo de resposta.
// - Impressão (fingerprint): HMAC da credencial com subchave da chave mestra. Guardada no banco, permite
//   detectar troca de senha/e-mail no ambiente sem que um vazamento do banco permita adivinhar a senha.
import { argon2, randomBytes } from 'node:crypto';
import { deriveKey, hmacHex, safeEqual, sha256Hex } from '../crypto/keys';

export interface OwnerCredentials {
  email: string;
  password: string;
}

export interface CredentialVerifier {
  /** E-mail do dono como configurado (exibido em Conta). */
  readonly email: string;
  /** Impressão estável da credencial, comparada com a do último start para revogar sessões. */
  readonly fingerprint: string;
  /** Confere e-mail e senha em tempo constante. */
  verify(email: string, password: string): Promise<boolean>;
}

// Parâmetros mínimos recomendados pela OWASP para Argon2id: 19 MiB de memória, 2 passes, 1 de paralelismo.
const ARGON2_PARAMS = { parallelism: 1, tagLength: 32, memory: 19_456, passes: 2 } as const;

function hashPassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { ...ARGON2_PARAMS, message: Buffer.from(password, 'utf8'), nonce: salt }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function createCredentialVerifier(
  credentials: OwnerCredentials,
  masterKey: Buffer,
): Promise<CredentialVerifier> {
  const salt = randomBytes(16);
  const ownerEmailDigest = Buffer.from(sha256Hex(normalizeEmail(credentials.email)), 'hex');
  const ownerPasswordHash = await hashPassword(credentials.password, salt);
  const fingerprint = hmacHex(
    deriveKey(masterKey, 'credential-fingerprint'),
    `${normalizeEmail(credentials.email)}\0${credentials.password}`,
  );

  return {
    email: credentials.email.trim(),
    fingerprint,
    async verify(email, password) {
      const emailDigest = Buffer.from(sha256Hex(normalizeEmail(email)), 'hex');
      const passwordHash = await hashPassword(password, salt);
      // Sem curto-circuito entre as duas comparações: ambas rodam sempre.
      const emailMatches = safeEqual(emailDigest, ownerEmailDigest);
      const passwordMatches = safeEqual(passwordHash, ownerPasswordHash);
      return emailMatches && passwordMatches;
    },
  };
}
