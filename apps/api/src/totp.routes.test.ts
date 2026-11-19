// Prova de A2 pela borda HTTP, na API real sobre PostgreSQL: ativar e desativar em Conta (sessão + CSRF), o login
// em dois passos com o cookie do desafio, o envelope de erro, o bloqueio por IP e o reset por variável na
// subida. O relógio do teste é controlado só no `Date` (vi.useFakeTimers com toFake), porque o TOTP anda de 30
// em 30 segundos e o mesmo código não pode valer duas vezes: sem isso a jornada esperaria tempo real.
import { totpCodeForStep, totpStepAt } from '@aion/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from './bootstrap';
import { CHROME_UA, ORIGIN, OWNER, createTestApi, type TestApi } from './testing/harness';

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api.cleanup();
});

beforeEach(async () => {
  await api.pool.query('TRUNCATE login_failures, login_locks, totp_credential, audit_log');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-01T12:00:10Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const codeFor = (secret: string, windowsAhead = 0) => totpCodeForStep(secret, totpStepAt(new Date()) + windowsAhead);

interface CallOptions {
  cookie?: string;
  csrfToken?: string;
  body?: unknown;
  ip?: string;
  origin?: string | null;
}

/** Requisição à API como o navegador faria: Origin da web, cookie de sessão e token CSRF quando informados. */
function call(method: 'GET' | 'POST', url: string, { cookie, csrfToken, body, ip = '203.0.113.150', origin = ORIGIN }: CallOptions = {}) {
  const headers: Record<string, string> = { 'user-agent': CHROME_UA };
  if (origin !== null) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  return api.app.inject({ method, url, headers, payload: body as object | undefined, remoteAddress: ip });
}

/** Valor de um cookie definido pela resposta (ou undefined). */
const cookieValue = (response: { cookies: { name: string; value: string }[] }, name: string) =>
  response.cookies.find((cookie) => cookie.name === name)?.value;

/** Linhas `Set-Cookie` da resposta, sempre como lista. */
const setCookies = (response: { headers: Record<string, unknown> }): string[] => {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
};

describe('autenticador TOTP pela API', () => {
  it('jornada: ativar em Conta, entrar em dois passos com o cookie do desafio, erros no envelope e desativar', async () => {
    const owner = await api.login('203.0.113.151');
    const authed = { cookie: owner.cookie, csrfToken: owner.csrfToken, ip: '203.0.113.151' };

    // Sem sessão, toda rota de gestão do TOTP é recusada; com sessão mas sem o token CSRF, também.
    for (const [method, url] of [
      ['GET', '/api/auth/totp'],
      ['POST', '/api/auth/totp/setup'],
      ['POST', '/api/auth/totp/enable'],
      ['POST', '/api/auth/totp/disable'],
    ] as const) {
      const anonymous = await call(method, url);
      expect(anonymous.statusCode, `${method} ${url}`).toBe(401);
      expect(anonymous.json().code).toBe('AUTH_SESSION_EXPIRED');
    }
    const noCsrf = await call('POST', '/api/auth/totp/setup', { cookie: owner.cookie });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe('CSRF_TOKEN_INVALID');

    // Estado inicial e abertura da ativação: segredo, URI e token, sem cache e sem nada gravado.
    expect((await call('GET', '/api/auth/totp', authed)).json()).toEqual({ enabled: false });
    const setupResponse = await call('POST', '/api/auth/totp/setup', authed);
    expect(setupResponse.statusCode).toBe(200);
    expect(setupResponse.headers['cache-control']).toBe('no-store');
    const setup = setupResponse.json<{ secret: string; otpauthUri: string; enrollmentToken: string }>();
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);
    expect((await api.pool.query('SELECT 1 FROM totp_credential')).rowCount).toBe(0);

    // Corpo inválido é recusado na borda (campo extra, código malformado, token ausente); código errado é 401.
    for (const body of [
      { enrollmentToken: setup.enrollmentToken, code: codeFor(setup.secret), admin: true },
      { enrollmentToken: setup.enrollmentToken, code: '12345' },
      { code: codeFor(setup.secret) },
    ]) {
      expect((await call('POST', '/api/auth/totp/enable', { ...authed, body })).statusCode).toBe(422);
    }
    const wrong = await call('POST', '/api/auth/totp/enable', {
      ...authed,
      body: { enrollmentToken: setup.enrollmentToken, code: '000000' === codeFor(setup.secret) ? '000001' : '000000' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ code: 'AUTH_TOTP_INVALID', message: 'Código inválido.' });
    expect((await call('GET', '/api/auth/totp', authed)).json()).toEqual({ enabled: false });
    const garbage = await call('POST', '/api/auth/totp/enable', {
      ...authed,
      body: { enrollmentToken: 'lixo', code: codeFor(setup.secret) },
    });
    expect(garbage.statusCode).toBe(410);
    expect(garbage.json().code).toBe('TOTP_SETUP_EXPIRED');

    // Código certo: 204, estado ativo, e o segredo nunca mais volta (nem a ativação se repete).
    const enabled = await call('POST', '/api/auth/totp/enable', {
      ...authed,
      body: { enrollmentToken: setup.enrollmentToken, code: codeFor(setup.secret) },
    });
    expect(enabled.statusCode).toBe(204);
    const status = await call('GET', '/api/auth/totp', authed);
    expect(status.json()).toEqual({ enabled: true });
    expect(status.body).not.toContain(setup.secret);
    const again = await call('POST', '/api/auth/totp/setup', authed);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('TOTP_ALREADY_ENABLED');

    // Login, passo 1: só o desafio. Cookie do desafio é HttpOnly, Secure, SameSite=Strict, preso a /api/auth, 5 min.
    const passwordStep = await call('POST', '/api/auth/login', {
      ip: '203.0.113.152',
      body: { email: OWNER.email, password: OWNER.password },
    });
    expect(passwordStep.statusCode).toBe(200);
    expect(passwordStep.json()).toEqual({ status: 'totp_required' });
    const cookies = setCookies(passwordStep);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^aion_totp_challenge=[0-9a-z]+\.[A-Za-z0-9_-]{43};/);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/auth', 'Max-Age=300']) {
      expect(cookies[0]).toContain(attribute);
    }
    const challengeCookie = cookies[0]!.split(';')[0]!;
    // O desafio sozinho não abre nenhuma rota protegida.
    expect((await call('GET', '/api/auth/session', { cookie: challengeCookie })).statusCode).toBe(401);

    // Passo 2: sem cookie (vencido no navegador) é "expirou"; o Origin continua obrigatório; o corpo é estrito.
    const verify = (overrides: CallOptions) =>
      call('POST', '/api/auth/totp/verify', { ip: '203.0.113.152', cookie: challengeCookie, ...overrides });
    const expired = await verify({ cookie: undefined, body: { code: codeFor(setup.secret) } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual({ code: 'AUTH_TOTP_EXPIRED', message: 'O tempo expirou. Entre novamente.' });
    expect((await verify({ origin: null, body: { code: '123456' } })).json().code).toBe('CSRF_ORIGIN_INVALID');
    expect((await verify({ body: { code: '123456', extra: 1 } })).statusCode).toBe(422);
    expect((await verify({ body: { code: '12a456' } })).statusCode).toBe(422);

    // Código errado: 401 no envelope. O código da ativação já foi consumido: também é recusado. Na janela seguinte entra.
    const invalid = await verify({ body: { code: codeFor(setup.secret) } });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ code: 'AUTH_TOTP_INVALID', message: 'Código inválido.' });
    advance(30_000);
    const granted = await verify({ body: { code: codeFor(setup.secret) } });
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toEqual({ status: 'authenticated' });
    const session = setCookies(granted).find((line) => line.startsWith('aion_session='))!;
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(session).toContain(attribute);
    expect(setCookies(granted).find((line) => line.startsWith('aion_totp_challenge='))).toMatch(/^aion_totp_challenge=;/);
    const newSession = `aion_session=${cookieValue(granted, 'aion_session')}`;
    expect((await call('GET', '/api/auth/session', { cookie: newSession })).statusCode).toBe(200);

    // Desativar: sem código certo recusa; com o código da janela nova desativa e o login volta a ser simples.
    const refused = await call('POST', '/api/auth/totp/disable', { ...authed, body: { code: '000000' === codeFor(setup.secret) ? '000001' : '000000' } });
    expect(refused.json().code).toBe('AUTH_TOTP_INVALID');
    advance(30_000);
    const disabled = await call('POST', '/api/auth/totp/disable', { ...authed, body: { code: codeFor(setup.secret) } });
    expect(disabled.statusCode).toBe(204);
    expect((await call('GET', '/api/auth/totp', authed)).json()).toEqual({ enabled: false });
    const direct = await call('POST', '/api/auth/login', { ip: '203.0.113.153', body: { email: OWNER.email, password: OWNER.password } });
    expect(direct.json()).toEqual({ status: 'authenticated' });
    expect((await call('POST', '/api/auth/totp/disable', { ...authed, body: { code: '123456' } })).json().code).toBe('TOTP_NOT_ENABLED');

    // Nem segredo, nem token de ativação, nem desafio, nem códigos foram parar nos logs da API.
    const logs = api.logs.join('\n');
    for (const secret of [setup.secret, setup.enrollmentToken, challengeCookie.split('=')[1]!, newSession.split('=')[1]!]) {
      expect(logs).not.toContain(secret);
    }
  });

  it('5 códigos errados no segundo passo bloqueiam o IP com 429 e Retry-After, até com o código certo', async () => {
    const owner = await api.login('203.0.113.160');
    const authed = { cookie: owner.cookie, csrfToken: owner.csrfToken, ip: '203.0.113.160' };
    const setup = (await call('POST', '/api/auth/totp/setup', authed)).json<{ secret: string; enrollmentToken: string }>();
    await call('POST', '/api/auth/totp/enable', { ...authed, body: { enrollmentToken: setup.enrollmentToken, code: codeFor(setup.secret) } });
    advance(30_000);

    const ip = '198.51.100.160';
    const passwordStep = await call('POST', '/api/auth/login', { ip, body: { email: OWNER.email, password: OWNER.password } });
    const cookie = setCookies(passwordStep)[0]!.split(';')[0]!;
    const wrongCode = codeFor(setup.secret, 5);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await call('POST', '/api/auth/totp/verify', { ip, cookie, body: { code: wrongCode } });
      expect(response.json().code).toBe('AUTH_TOTP_INVALID');
    }
    const locked = await call('POST', '/api/auth/totp/verify', { ip, cookie, body: { code: codeFor(setup.secret) } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ code: 'AUTH_LOCKED', message: 'Muitas tentativas. Tente novamente em alguns minutos.' });
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(14 * 60);
  });
});

