// Estado do autenticador TOTP do dono: ativação em dois tempos, segredo cifrado no banco e consumo de códigos
// sem reuso. Não conhece HTTP, bloqueio de tentativas nem auditoria: quem orquestra isso é o `AuthService`, que
// chama estas operações dentro do mesmo controle de tentativas do login (AUTH-04).
//
// Modelo de dados (migration 0002): uma linha em `totp_credential` = autenticador ATIVO; nenhuma linha = desativado.
//
// Ativação (F2):
//   1. `beginEnrollment` gera um segredo e o devolve ao navegador (QR e texto) dentro de um token de ativação
//      cifrado com a chave mestra. NADA é gravado no banco: o segredo só existe como "ativo" depois do passo 2.
//   2. `confirmEnrollment` abre o token, confere o código contra o segredo e só então insere a linha.
// O token de ativação é cifrado (AES-256-GCM, finalidade própria) para que o servidor não precise guardar estado
// nem confiar em um segredo escolhido pelo cliente: só o segredo que o próprio servidor gerou é aceito.
//
// Uso do código (login, desativar): `consume` procura o código nas janelas aceitas (atual ± 1) e o aceita só se a
// janela for MAIS NOVA que a última usada (RFC 6238 §5.2: o mesmo código não vale duas vezes). A regra é imposta por
// um UPDATE condicional, atômico no banco: dois pedidos simultâneos com o mesmo código, mesmo de instâncias
// diferentes da API, resultam em um aceito e outro recusado.
//
// ponytail: sem códigos de recuperação de uso único, a recuperação de quem perdeu o celular é `AION_TOTP_RESET=true`
// no ambiente, criar códigos de recuperação se o dono passar a querer recuperar o acesso sem mexer no servidor.
import type { TotpSetupResponse } from '@aion/shared';
import { openSecret, sealSecret } from '../crypto/secret-box';
import type { Queryable } from '../db/pool';
import { DomainError } from '../errors';
import { buildOtpauthUri, base32Decode, generateTotpSecret, matchTotpStep } from './totp';

/** Finalidade (subchave e AAD) do segredo TOTP ativo gravado no banco. */
const SECRET_PURPOSE = 'totp';
/** Finalidade do token de ativação que viaja pelo navegador; separada para um não abrir o outro. */
const ENROLLMENT_PURPOSE = 'totp-enrollment';
/** Quanto tempo o dono tem para ler o QR e digitar o primeiro código. */
export const TOTP_SETUP_TTL_MS = 15 * 60_000;
const SECRET_BYTES = 20;

interface EnrollmentPayload {
  secret: string;
  expiresAt: number;
}

export class TotpService {
  private readonly masterKey: Buffer;

  constructor(masterKey: Buffer) {
    this.masterKey = masterKey;
  }

  /** O autenticador está ativo? */
  async isEnabled(db: Queryable): Promise<boolean> {
    const result = await db.query('SELECT 1 FROM totp_credential');
    return (result.rowCount ?? 0) > 0;
  }

  /** Passo 1 da ativação: segredo novo, URI para o QR e token de ativação. Não toca no banco. */
  beginEnrollment(ownerEmail: string, now: Date): TotpSetupResponse {
    const secret = generateTotpSecret();
    const payload: EnrollmentPayload = { secret, expiresAt: now.getTime() + TOTP_SETUP_TTL_MS };
    return {
      secret,
      otpauthUri: buildOtpauthUri(secret, ownerEmail),
      enrollmentToken: sealSecret(this.masterKey, ENROLLMENT_PURPOSE, JSON.stringify(payload)),
    };
  }

  /**
   * Passo 2 da ativação. Devolve `false` se o código não bate (o chamador conta a falha). Lança
   * `TOTP_SETUP_EXPIRED` se o token é inválido, adulterado ou venceu, e `TOTP_ALREADY_ENABLED` se outra ativação
   * chegou antes. O código usado na confirmação já conta como "consumido": não vale de novo no login seguinte.
   */
  async confirmEnrollment(db: Queryable, enrollmentToken: string, code: string, now: Date): Promise<boolean> {
    const secret = this.openEnrollmentToken(enrollmentToken, now);
    const step = matchTotpStep(secret, code, now);
    if (step === null) return false;
    const inserted = await db.query(
      `INSERT INTO totp_credential (secret_sealed, last_used_step, enabled_at) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [sealSecret(this.masterKey, SECRET_PURPOSE, secret), step, now],
    );
    if (inserted.rowCount === 0) throw new DomainError('TOTP_ALREADY_ENABLED');
    return true;
  }

  /**
   * Confere o código contra o segredo ativo e o consome. `false` se não há autenticador ativo, se o código não bate
   * em nenhuma janela aceita ou se já foi usado (janela igual ou anterior à última aceita).
   */
  async consume(db: Queryable, code: string, now: Date): Promise<boolean> {
    const found = await db.query<{ secret_sealed: string }>('SELECT secret_sealed FROM totp_credential');
    const row = found.rows[0];
    if (!row) return false;
    const secret = openSecret(this.masterKey, SECRET_PURPOSE, row.secret_sealed);
    const step = matchTotpStep(secret, code, now);
    if (step === null) return false;
    // Só avança se a janela for mais nova que a última usada: é isto que barra o reuso, inclusive em corrida.
    const claimed = await db.query('UPDATE totp_credential SET last_used_step = $1 WHERE last_used_step < $1', [step]);
    return claimed.rowCount === 1;
  }

  /** Apaga o segredo ativo. Devolve se havia algum. */
  async remove(db: Queryable): Promise<boolean> {
    const removed = await db.query('DELETE FROM totp_credential');
    return (removed.rowCount ?? 0) > 0;
  }

  /** Abre o token de ativação; qualquer defeito (formato, adulteração, validade, segredo) vira `TOTP_SETUP_EXPIRED`. */
  private openEnrollmentToken(token: string, now: Date): string {
    try {
      const payload = JSON.parse(openSecret(this.masterKey, ENROLLMENT_PURPOSE, token)) as Partial<EnrollmentPayload>;
      if (typeof payload.secret === 'string' && typeof payload.expiresAt === 'number' && payload.expiresAt > now.getTime()) {
        if (base32Decode(payload.secret)?.length === SECRET_BYTES) return payload.secret;
      }
    } catch {
      // Formato inválido, adulterado ou de outra chave mestra: tratado abaixo como ativação expirada.
    }
    throw new DomainError('TOTP_SETUP_EXPIRED');
  }
}
