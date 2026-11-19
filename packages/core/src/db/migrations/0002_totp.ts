// Migration 0002: autenticador TOTP opcional do dono (T2).
//
// Tabela:
// - totp_credential: o segredo TOTP ATIVO do dono. Existe no máximo uma linha (dono único, TEN-01); a ausência da
//   linha significa "autenticador desativado". O segredo fica cifrado (AES-256-GCM com a chave mestra), nunca em
//   texto. `last_used_step` guarda a última janela de 30 s aceita, para o mesmo código não valer duas vezes
//   (RFC 6238 §5.2). Uma ativação só vira linha depois de o código ser confirmado (F2), então não há segredo
//   "pendente" no banco.
// O desafio do login (senha correta, falta o código) é um token assinado em cookie e não tem tabela.
import type { Migration } from '../migrator';

export const totp: Migration = {
  id: '0002_totp',
  description: 'Segredo TOTP ativo do dono (cifrado) e última janela usada',
  up: `
    CREATE TABLE totp_credential (
      singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
      secret_sealed text NOT NULL,
      last_used_step bigint NOT NULL,
      enabled_at timestamptz NOT NULL
    );
  `,
  // Rollback: remove a tabela. Quem a tinha ativa volta a entrar só com e-mail e senha (o segredo não é recuperável).
  rollback: `
    DROP TABLE totp_credential;
  `,
};
