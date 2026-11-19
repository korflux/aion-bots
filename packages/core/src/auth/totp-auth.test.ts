// Prova de A2 no serviço de autenticação contra PostgreSQL real e relógio controlado: ativar só grava depois do
// código certo, o login passa a exigir o código, o desafio expira, o mesmo código não vale duas vezes e todo
// palpite de código entra no bloqueio de AUTH-04. Cada teste percorre uma jornada e confere os efeitos
// observáveis (respostas, banco, auditoria e logs), em vez de um teste por campo.
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { openSecret, sealSecret } from '../crypto/secret-box';
import { migrateTestDatabase } from '../testing/migrate';
import { createPool, type Pool } from '../db/pool';
import { DomainError } from '../errors';
import { createLogger } from '../logging';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { createCredentialVerifier } from './credentials';
import { AuthService, LOGIN_IP_LOCK_MS, type LoginInput, type RequestOrigin } from './service';
import { totpCodeForStep, totpStepAt } from './totp';
import { TOTP_SETUP_TTL_MS, TotpService } from './totp-service';

const OWNER = { email: 'dono@aion.test', password: 'senha-de-teste-do-dono-1' };
const MASTER_KEY = Buffer.alloc(32, 7);
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MINUTE = 60_000;
const WINDOW = 30_000;

let database: TestDatabase;
let pool: Pool;
let now = new Date('2026-03-01T12:00:10Z');
const logLines: string[] = [];

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

async function newService(credentials = OWNER): Promise<AuthService> {
  const verifier = await createCredentialVerifier(credentials, MASTER_KEY);
  const logger = createLogger({ level: 'debug', name: 'test', destination: { write: (line) => void logLines.push(line) } });
  return new AuthService({ pool, verifier, masterKey: MASTER_KEY, logger, now: () => now });
}

const origin = (ip = '203.0.113.10'): RequestOrigin => ({ ip, userAgent: CHROME });
const attempt = (overrides: Partial<LoginInput> = {}): LoginInput => ({
  email: OWNER.email,
  password: OWNER.password,
  ...origin(),
  ...overrides,
});

/** Código correto do segredo no instante atual do relógio do teste (ou deslocado em janelas). */
const codeAt = (secret: string, windowsAhead = 0) => totpCodeForStep(secret, totpStepAt(now) + windowsAhead);

/** Código de 6 dígitos que NÃO é válido em nenhuma janela próxima, para simular um palpite errado. */
function wrongCode(secret: string): string {
  const valid = new Set([-3, -2, -1, 0, 1, 2, 3].map((delta) => codeAt(secret, delta)));
  for (let candidate = 0; ; candidate += 1) {
    const text = String(candidate).padStart(6, '0');
    if (!valid.has(text)) return text;
  }
}

const errorCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `UNEXPECTED:${String(error)}`;
  }
};

const count = async (table: string): Promise<number> =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

const auditActions = async (): Promise<string[]> =>
  (await pool.query<{ action: string; outcome: string }>('SELECT action, outcome FROM audit_log ORDER BY id')).rows.map(
    (row) => `${row.action}:${row.outcome}`,
  );

/** Login de senha que tem de devolver o desafio TOTP. */
async function challengeFor(auth: AuthService, overrides: Partial<LoginInput> = {}): Promise<string> {
  const result = await auth.login(attempt(overrides));
  if (result.status !== 'totp_required') throw new Error('esperava o desafio TOTP');
  return result.challenge;
}

/** Ativa o autenticador pelo serviço, como faz o modal de Conta, e devolve o segredo. */
async function activate(auth: AuthService): Promise<string> {
  const setup = await auth.beginTotpEnrollment();
  await auth.enableTotp({ enrollmentToken: setup.enrollmentToken, code: codeAt(setup.secret), ...origin() });
  return setup.secret;
}

beforeAll(async () => {
  database = await createTestDatabase(inject('adminDatabaseUrl'));
  pool = createPool(database.url, { applicationName: 'totp-test', max: 5 });
  await migrateTestDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await database.drop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE conversation_presence, sessions, login_failures, login_locks, audit_log, app_state, totp_credential');
  now = new Date('2026-03-01T12:00:10Z');
  logLines.length = 0;
});

