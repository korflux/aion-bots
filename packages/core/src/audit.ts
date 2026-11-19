// Trilha de auditoria: quem fez, o que, quando e de onde. Nunca guarda segredos.
//
// `details` só aceita valores primitivos rasos de propósito: sem objetos aninhados fica difícil gravar por
// engano uma requisição inteira (com senha ou token) na trilha. Chaves de terceiros, quando existirem
// (T3), entram apenas mascaradas pelo chamador.
import type { Queryable } from './db/pool';

export type AuditOutcome = 'success' | 'failure' | 'denied';
export type AuditActor = 'owner' | 'system' | 'anonymous';

export interface AuditEvent {
  /** Ação no formato `dominio.acao`, ex.: `auth.login`. */
  action: string;
  outcome: AuditOutcome;
  actor: AuditActor;
  ip?: string | null;
  userAgent?: string | null;
  /** Recurso afetado (ex.: id público de uma sessão). */
  target?: string | null;
  details?: Record<string, string | number | boolean | null>;
}

const USER_AGENT_MAX = 256;

/** Grava um evento de auditoria. Aceita o pool ou um cliente de transação, para auditar junto da mudança. */
export async function recordAudit(db: Queryable, event: AuditEvent, at: Date): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (at, action, outcome, actor, ip, user_agent, target, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      at,
      event.action,
      event.outcome,
      event.actor,
      event.ip ?? null,
      event.userAgent === undefined || event.userAgent === null ? null : event.userAgent.slice(0, USER_AGENT_MAX),
      event.target ?? null,
      JSON.stringify(event.details ?? {}),
    ],
  );
}
