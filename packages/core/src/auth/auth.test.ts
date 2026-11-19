// Prova do serviço de autenticação (A1) contra PostgreSQL real e relógio controlado.
// Cada teste percorre uma jornada completa e confere os efeitos observáveis: respostas, banco e auditoria.
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { migrateTestDatabase } from '../testing/migrate';
import { createPool, type Pool } from '../db/pool';
import { DomainError } from '../errors';
import { createLogger } from '../logging';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { createCredentialVerifier } from './credentials';
import {
  AuthService,
  LOGIN_IP_LOCK_MS,
  SESSION_RENEW_AFTER_MS,
  SESSION_TTL_MS,
  type LoginInput,
} from './service';

const OWNER = { email: 'dono@aion.test', password: 'senha-de-teste-do-dono-1' };
const MASTER_KEY = Buffer.alloc(32, 7);
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let database: TestDatabase;
let pool: Pool;
let now = new Date('2026-03-01T12:00:00Z');
const logLines: string[] = [];

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

async function newService(credentials = OWNER): Promise<AuthService> {
  const verifier = await createCredentialVerifier(credentials, MASTER_KEY);
  const logger = createLogger({ level: 'debug', name: 'test', destination: { write: (line) => void logLines.push(line) } });
  return new AuthService({ pool, verifier, masterKey: MASTER_KEY, logger, now: () => now });
}

const attempt = (overrides: Partial<LoginInput> = {}): LoginInput => ({
  email: OWNER.email,
  password: OWNER.password,
  ip: '203.0.113.10',
  userAgent: CHROME_WINDOWS,
  ...overrides,
});

/** Login que tem de criar sessão (sem TOTP ativo): estreita o resultado para a sessão criada. */
const signIn = async (auth: AuthService, input: LoginInput) => {
  const result = await auth.login(input);
  if (result.status !== 'authenticated') throw new Error('esperava sessão criada, veio desafio TOTP');
  return result;
};

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `UNEXPECTED:${String(error)}`;
  }
};

const auditActions = async (): Promise<string[]> =>
  (await pool.query<{ action: string; outcome: string }>('SELECT action, outcome FROM audit_log ORDER BY id')).rows.map(
    (row) => `${row.action}:${row.outcome}`,
  );

beforeAll(async () => {
  database = await createTestDatabase(inject('adminDatabaseUrl'));
  pool = createPool(database.url, { applicationName: 'auth-test', max: 5 });
  await migrateTestDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await database.drop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE conversation_presence, sessions, login_failures, login_locks, audit_log, app_state');
  now = new Date('2026-03-01T12:00:00Z');
  logLines.length = 0;
});