describe('ativar, entrar com o código e desativar', () => {
  it('jornada: só grava depois do código certo, o login passa a exigir o código, código usado não repete e desativar volta ao login simples', async () => {
    const auth = await newService();
    await auth.syncCredentialFingerprint();

    // Sem autenticador ativo, a senha correta cria a sessão direto.
    expect((await auth.login(attempt())).status).toBe('authenticated');

    // Abrir a ativação entrega segredo, URI e token, mas NÃO grava nada.
    const setup = await auth.beginTotpEnrollment();
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(new URL(setup.otpauthUri).searchParams.get('secret')).toBe(setup.secret);
    expect(await count('totp_credential')).toBe(0);
    expect(await auth.totpStatus()).toEqual({ enabled: false });

    // Código errado: recusado, nada gravado e o login continua sem pedir código.
    expect(
      await errorCode(auth.enableTotp({ enrollmentToken: setup.enrollmentToken, code: wrongCode(setup.secret), ...origin() })),
    ).toBe('AUTH_TOTP_INVALID');
    expect(await count('totp_credential')).toBe(0);
    expect((await auth.login(attempt())).status).toBe('authenticated');

    // Código certo: ativa. O segredo fica cifrado (nunca em texto) e só abre com a chave mestra e a finalidade certas.
    await auth.enableTotp({ enrollmentToken: setup.enrollmentToken, code: codeAt(setup.secret), ...origin() });
    const stored = (await pool.query<{ secret_sealed: string }>('SELECT secret_sealed FROM totp_credential')).rows;
    expect(stored).toHaveLength(1);
    const sealed = stored[0]!.secret_sealed;
    expect(sealed).not.toContain(setup.secret);
    expect(openSecret(MASTER_KEY, 'totp', sealed)).toBe(setup.secret);
    expect(() => openSecret(MASTER_KEY, 'csrf', sealed)).toThrow();
    expect(() => openSecret(Buffer.alloc(32, 1), 'totp', sealed)).toThrow();
    expect(await auth.totpStatus()).toEqual({ enabled: true });
    expect(await errorCode(auth.beginTotpEnrollment())).toBe('TOTP_ALREADY_ENABLED');

    // Agora a senha correta só gera o desafio: nenhuma sessão nova nasce antes do código.
    const sessionsBefore = await count('sessions');
    const challenge = await challengeFor(auth);
    expect(await count('sessions')).toBe(sessionsBefore);

    // O código usado na ativação já foi consumido e não entra no login; na janela seguinte entra.
    expect(await errorCode(auth.completeTotpLogin({ challenge, code: codeAt(setup.secret), ...origin() }))).toBe('AUTH_TOTP_INVALID');
    advance(WINDOW);
    const granted = await auth.completeTotpLogin({ challenge, code: codeAt(setup.secret), ...origin() });
    expect(await auth.authenticate(granted.token)).not.toBeNull();
    expect(await count('sessions')).toBe(sessionsBefore + 1);
    // O mesmo código de novo (mesmo dentro da janela, com o desafio ainda válido) é recusado.
    expect(await errorCode(auth.completeTotpLogin({ challenge, code: codeAt(setup.secret), ...origin() }))).toBe('AUTH_TOTP_INVALID');

    // Desativar exige código atual: errado recusa e mantém; certo desativa e o login volta a ser simples.
    expect(await errorCode(auth.disableTotp({ code: wrongCode(setup.secret), ...origin() }))).toBe('AUTH_TOTP_INVALID');
    expect(await auth.totpStatus()).toEqual({ enabled: true });
    advance(WINDOW);
    await auth.disableTotp({ code: codeAt(setup.secret), ...origin() });
    expect(await auth.totpStatus()).toEqual({ enabled: false });
    expect(await count('totp_credential')).toBe(0);
    expect((await auth.login(attempt())).status).toBe('authenticated');
    expect(await errorCode(auth.disableTotp({ code: '123456', ...origin() }))).toBe('TOTP_NOT_ENABLED');

    // Toda decisão relevante ficou na trilha de auditoria.
    expect(await auditActions()).toEqual([
      'auth.login:success',
      'auth.totp_enable:failure',
      'auth.login:success',
      'auth.totp_enabled:success',
      'auth.totp_challenge:success',
      'auth.login:failure',
      'auth.login:success',
      'auth.login:failure',
      'auth.totp_disable:failure',
      'auth.totp_disabled:success',
      'auth.login:success',
    ]);
    const loginSteps = await pool.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit_log WHERE action = 'auth.login' ORDER BY id",
    );
    expect(loginSteps.rows.map((row) => row.details)).toEqual([
      {},
      {},
      { step: 'totp' },
      { totp: true },
      { step: 'totp' },
      {},
    ]);
  });

  it('a tolerância é de uma janela para cada lado, e um código mais antigo que o último aceito não volta a valer', async () => {
    const auth = await newService();
    const secret = await activate(auth);
    advance(10 * MINUTE);
    const challenge = await challengeFor(auth);
    const login = (windowsAhead: number) =>
      errorCode(auth.completeTotpLogin({ challenge, code: codeAt(secret, windowsAhead), ...origin() }));

    // Duas janelas de distância, para qualquer lado, não valem.
    expect(await login(-2)).toBe('AUTH_TOTP_INVALID');
    expect(await login(2)).toBe('AUTH_TOTP_INVALID');
    // Uma janela à frente vale (relógio do celular adiantado).
    expect(await login(1)).toBe('OK');
    // A atual e a anterior ficaram para trás do último código aceito: recusadas.
    expect(await login(0)).toBe('AUTH_TOTP_INVALID');
    expect(await login(-1)).toBe('AUTH_TOTP_INVALID');

    // Uma janela atrás também vale (relógio atrasado), num segredo que ainda não usou nada mais novo.
    await auth.resetTotp();
    const secondSecret = await activate(auth);
    advance(10 * MINUTE);
    const freshChallenge = await challengeFor(auth);
    await auth.completeTotpLogin({ challenge: freshChallenge, code: codeAt(secondSecret, -1), ...origin() });
  });

  it('o mesmo código enviado duas vezes ao mesmo tempo vale uma só vez', async () => {
    const auth = await newService();
    const secret = await activate(auth);
    advance(WINDOW);
    const challenge = await challengeFor(auth);
    const results = await Promise.all([
      errorCode(auth.completeTotpLogin({ challenge, code: codeAt(secret), ...origin() })),
      errorCode(auth.completeTotpLogin({ challenge, code: codeAt(secret), ...origin() })),
    ]);
    expect(results.sort()).toEqual(['AUTH_TOTP_INVALID', 'OK']);
  });

  it('o consumo é atômico no banco: duas instâncias da API (sem a fila serial do processo) consomem o mesmo código uma só vez', async () => {
    const auth = await newService();
    const secret = await activate(auth);
    advance(WINDOW);
    const service = new TotpService(MASTER_KEY);
    const code = codeAt(secret);
    // Duas conexões já abertas, para as duas leituras acontecerem antes de qualquer gravação (como entre instâncias).
    const [first, second] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const results = await Promise.all([service.consume(first, code, now), service.consume(second, code, now)]);
      expect(results.sort()).toEqual([false, true]);
    } finally {
      first.release();
      second.release();
    }
  });
});

