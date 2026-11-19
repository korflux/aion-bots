// Serviço de autenticação do dono (F1 e F2): login (com TOTP opcional), sessões, bloqueio de força bruta, CSRF e
// revogação por troca de credencial. É a única fonte das regras de A1 e A2; a API só traduz HTTP <-> chamadas
// deste serviço.
//
// Decisões:
// - Sessão = token aleatório de 256 bits no cookie; no banco fica só o SHA-256 (um vazamento do banco não
//   permite se passar pelo dono). Validade de 30 dias renovada pelo uso (AUTH-03), aplicada no servidor.
// - Bloqueio (AUTH-04): 5 falhas seguidas do mesmo IP em 15 min bloqueiam o IP por 15 min; 20 falhas em 1 h no
//   sistema todo exigem aguardar. O estado fica no PostgreSQL, então sobrevive a reinícios.
// - Tentativas de login são serializadas: sem isso, uma rajada paralela faria N palpites antes de a primeira
//   falha ser gravada. ponytail: serialização em processo, com mais de uma instância da API trocar por advisory
//   lock no banco.
// - TOTP (A2): com o autenticador ativo, a senha correta NÃO cria sessão: devolve um desafio assinado (HMAC, 5 min,
//   preso à impressão da credencial) e a sessão só nasce com um código válido. Todo palpite de código passa pelo
//   MESMO controle da senha (fila serial, bloqueio por IP de 15 min, limite global, AUTH-04), inclusive os de
//   ativar e desativar em Conta. A senha correta não zera a sequência de falhas quando há TOTP: senão quem sabe a
//   senha trocaria de desafio a cada 4 palpites e nunca seria bloqueado. Só o login completo a zera.
// - Toda decisão relevante gera auditoria, sem nunca gravar senha, e-mail digitado, código, segredo ou token.
import { randomBytes } from 'node:crypto';
import { TOTP_CHALLENGE_TTL_SECONDS, type SessionSummary, type TotpSetupResponse } from '@aion/shared';
import { recordAudit, type AuditActor } from '../audit';
import { deriveKey, hmacBase64Url, safeEqualStrings, sha256Hex } from '../crypto/keys';
import { withTransaction, type Pool } from '../db/pool';
import { DomainError } from '../errors';
import type { Logger } from '../logging';
import type { CredentialVerifier } from './credentials';
import { describeDevice } from './device';
import { TotpService } from './totp-service';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Duração da sessão, renovada pelo uso. */
export const SESSION_TTL_MS = 30 * DAY_MS;
/** A renovação só grava no banco se a última usada tiver mais que isto, para não escrever a cada requisição. */
export const SESSION_RENEW_AFTER_MS = 5 * MINUTE_MS;
export const LOGIN_IP_MAX_FAILURES = 5;
export const LOGIN_IP_WINDOW_MS = 15 * MINUTE_MS;
export const LOGIN_IP_LOCK_MS = 15 * MINUTE_MS;
export const LOGIN_GLOBAL_MAX_FAILURES = 20;
export const LOGIN_GLOBAL_WINDOW_MS = HOUR_MS;
/** Tentativas de login aguardando a vez além disto são recusadas na hora (evita fila infinita sob ataque). */
const MAX_QUEUED_LOGIN_ATTEMPTS = 20;

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Origem da requisição, usada só para auditoria e bloqueio por IP. */
export interface RequestOrigin {
  ip: string;
  userAgent: string;
}

export interface LoginInput extends RequestOrigin {
  email: string;
  password: string;
}

/** Sessão recém-criada. */
export interface SessionGrant {
  /** Token opaco para o cookie. Só existe em memória aqui; o banco guarda o hash. */
  token: string;
  sessionId: string;
}

/** Resultado do login: sessão criada ou, com TOTP ativo, o desafio a ser respondido com o código. */
export type LoginResult =
  | ({ status: 'authenticated' } & SessionGrant)
  | { status: 'totp_required'; challenge: string };

export interface TotpLoginInput extends RequestOrigin {
  /** Token do cookie do desafio emitido pelo login. */
  challenge: string;
  code: string;
}