describe('reset do autenticador na inicialização (AION_TOTP_RESET)', () => {
  it('reiniciar com AION_TOTP_RESET=true desativa o TOTP e audita; sem a variável nada muda; valor inválido impede a subida', async () => {
    const owner = await api.login('203.0.113.170');
    const authed = { cookie: owner.cookie, csrfToken: owner.csrfToken, ip: '203.0.113.170' };
    const setup = (await call('POST', '/api/auth/totp/setup', authed)).json<{ secret: string; enrollmentToken: string }>();
    await call('POST', '/api/auth/totp/enable', { ...authed, body: { enrollmentToken: setup.enrollmentToken, code: codeFor(setup.secret) } });
    const loginBody = { email: OWNER.email, password: OWNER.password };
    expect((await call('POST', '/api/auth/login', { ip: '203.0.113.171', body: loginBody })).json().status).toBe('totp_required');

    const logs: string[] = [];
    const destination = { logDestination: { write: (line: string) => void logs.push(line) } };
    const login = (runtime: { app: TestApi['app'] }, ip: string) =>
      runtime.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: ORIGIN },
        payload: loginBody,
        remoteAddress: ip,
      });

    // Reinício comum (sem a variável): o autenticador continua ativo e nada é auditado como reset.
    const plain = await createApi(api.env, destination);
    try {
      await plain.app.ready();
      expect((await login(plain, '203.0.113.172')).json().status).toBe('totp_required');
    } finally {
      await plain.close();
    }
    expect((await api.pool.query("SELECT 1 FROM audit_log WHERE action = 'auth.totp_reset'")).rowCount).toBe(0);

    // Reinício com a variável: o segundo passo deixa de existir, a sessão do dono segue valendo e o evento é auditado.
    const reset = await createApi({ ...api.env, AION_TOTP_RESET: 'true' }, destination);
    try {
      await reset.app.ready();
      expect((await login(reset, '203.0.113.173')).json()).toEqual({ status: 'authenticated' });
      expect((await call('GET', '/api/auth/totp', authed)).json()).toEqual({ enabled: false });
    } finally {
      await reset.close();
    }
    const audit = await api.pool.query<{ actor: string; details: Record<string, unknown> }>(
      "SELECT actor, details FROM audit_log WHERE action = 'auth.totp_reset'",
    );
    expect(audit.rows).toEqual([{ actor: 'system', details: { wasEnabled: true } }]);
    expect(logs.join('\n')).not.toContain(setup.secret);

    // Valor que não é true/false: a API não inicia e o erro cita só o nome da variável.
    const invalid = await createApi({ ...api.env, AION_TOTP_RESET: 'talvez' }, destination).then(
      () => null,
      (error: Error) => error,
    );
    expect(invalid?.message).toContain('AION_TOTP_RESET inválida');
    expect(invalid?.message).not.toContain('talvez');
  });
});