describe('desafio do login', () => {
  it('vale até 5 minutos e não serve adulterado, depois de desativar o TOTP ou de trocar a senha; nada disso conta como tentativa', async () => {
    const auth = await newService();
    const secret = await activate(auth);

    // Um segundo antes de vencer, o código ainda vale.
    advance(WINDOW);
    const early = await challengeFor(auth);
    advance(5 * MINUTE - 1000);
    await auth.completeTotpLogin({ challenge: early, code: codeAt(secret), ...origin() });

    // Passados os 5 minutos o desafio expirou, mesmo com o código certo.
    const late = await challengeFor(auth);
    advance(5 * MINUTE + 1000);
    expect(await errorCode(auth.completeTotpLogin({ challenge: late, code: codeAt(secret), ...origin() }))).toBe('AUTH_TOTP_EXPIRED');

    // Adulteração: assinatura trocada, validade estendida com a assinatura original, lixo e vazio.
    const fresh = await challengeFor(auth);
    const [expiry, signature] = fresh.split('.') as [string, string];
    const longer = (Number.parseInt(expiry, 36) + 24 * 60 * MINUTE).toString(36);
    const tampered = [`${expiry}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`, `${longer}.${signature}`, 'lixo', '', `${expiry}.${signature}.extra`];
    for (const challenge of tampered) {
      expect(await errorCode(auth.completeTotpLogin({ challenge, code: codeAt(secret), ...origin() })), challenge).toBe('AUTH_TOTP_EXPIRED');
    }

    // Desafio emitido antes de o autenticador ser desativado não vira sessão sem código.
    advance(WINDOW);
    await auth.disableTotp({ code: codeAt(secret), ...origin() });
    expect(await errorCode(auth.completeTotpLogin({ challenge: fresh, code: codeAt(secret), ...origin() }))).toBe('AUTH_TOTP_EXPIRED');

    // Trocar a senha no ambiente invalida desafios em aberto (a impressão da credencial entra na assinatura).
    const secondSecret = await activate(auth);
    const beforeChange = await challengeFor(auth);
    advance(WINDOW);
    const changed = await newService({ ...OWNER, password: 'outra-senha-de-teste-2' });
    expect(await errorCode(changed.completeTotpLogin({ challenge: beforeChange, code: codeAt(secondSecret), ...origin() }))).toBe(
      'AUTH_TOTP_EXPIRED',
    );

    // Nenhum desses casos foi palpite de código: o contador de falhas está zerado.
    expect(await count('login_failures')).toBe(0);
  });

  it('o token de ativação só vale se foi gerado pelo servidor, dentro de 15 minutos, e uma única vez', async () => {
    const auth = await newService();
    const setup = await auth.beginTotpEnrollment();
    const good = { code: codeAt(setup.secret), ...origin() };

    // Adulterado, de outra chave mestra, ou o blob do segredo JÁ ATIVO usado no lugar do token: todos recusados.
    const forgedPayload = JSON.stringify({ secret: setup.secret, expiresAt: now.getTime() + MINUTE });
    const rejected = [
      `${setup.enrollmentToken.slice(0, -2)}AA`,
      'lixo',
      sealSecret(Buffer.alloc(32, 1), 'totp-enrollment', forgedPayload),
      sealSecret(MASTER_KEY, 'totp', forgedPayload),
    ];
    for (const enrollmentToken of rejected) {
      expect(await errorCode(auth.enableTotp({ enrollmentToken, ...good })), enrollmentToken).toBe('TOTP_SETUP_EXPIRED');
    }
    expect(await count('totp_credential')).toBe(0);

    // Vencido: mesmo com o código certo da hora.
    advance(TOTP_SETUP_TTL_MS + 1000);
    expect(await errorCode(auth.enableTotp({ enrollmentToken: setup.enrollmentToken, code: codeAt(setup.secret), ...origin() }))).toBe(
      'TOTP_SETUP_EXPIRED',
    );
    expect(await count('totp_credential')).toBe(0);

    // Dentro do prazo ativa uma vez; reaproveitar o mesmo token depois dá "já ativo".
    const valid = await auth.beginTotpEnrollment();
    await auth.enableTotp({ enrollmentToken: valid.enrollmentToken, code: codeAt(valid.secret), ...origin() });
    expect(await errorCode(auth.enableTotp({ enrollmentToken: valid.enrollmentToken, code: codeAt(valid.secret), ...origin() }))).toBe(
      'TOTP_ALREADY_ENABLED',
    );
    expect(await count('login_failures')).toBe(0);
  });
});