export interface TotpEnableInput extends RequestOrigin {
  enrollmentToken: string;
  code: string;
}

export interface TotpDisableInput extends RequestOrigin {
  code: string;
}

export interface AuthContext {
  sessionId: string;
  ownerEmail: string;
}

export interface AuthServiceOptions {
  pool: Pool;
  verifier: CredentialVerifier;
  masterKey: Buffer;
  logger: Logger;
  /** Relógio injetável: os testes avançam o tempo sem esperar. */
  now?: () => Date;
}

/** Fila que executa uma tarefa por vez, em ordem, e recusa quando há gente demais esperando. */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly maxPending: number;

  constructor(maxPending: number) {
    this.maxPending = maxPending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maxPending) {
      return Promise.reject(new DomainError('AUTH_LOCKED', { retryAfterSeconds: 5 }));
    }
    this.pending += 1;
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      this.pending -= 1;
    });
    return result;
  }
}

const countOf = (result: { rows: { n: number }[] }): number => result.rows[0]?.n ?? 0;
const secondsUntil = (target: Date, now: Date): number => Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));

export class AuthService {
  private readonly pool: Pool;
  private readonly verifier: CredentialVerifier;
  private readonly csrfKey: Buffer;
  private readonly challengeKey: Buffer;
  private readonly totp: TotpService;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly loginAttempts = new SerialQueue(MAX_QUEUED_LOGIN_ATTEMPTS);

  constructor({ pool, verifier, masterKey, logger, now = () => new Date() }: AuthServiceOptions) {
    this.pool = pool;
    this.verifier = verifier;
    this.csrfKey = deriveKey(masterKey, 'csrf');
    this.challengeKey = deriveKey(masterKey, 'totp-challenge');
    this.totp = new TotpService(masterKey);
    this.logger = logger;
    this.now = now;
  }

  get ownerEmail(): string {
    return this.verifier.email;
  }

  // ---------------------------------------------------------------------------------------------
  // Login e bloqueio de tentativas
  // ---------------------------------------------------------------------------------------------

  /**
   * Valida a credencial. Sem TOTP ativo cria a sessão; com TOTP ativo devolve o desafio (`totp_required`) e a
   * sessão só nasce em `completeTotpLogin`. Lança AUTH_LOCKED ou AUTH_INVALID_CREDENTIALS.
   */
  login(input: LoginInput): Promise<LoginResult> {
    return this.loginAttempts.run(() => this.loginSerialized(input));
  }

  private async loginSerialized({ email, password, ip, userAgent }: LoginInput): Promise<LoginResult> {
    const now = this.now();
    await this.prepareAttempt(ip, now);

    if (!(await this.verifier.verify(email, password))) {
      await this.recordFailure({ ip, userAgent }, now, { action: 'auth.login', actor: 'anonymous', step: 'password' });
      throw new DomainError('AUTH_INVALID_CREDENTIALS');
    }
    if (await this.totp.isEnabled(this.pool)) {
      await recordAudit(this.pool, { action: 'auth.totp_challenge', outcome: 'success', actor: 'anonymous', ip, userAgent }, now);
      return { status: 'totp_required', challenge: this.issueTotpChallenge(now) };
    }
    return { status: 'authenticated', ...(await this.createSession({ ip, userAgent }, now)) };
  }

  /** Limpeza do que venceu e recusa imediata se o IP ou o sistema estiverem bloqueados (AUTH-04). */
  private async prepareAttempt(ip: string, now: Date): Promise<void> {
    await this.pruneExpired(now);
    const globalWait = await this.globalLockSeconds(now);
    if (globalWait !== null) throw new DomainError('AUTH_LOCKED', { retryAfterSeconds: globalWait });
    const ipWait = await this.ipLockSeconds(ip, now);
    if (ipWait !== null) throw new DomainError('AUTH_LOCKED', { retryAfterSeconds: ipWait });
  }