describe('sessão do dono', () => {
  it('login → sessão com token só em hash → CSRF por sessão → lista por dispositivo → logout revoga no servidor', async () => {
    const auth = await newService();

    // E-mail com caixa e espaços diferentes ainda entra; a sessão nasce com token opaco.
    const { token, sessionId } = await signIn(auth, attempt({ email: `  ${OWNER.email.toUpperCase()} ` }));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // O banco guarda o hash do token, nunca o token.
    const stored = await pool.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE id = $1', [sessionId]);
    expect(stored.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.token_hash).not.toBe(token);

    // A sessão autentica e o token CSRF é estável por sessão, mas diferente entre sessões.
    expect(await auth.authenticate(token)).toEqual({ sessionId, ownerEmail: OWNER.email });
    const second = await signIn(auth, attempt({ ip: '203.0.113.11', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15' }));
    expect(auth.csrfTokenFor(sessionId)).toBe(auth.csrfTokenFor(sessionId));
    expect(auth.csrfTokenFor(sessionId)).not.toBe(auth.csrfTokenFor(second.sessionId));
    expect(auth.isCsrfTokenValid(sessionId, auth.csrfTokenFor(sessionId))).toBe(true);
    expect(auth.isCsrfTokenValid(sessionId, auth.csrfTokenFor(second.sessionId))).toBe(false);
    expect(auth.isCsrfTokenValid(sessionId, undefined)).toBe(false);

    // A lista mostra um dispositivo por sessão e marca a atual.
    const sessions = await auth.listSessions(sessionId);
    expect(sessions.map((s) => [s.device, s.current])).toEqual(
      expect.arrayContaining([
        ['Chrome no Windows', true],
        ['Safari no macOS', false],
      ]),
    );

    // Encerrar outro dispositivo revoga só ele; sair revoga a atual. Token revogado deixa de valer.
    await auth.revokeSession(second.sessionId, attempt());
    expect(await auth.authenticate(second.token)).toBeNull();
    expect(await auth.authenticate(token)).not.toBeNull();
    await auth.logout(sessionId, attempt());
    expect(await auth.authenticate(token)).toBeNull();
    expect(await code(auth.logout(sessionId, attempt()))).toBe('AUTH_SESSION_NOT_FOUND');

    expect(await auditActions()).toEqual([
      'auth.login:success',
      'auth.login:success',
      'auth.session_revoked:success',
      'auth.logout:success',
    ]);
  });

  it('renova pelo uso, expira após 30 dias parada e recusa token malformado', async () => {
    const auth = await newService();
    const { token, sessionId } = await signIn(auth, attempt());
    const expiry = async () =>
      (await pool.query<{ expires_at: Date }>('SELECT expires_at FROM sessions WHERE id = $1', [sessionId])).rows[0]!.expires_at;
    const initialExpiry = await expiry();

    // Uso logo em seguida não escreve; depois do intervalo de renovação, a validade escorrega para frente.
    advance(SESSION_RENEW_AFTER_MS - 1000);
    await auth.authenticate(token);
    expect((await expiry()).getTime()).toBe(initialExpiry.getTime());
    advance(2000);
    await auth.authenticate(token);
    expect((await expiry()).getTime()).toBe(now.getTime() + SESSION_TTL_MS);

    // Parada por mais de 30 dias: expira. Formato inválido nem chega ao banco.
    advance(SESSION_TTL_MS + 1000);
    expect(await auth.authenticate(token)).toBeNull();
    expect(await auth.authenticate('curto')).toBeNull();
    expect(await auth.authenticate('a'.repeat(43))).toBeNull();
  });
});

describe('bloqueio de tentativas (AUTH-04)', () => {
  it('5 falhas seguidas bloqueiam o IP por 15 min mesmo com a senha certa, sem afetar outro IP, e liberam depois', async () => {
    const auth = await newService();
    const wrong = attempt({ password: 'senha-errada-qualquer' });

    // Cinco falhas seguidas: todas respondem "credenciais inválidas" (mesma mensagem para e-mail ou senha errados).
    for (let i = 0; i < 5; i += 1) {
      expect(await code(auth.login(wrong))).toBe('AUTH_INVALID_CREDENTIALS');
    }
    expect(await code(auth.login(attempt({ email: 'outro@aion.test', password: 'senha-errada-qualquer' })))).toBe('AUTH_LOCKED');

    // Bloqueado: até a senha certa é recusada, com o tempo de espera informado.
    let retry: number | undefined;
    try {
      await auth.login(attempt());
    } catch (error) {
      retry = (error as DomainError).retryAfterSeconds;
      expect((error as DomainError).code).toBe('AUTH_LOCKED');
    }
    expect(retry).toBeGreaterThan(14 * 60);
    expect(retry).toBeLessThanOrEqual(15 * 60);

    // Outro IP não é afetado.
    expect(await code(auth.login(attempt({ ip: '198.51.100.7' })))).toBe('OK');

    // Passados os 15 min, o IP volta a poder entrar.
    advance(LOGIN_IP_LOCK_MS + 1000);
    expect(await code(auth.login(attempt()))).toBe('OK');

    const actions = await auditActions();
    expect(actions.filter((a) => a === 'auth.login:failure')).toHaveLength(5);
    expect(actions).toContain('auth.lockout:denied');
  });

  it('login correto zera a sequência de falhas do IP', async () => {
    const auth = await newService();
    for (let i = 0; i < 4; i += 1) await code(auth.login(attempt({ password: 'senha-errada-qualquer' })));
    expect(await code(auth.login(attempt()))).toBe('OK');
    // Mais quatro falhas ainda não bloqueiam, porque a sequência recomeçou.
    for (let i = 0; i < 4; i += 1) expect(await code(auth.login(attempt({ password: 'senha-errada-qualquer' })))).toBe('AUTH_INVALID_CREDENTIALS');
    expect(await code(auth.login(attempt()))).toBe('OK');
  });

  it('rajada paralela do mesmo IP é serializada: só 5 palpites chegam a ser avaliados', async () => {
    const auth = await newService();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => code(auth.login(attempt({ password: 'senha-errada-qualquer' })))),
    );
    expect(results.filter((r) => r === 'AUTH_INVALID_CREDENTIALS')).toHaveLength(5);
    expect(results.filter((r) => r === 'AUTH_LOCKED')).toHaveLength(7);
    const failures = await pool.query('SELECT 1 FROM login_failures');
    expect(failures.rowCount).toBe(5);
  });

  it('20 falhas em 1 hora, de IPs diferentes, travam o login de todos até a janela correr', async () => {
    const auth = await newService();
    for (let i = 0; i < 20; i += 1) {
      await auth.login(attempt({ ip: `192.0.2.${i + 1}`, password: 'senha-errada-qualquer' })).catch(() => undefined);
      advance(60_000);
    }
    // Um IP novo, com a senha certa, é recusado pelo limite global.
    expect(await code(auth.login(attempt({ ip: '198.51.100.99' })))).toBe('AUTH_LOCKED');
    expect(await auditActions()).toContain('auth.global_limit:denied');

    // Depois de uma hora da primeira falha, o limite cai.
    advance(60 * 60_000);
    expect(await code(auth.login(attempt({ ip: '198.51.100.99' })))).toBe('OK');
  });
});

describe('troca de credencial no ambiente', () => {
  it('reiniciar com senha nova revoga todas as sessões; reiniciar com a mesma preserva', async () => {
    const before = await newService();
    await before.syncCredentialFingerprint(); // primeira subida: só grava a impressão
    const { token } = await signIn(before, attempt());
    await before.login(attempt({ ip: '203.0.113.20' }));
    expect(await before.authenticate(token)).not.toBeNull();

    // Reinício com as mesmas credenciais: sessões seguem valendo e nada é auditado.
    const same = await newService();
    expect(await same.syncCredentialFingerprint()).toEqual({ revokedSessions: 0 });
    expect(await same.authenticate(token)).not.toBeNull();

    // Reinício com a senha trocada: todas as sessões somem e a troca fica auditada, sem segredos.
    const changed = await newService({ ...OWNER, password: 'outra-senha-de-teste-2' });
    expect(await changed.syncCredentialFingerprint()).toEqual({ revokedSessions: 2 });
    expect(await changed.authenticate(token)).toBeNull();
    const audit = await pool.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit_log WHERE action = 'auth.credentials_changed'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.details).toEqual({ revokedSessions: 2 });

    // A senha antiga já não entra e a nova entra.
    expect(await code(changed.login(attempt()))).toBe('AUTH_INVALID_CREDENTIALS');
    expect(await code(changed.login(attempt({ password: 'outra-senha-de-teste-2', ip: '203.0.113.30' })))).toBe('OK');
  });
});

describe('segredos fora de logs e auditoria', () => {
  it('nem senha, nem e-mail digitado, nem token aparecem na trilha ou nos logs', async () => {
    const auth = await newService();
    await auth.syncCredentialFingerprint();
    const typedEmail = 'digitado-por-engano@aion.test';
    await code(auth.login(attempt({ email: typedEmail, password: 'senha-digitada-errada-9' })));
    const { token } = await signIn(auth, attempt());

    const trail = JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows);
    const logs = logLines.join('\n');
    for (const secret of [OWNER.password, 'senha-digitada-errada-9', typedEmail, token, MASTER_KEY.toString('hex')]) {
      expect(trail).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
  });
});