describe('bloqueio de tentativas com TOTP (AUTH-04)', () => {
  it('5 códigos errados bloqueiam o IP por 15 min, até com o código certo e com a senha, sem afetar outro IP', async () => {
    const auth = await newService();
    const secret = await activate(auth);
    advance(WINDOW);
    const challenge = await challengeFor(auth);

    for (let i = 0; i < 5; i += 1) {
      expect(await errorCode(auth.completeTotpLogin({ challenge, code: wrongCode(secret), ...origin() }))).toBe('AUTH_TOTP_INVALID');
    }
    // Bloqueado: o código certo e a senha certa são recusados sem serem avaliados.
    expect(await errorCode(auth.completeTotpLogin({ challenge, code: codeAt(secret), ...origin() }))).toBe('AUTH_LOCKED');
    expect(await errorCode(auth.login(attempt()))).toBe('AUTH_LOCKED');
    expect(await auditActions()).toContain('auth.lockout:denied');

    // Outro IP não é afetado e entra com o código certo.
    const otherChallenge = await challengeFor(auth, { ip: '198.51.100.7' });
    const granted = await auth.completeTotpLogin({ challenge: otherChallenge, code: codeAt(secret), ...origin('198.51.100.7') });
    expect(await auth.authenticate(granted.token)).not.toBeNull();

    // Passados os 15 minutos o IP volta a poder tentar (com um desafio novo, o antigo já venceu).
    advance(LOGIN_IP_LOCK_MS + 1000);
    expect(await errorCode(auth.completeTotpLogin({ challenge, code: codeAt(secret), ...origin() }))).toBe('AUTH_TOTP_EXPIRED');
    const again = await challengeFor(auth);
    expect(await errorCode(auth.completeTotpLogin({ challenge: again, code: codeAt(secret), ...origin() }))).toBe('OK');
  });

  it('a senha correta não zera a sequência de falhas enquanto há TOTP: rodar desafios novos não dá palpites infinitos', async () => {
    const auth = await newService();
    const secret = await activate(auth);
    advance(WINDOW);
    const challenge = await challengeFor(auth);
    for (let i = 0; i < 4; i += 1) await errorCode(auth.completeTotpLogin({ challenge, code: wrongCode(secret), ...origin() }));

    // Com a senha certa o atacante ganha um desafio novo, mas a sequência de 4 falhas continua aberta...
    const renewed = await challengeFor(auth);
    // ...então o quinto palpite errado bloqueia de vez.
    expect(await errorCode(auth.completeTotpLogin({ challenge: renewed, code: wrongCode(secret), ...origin() }))).toBe('AUTH_TOTP_INVALID');
    expect(await errorCode(auth.login(attempt()))).toBe('AUTH_LOCKED');
  });

  it('20 palpites errados vindos de IPs diferentes travam o login de todos, inclusive o código certo', async () => {
    const auth = await newService();
    const secret = await activate(auth);
    advance(WINDOW);
    const challenge = await challengeFor(auth);
    for (let i = 0; i < 20; i += 1) {
      await errorCode(auth.completeTotpLogin({ challenge, code: wrongCode(secret), ...origin(`192.0.2.${i + 1}`) }));
      advance(5_000);
    }
    expect(await auditActions()).toContain('auth.global_limit:denied');
    expect(await errorCode(auth.completeTotpLogin({ challenge, code: codeAt(secret), ...origin('198.51.100.99') }))).toBe('AUTH_LOCKED');
  });

  it('códigos errados ao ativar e ao desativar em Conta somam no mesmo bloqueio do IP', async () => {
    const auth = await newService();
    const setup = await auth.beginTotpEnrollment();

    // Três palpites errados ao ativar contam como falhas do IP.
    for (let i = 0; i < 3; i += 1) {
      expect(
        await errorCode(auth.enableTotp({ enrollmentToken: setup.enrollmentToken, code: wrongCode(setup.secret), ...origin() })),
      ).toBe('AUTH_TOTP_INVALID');
    }
    // Ativar com o código certo funciona (e não zera a sequência: só o login completo zera).
    await auth.enableTotp({ enrollmentToken: setup.enrollmentToken, code: codeAt(setup.secret), ...origin() });
    // Tentar ativar de novo não é palpite de código: não conta.
    expect(await errorCode(auth.enableTotp({ enrollmentToken: setup.enrollmentToken, code: '000000', ...origin() }))).toBe(
      'TOTP_ALREADY_ENABLED',
    );
    expect(await count('login_failures')).toBe(3);

    // Mais dois palpites errados ao desativar completam as 5 falhas seguidas: o IP é bloqueado.
    advance(WINDOW);
    for (let i = 0; i < 2; i += 1) {
      expect(await errorCode(auth.disableTotp({ code: wrongCode(setup.secret), ...origin() }))).toBe('AUTH_TOTP_INVALID');
    }
    expect(await errorCode(auth.disableTotp({ code: codeAt(setup.secret), ...origin() }))).toBe('AUTH_LOCKED');
    expect(await errorCode(auth.login(attempt()))).toBe('AUTH_LOCKED');
    expect(await auth.totpStatus()).toEqual({ enabled: true });
  });

  it('uma rajada paralela de palpites é serializada: só 5 chegam a ser avaliados', async () => {
    const auth = await newService();
    const secret = await activate(auth);
    advance(WINDOW);
    const challenge = await challengeFor(auth);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => errorCode(auth.completeTotpLogin({ challenge, code: wrongCode(secret), ...origin() }))),
    );
    expect(results.filter((r) => r === 'AUTH_TOTP_INVALID')).toHaveLength(5);
    expect(results.filter((r) => r === 'AUTH_LOCKED')).toHaveLength(7);
    expect(await count('login_failures')).toBe(5);
  });
});