  /** Limpa o que já venceu: falhas fora da janela global, bloqueios expirados e sessões vencidas. */
  private async pruneExpired(now: Date): Promise<void> {
    await this.pool.query('DELETE FROM login_failures WHERE at < $1', [new Date(now.getTime() - LOGIN_GLOBAL_WINDOW_MS)]);
    await this.pool.query('DELETE FROM login_locks WHERE locked_until < $1', [now]);
    await this.pool.query('DELETE FROM sessions WHERE expires_at < $1', [now]);
  }

  /** Segundos até o limite global (20 falhas/hora) liberar, ou null se não está ativo. */
  private async globalLockSeconds(now: Date): Promise<number | null> {
    const since = new Date(now.getTime() - LOGIN_GLOBAL_WINDOW_MS);
    const count = countOf(
      await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM login_failures WHERE at > $1', [since]),
    );
    if (count < LOGIN_GLOBAL_MAX_FAILURES) return null;
    // Libera quando a falha mais antiga necessária sair da janela (a partir dela o total volta a 19).
    const oldest = await this.pool.query<{ at: Date }>(
      'SELECT at FROM login_failures WHERE at > $1 ORDER BY at ASC OFFSET $2 LIMIT 1',
      [since, count - LOGIN_GLOBAL_MAX_FAILURES],
    );
    const releaseAt = new Date((oldest.rows[0]?.at ?? now).getTime() + LOGIN_GLOBAL_WINDOW_MS);
    return secondsUntil(releaseAt, now);
  }

  /** Segundos até o bloqueio deste IP acabar, ou null se o IP não está bloqueado. */
  private async ipLockSeconds(ip: string, now: Date): Promise<number | null> {
    const lock = await this.pool.query<{ locked_until: Date }>(
      'SELECT locked_until FROM login_locks WHERE ip = $1 AND locked_until > $2',
      [ip, now],
    );
    const row = lock.rows[0];
    return row ? secondsUntil(row.locked_until, now) : null;
  }

  /**
   * Registra a falha (de senha, de código do login ou de código em Conta), bloqueia o IP na quinta seguida e
   * sinaliza o limite global na vigésima. Todas somam nos MESMOS contadores (AUTH-04).
   */
  private async recordFailure(
    { ip, userAgent }: RequestOrigin,
    now: Date,
    { action, actor, step }: { action: string; actor: AuditActor; step: string },
  ): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      await tx.query('INSERT INTO login_failures (ip, at) VALUES ($1, $2)', [ip, now]);
      await recordAudit(tx, { action, outcome: 'failure', actor, ip, userAgent, details: { step } }, now);

