// Migration 0001: base de autenticação (T1).
//
// Tabelas:
// - app_state: chave/valor de estado do app (impressão da credencial do dono).
// - sessions: uma linha por dispositivo; guarda o HASH do token, nunca o token (vazamento do banco não vira sessão).
// - login_failures / login_locks: limite de tentativas por IP e global (AUTH-04), persistente entre reinícios.
// - audit_log: trilha de auditoria sem segredos (quem, o quê, quando, origem).
import type { Migration } from '../migrator';

export const authFoundation: Migration = {
  id: '0001_auth_foundation',
  description: 'Sessões, limite de tentativas de login, auditoria e estado do app',
  up: `
    CREATE TABLE app_state (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL,
      last_used_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      ip text NOT NULL CHECK (char_length(ip) <= 64),
      user_agent text NOT NULL DEFAULT '' CHECK (char_length(user_agent) <= 256)
    );
    CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

    -- streak_open marca falhas ainda contadas na sequência do IP; sucesso ou bloqueio a "fecham",
    -- mas a linha permanece para o limite global de 1 hora.
    CREATE TABLE login_failures (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ip text NOT NULL CHECK (char_length(ip) <= 64),
      at timestamptz NOT NULL,
      streak_open boolean NOT NULL DEFAULT true
    );
    CREATE INDEX login_failures_ip_at_idx ON login_failures (ip, at);
    CREATE INDEX login_failures_at_idx ON login_failures (at);

    CREATE TABLE login_locks (
      ip text PRIMARY KEY CHECK (char_length(ip) <= 64),
      locked_until timestamptz NOT NULL
    );

    CREATE TABLE audit_log (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at timestamptz NOT NULL,
      action text NOT NULL CHECK (char_length(action) <= 100),
      outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
      actor text NOT NULL CHECK (actor IN ('owner', 'system', 'anonymous')),
      ip text CHECK (char_length(ip) <= 64),
      user_agent text CHECK (char_length(user_agent) <= 256),
      target text CHECK (char_length(target) <= 200),
      details jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
  `,
  // Rollback: remove tudo que este arquivo criou (a ordem não importa, não há chaves estrangeiras entre elas).
  rollback: `
    DROP TABLE audit_log;
    DROP TABLE login_locks;
    DROP TABLE login_failures;
    DROP TABLE sessions;
    DROP TABLE app_state;
  `,
};