describe('reset por variável (AION_TOTP_RESET)', () => {
  it('desativa o autenticador, audita sempre (mesmo já desativado) e preserva as sessões', async () => {
    const auth = await newService();
    const secret = await activate(auth);
    advance(WINDOW);
    const granted = await auth.completeTotpLogin({ challenge: await challengeFor(auth), code: codeAt(secret), ...origin() });

    expect(await auth.resetTotp()).toEqual({ wasEnabled: true });
    expect(await count('totp_credential')).toBe(0);
    expect(await auth.totpStatus()).toEqual({ enabled: false });
    expect((await auth.login(attempt())).status).toBe('authenticated');
    expect(await auth.authenticate(granted.token)).not.toBeNull();

    // Segunda aplicação da variável: nada a desativar, mas o evento fica registrado.
    expect(await auth.resetTotp()).toEqual({ wasEnabled: false });
    const audit = await pool.query<{ actor: string; details: Record<string, unknown> }>(
      "SELECT actor, details FROM audit_log WHERE action = 'auth.totp_reset' ORDER BY id",
    );
    expect(audit.rows).toEqual([
      { actor: 'system', details: { wasEnabled: true } },
      { actor: 'system', details: { wasEnabled: false } },
    ]);
    expect(logLines.join('\n')).toContain('AION_TOTP_RESET=true');
  });
});

describe('segredos fora da trilha e dos logs', () => {
  it('nem o segredo, nem o token de ativação, nem o desafio, nem os códigos aparecem na auditoria ou nos logs', async () => {
    const auth = await newService();
    const setup = await auth.beginTotpEnrollment();
    const wrong = wrongCode(setup.secret);
    await errorCode(auth.enableTotp({ enrollmentToken: setup.enrollmentToken, code: wrong, ...origin() }));
    const right = codeAt(setup.secret);
    await auth.enableTotp({ enrollmentToken: setup.enrollmentToken, code: right, ...origin() });
    const challenge = await challengeFor(auth);
    advance(WINDOW);
    const next = codeAt(setup.secret);
    const { token } = await auth.completeTotpLogin({ challenge, code: next, ...origin() });
    const sealed = (await pool.query<{ secret_sealed: string }>('SELECT secret_sealed FROM totp_credential')).rows[0]!.secret_sealed;
    await auth.resetTotp();

    const trail = JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows);
    const logs = logLines.join('\n');
    for (const secret of [setup.secret, sealed, setup.enrollmentToken, challenge, token, wrong, right, next, MASTER_KEY.toString('hex')]) {
      expect(trail).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
  });
});