      const streak = countOf(
        await tx.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM login_failures WHERE ip = $1 AND streak_open AND at > $2',
          [ip, new Date(now.getTime() - LOGIN_IP_WINDOW_MS)],
        ),
      );
      if (streak >= LOGIN_IP_MAX_FAILURES) {
        await tx.query(
          `INSERT INTO login_locks (ip, locked_until) VALUES ($1, $2)
           ON CONFLICT (ip) DO UPDATE SET locked_until = EXCLUDED.locked_until`,
          [ip, new Date(now.getTime() + LOGIN_IP_LOCK_MS)],
        );
        await tx.query('UPDATE login_failures SET streak_open = false WHERE ip = $1 AND streak_open', [ip]);
        await recordAudit(
          tx,
          { action: 'auth.lockout', outcome: 'denied', actor: 'anonymous', ip, userAgent, details: { minutes: 15 } },
          now,
        );
      }

      const global = countOf(
        await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM login_failures WHERE at > $1', [
          new Date(now.getTime() - LOGIN_GLOBAL_WINDOW_MS),
        ]),
      );
      if (global === LOGIN_GLOBAL_MAX_FAILURES) {
        await recordAudit(tx, { action: 'auth.global_limit', outcome: 'denied', actor: 'system', details: { perHour: global } }, now);
      }
    });
  }

  private async createSession(
    { ip, userAgent }: RequestOrigin,
    now: Date,
    details?: Record<string, boolean>,
  ): Promise<SessionGrant> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const sessionId = await withTransaction(this.pool, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO sessions (token_hash, created_at, last_used_at, expires_at, ip, user_agent)
         VALUES ($1, $2, $2, $3, $4, $5) RETURNING id`,
        [sha256Hex(token), now, expiresAt, ip, userAgent.slice(0, 256)],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error('sessão não foi criada');
      // Login correto encerra a sequência de falhas do IP ("5 falhas seguidas").
      await tx.query('UPDATE login_failures SET streak_open = false WHERE ip = $1 AND streak_open', [ip]);
      await recordAudit(tx, { action: 'auth.login', outcome: 'success', actor: 'owner', ip, userAgent, target: id, details }, now);
      return id;
    });
    return { token, sessionId };
  }

  // ---------------------------------------------------------------------------------------------
  // Autenticador TOTP (A2): segundo passo do login, ativar, desativar e reset por variável
  // ---------------------------------------------------------------------------------------------

  /** O autenticador está ativo? (Conta mostra "Ativar" ou "Desativar".) */
  async totpStatus(): Promise<{ enabled: boolean }> {
    return { enabled: await this.totp.isEnabled(this.pool) };
  }

  /**
   * Segundo passo do login: confere o código contra o desafio emitido pela senha correta e cria a sessão.
   * Lança AUTH_TOTP_EXPIRED (desafio ausente, adulterado, vencido ou sem autenticador ativo; NÃO conta como
   * tentativa), AUTH_TOTP_INVALID (código errado ou já usado; conta no bloqueio) ou AUTH_LOCKED.
   */
  completeTotpLogin({ challenge, code, ip, userAgent }: TotpLoginInput): Promise<SessionGrant> {
    return this.runCodeAttempt({ ip, userAgent }, { action: 'auth.login', actor: 'anonymous', step: 'totp' }, async (now) => {
      if (!this.isTotpChallengeValid(challenge, now) || !(await this.totp.isEnabled(this.pool))) {
        throw new DomainError('AUTH_TOTP_EXPIRED');
      }
      if (!(await this.totp.consume(this.pool, code, now))) return null;
      return this.createSession({ ip, userAgent }, now, { totp: true });
    });
  }

  /**
   * Passo 1 da ativação (F2): segredo novo, URI do QR e token de ativação. Nada é gravado aqui: o segredo só vira
   * ativo em `enableTotp`. Lança TOTP_ALREADY_ENABLED se já há autenticador.
   */
  async beginTotpEnrollment(): Promise<TotpSetupResponse> {
    if (await this.totp.isEnabled(this.pool)) throw new DomainError('TOTP_ALREADY_ENABLED');
    return this.totp.beginEnrollment(this.verifier.email, this.now());
  }

  /** Passo 2 da ativação: o código certo grava o segredo como ativo (cifrado) e audita. */
  enableTotp({ enrollmentToken, code, ip, userAgent }: TotpEnableInput): Promise<void> {
    return this.runCodeAttempt({ ip, userAgent }, { action: 'auth.totp_enable', actor: 'owner', step: 'enable' }, async (now) => {
      if (await this.totp.isEnabled(this.pool)) throw new DomainError('TOTP_ALREADY_ENABLED');
      return withTransaction(this.pool, async (tx) => {
        if (!(await this.totp.confirmEnrollment(tx, enrollmentToken, code, now))) return null;
        await recordAudit(tx, { action: 'auth.totp_enabled', outcome: 'success', actor: 'owner', ip, userAgent }, now);
        return undefined;
      });
    });
  }

  /** Desativar exige um código atual (F2 passo 3); apaga o segredo e audita. */
  disableTotp({ code, ip, userAgent }: TotpDisableInput): Promise<void> {
    return this.runCodeAttempt({ ip, userAgent }, { action: 'auth.totp_disable', actor: 'owner', step: 'disable' }, async (now) => {
      if (!(await this.totp.isEnabled(this.pool))) throw new DomainError('TOTP_NOT_ENABLED');
      return withTransaction(this.pool, async (tx) => {
        if (!(await this.totp.consume(tx, code, now))) return null;
        await this.totp.remove(tx);
        await recordAudit(tx, { action: 'auth.totp_disabled', outcome: 'success', actor: 'owner', ip, userAgent }, now);
        return undefined;
      });
    });
  }

  /**
   * Chamado na inicialização quando `AION_TOTP_RESET=true` (perda do celular, OPS): desativa o autenticador e
   * audita SEMPRE, mesmo que já estivesse desativado, para a aplicação da variável ficar registrada. Não revoga
   * sessões (quem perdeu o celular ainda está logado em outro lugar ou vai entrar só com a senha).
   */
  async resetTotp(): Promise<{ wasEnabled: boolean }> {
    const now = this.now();
    const wasEnabled = await withTransaction(this.pool, async (tx) => {
      const removed = await this.totp.remove(tx);
      await recordAudit(tx, { action: 'auth.totp_reset', outcome: 'success', actor: 'system', details: { wasEnabled: removed } }, now);
      return removed;
    });
    this.logger.warn({ wasEnabled }, 'AION_TOTP_RESET=true: autenticador desativado. Remova a variável depois de recuperar o acesso');
    return { wasEnabled };
  }

  /**
   * Toda tentativa de código passa por aqui, igual à senha: fila serial (sem rajada paralela de palpites),
   * recusa se o IP ou o sistema estão bloqueados e, se `attempt` devolver `null` (código errado), registra a
   * falha nos contadores de AUTH-04 e responde AUTH_TOTP_INVALID. `attempt` lança DomainError para os casos que
   * NÃO são palpite (desafio vencido, já ativo etc.), que portanto não contam como falha.
   */
  private runCodeAttempt<T>(
    origin: RequestOrigin,
    failure: { action: string; actor: AuditActor; step: string },
    attempt: (now: Date) => Promise<T | null>,
  ): Promise<T> {
    return this.loginAttempts.run(async () => {
      const now = this.now();
      await this.prepareAttempt(origin.ip, now);
      const result = await attempt(now);
      if (result === null) {
        await this.recordFailure(origin, now, failure);
        throw new DomainError('AUTH_TOTP_INVALID');
      }
      return result;
    });
  }

  /**
   * Desafio do login: `<validade em base36>.<HMAC>`. Stateless (nada no banco) e preso à impressão da credencial,
   * então trocar a senha no ambiente invalida desafios em aberto. Não distingue forjado de vencido.
   *
   * ponytail: o desafio não é de uso único, o mesmo vale para várias tentativas de código dentro dos 5 min (limitadas
   * por AUTH-04), trocar por linha no banco com consumo se algum dia for preciso invalidá-lo antes do prazo.
   */
  private issueTotpChallenge(now: Date): string {
    const expiry = (now.getTime() + TOTP_CHALLENGE_TTL_SECONDS * 1000).toString(36);
    return `${expiry}.${this.challengeSignature(expiry)}`;
  }

  private isTotpChallengeValid(token: string, now: Date): boolean {
    const [expiry, signature, ...extra] = token.split('.');
    if (!expiry || !signature || extra.length > 0 || !/^[0-9a-z]{1,13}$/.test(expiry)) return false;
    return safeEqualStrings(signature, this.challengeSignature(expiry)) && Number.parseInt(expiry, 36) > now.getTime();
  }

  private challengeSignature(expiry: string): string {
    return hmacBase64Url(this.challengeKey, `${expiry}.${this.verifier.fingerprint}`);
  }

  // ---------------------------------------------------------------------------------------------
  // Sessão corrente
  // ---------------------------------------------------------------------------------------------

  /** Resolve o token do cookie em sessão válida (ou null) e renova a validade se já faz um tempo. */
  async authenticate(token: string): Promise<AuthContext | null> {
    if (!SESSION_TOKEN_PATTERN.test(token)) return null;
    const now = this.now();
    const found = await this.pool.query<{ id: string; last_used_at: Date }>(
      'SELECT id, last_used_at FROM sessions WHERE token_hash = $1 AND expires_at > $2',
      [sha256Hex(token), now],
    );
    const session = found.rows[0];
    if (!session) return null;
    if (now.getTime() - session.last_used_at.getTime() > SESSION_RENEW_AFTER_MS) {
      await this.pool.query('UPDATE sessions SET last_used_at = $2, expires_at = $3 WHERE id = $1', [
        session.id,
        now,
        new Date(now.getTime() + SESSION_TTL_MS),
      ]);
    }
    return { sessionId: session.id, ownerEmail: this.ownerEmail };
  }

  /** Token CSRF vinculado à sessão: HMAC do id da sessão, sem estado extra a guardar. */
  csrfTokenFor(sessionId: string): string {
    return hmacBase64Url(this.csrfKey, sessionId);
  }

  isCsrfTokenValid(sessionId: string, provided: string | undefined): boolean {
    return typeof provided === 'string' && safeEqualStrings(provided, this.csrfTokenFor(sessionId));
  }

  // ---------------------------------------------------------------------------------------------
  // Listagem e revogação
  // ---------------------------------------------------------------------------------------------

  /** Sessões ativas por dispositivo, a mais recente primeiro. */
  async listSessions(currentSessionId: string): Promise<SessionSummary[]> {
    const rows = await this.pool.query<{ id: string; user_agent: string; created_at: Date; last_used_at: Date }>(
      `SELECT id, user_agent, created_at, last_used_at FROM sessions
       WHERE expires_at > $1 ORDER BY last_used_at DESC`,
      [this.now()],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      device: describeDevice(row.user_agent),
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at.toISOString(),
      current: row.id === currentSessionId,
    }));
  }

  /** Sair: revoga a sessão atual no servidor. */
  async logout(sessionId: string, origin: RequestOrigin): Promise<void> {
    await this.deleteSession(sessionId, 'auth.logout', origin);
  }

  /** Encerrar uma sessão listada em Conta (pode ser outro dispositivo). */
  async revokeSession(sessionId: string, origin: RequestOrigin): Promise<void> {
    await this.deleteSession(sessionId, 'auth.session_revoked', origin);
  }

  private async deleteSession(sessionId: string, action: string, origin: RequestOrigin): Promise<void> {
    const deleted = await withTransaction(this.pool, async (tx) => {
      const result = await tx.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      if (result.rowCount === 0) return false;
      await recordAudit(
        tx,
        { action, outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: sessionId },
        this.now(),
      );
      return true;
    });
    if (!deleted) throw new DomainError('AUTH_SESSION_NOT_FOUND');
  }

  // ---------------------------------------------------------------------------------------------
  // Troca de credencial no ambiente
  // ---------------------------------------------------------------------------------------------

  /**
   * Chamado na inicialização: se a impressão da credencial mudou desde o último start, revoga TODAS as
   * sessões (A1: "trocar a senha no ambiente e reiniciar encerra todas as sessões"). Na primeira subida
   * só grava a impressão.
   */
  async syncCredentialFingerprint(): Promise<{ revokedSessions: number }> {
    const now = this.now();
    return withTransaction(this.pool, async (tx) => {
      const stored = await tx.query<{ value: string }>("SELECT value FROM app_state WHERE key = 'credential_fingerprint'");
      const previous = stored.rows[0]?.value;
      if (previous === this.verifier.fingerprint) return { revokedSessions: 0 };

      const revoked = await tx.query('DELETE FROM sessions');
      await tx.query(
        `INSERT INTO app_state (key, value, updated_at) VALUES ('credential_fingerprint', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [this.verifier.fingerprint, now],
      );
      if (previous !== undefined) {
        await recordAudit(
          tx,
          { action: 'auth.credentials_changed', outcome: 'success', actor: 'system', details: { revokedSessions: revoked.rowCount ?? 0 } },
          now,
        );
        this.logger.warn({ revokedSessions: revoked.rowCount ?? 0 }, 'credencial do dono mudou: sessões revogadas');
      }
      return { revokedSessions: revoked.rowCount ?? 0 };
    });
  }
}
