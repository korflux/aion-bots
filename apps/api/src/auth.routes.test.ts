// Prova de A1 pela borda HTTP: login, sessão, CSRF, listagem e revogação de sessões, bloqueio por IP e
// mensagens de erro. Cada teste percorre uma jornada completa pela API real.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHROME_UA, ORIGIN, OWNER, createTestApi, type TestApi } from './testing/harness';

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api.cleanup();
});

// Cada teste começa sem falhas nem bloqueios acumulados, para o limite global não vazar entre jornadas.
beforeEach(async () => {
  await api.pool.query('TRUNCATE login_failures, login_locks');
});

const wrongLogin = (remoteAddress: string, headers: Record<string, string> = {}) =>
  api.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, ...headers },
    payload: { email: OWNER.email, password: 'senha-errada-qualquer' },
    remoteAddress,
  });

describe('login, sessão e logout pela API', () => {
  it('jornada: entra com cookie seguro, lê a sessão, recusa mutação sem CSRF, encerra outra sessão e sai', async () => {
    // Sem Origin válido o login nem é avaliado.
    for (const origin of [undefined, 'https://evil.example', 'http://aion.test']) {
      const refused = await api.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: origin ? { origin } : {},
        payload: { email: OWNER.email, password: OWNER.password },
        remoteAddress: '203.0.113.60',
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ code: 'CSRF_ORIGIN_INVALID', message: 'Origem da requisição não permitida.' });
    }

    // Login correto: 200, corpo mínimo e cookie HttpOnly + Secure + SameSite=Lax com token opaco.
    const login = await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, 'user-agent': CHROME_UA },
      payload: { email: OWNER.email, password: OWNER.password },
      remoteAddress: '203.0.113.60',
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ status: 'authenticated' });
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/^aion_session=[A-Za-z0-9_-]{43};/);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(setCookie).toContain(attribute);
    const cookie = setCookie.split(';')[0]!;

    // Sessão atual: dono, id público e token CSRF; nunca a senha.
    const session = await api.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    const info = session.json<{ owner: { email: string }; sessionId: string; csrfToken: string }>();
    expect(info.owner.email).toBe(OWNER.email);
    expect(session.body).not.toContain(OWNER.password);

    // Segundo dispositivo, para ter o que encerrar.
    const other = await api.login('203.0.113.61');

    // Mutação com Origin certo mas sem o token CSRF (ou com o token de outra sessão) é recusada.
    const attempt = (headers: Record<string, string>) =>
      api.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${other.sessionId}`, headers: { cookie, origin: ORIGIN, ...headers } });
    const withoutValidToken: Record<string, string>[] = [{}, { 'x-csrf-token': 'invalido' }, { 'x-csrf-token': other.csrfToken }];
    for (const headers of withoutValidToken) {
      const refused = await attempt(headers);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe('CSRF_TOKEN_INVALID');
    }
    // Mesmo com token, Origin errado é recusado.
    const badOrigin = await api.app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${other.sessionId}`,
      headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': info.csrfToken },
    });
    expect(badOrigin.json().code).toBe('CSRF_ORIGIN_INVALID');

    // A lista mostra as duas sessões por dispositivo, marcando a atual.
    const list = await api.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie } });
    const sessions = list.json<{ sessions: { id: string; device: string; current: boolean }[] }>().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.current)?.id).toBe(info.sessionId);
    expect(sessions.every((s) => s.device === 'Chrome no Windows')).toBe(true);

    // Encerrar a outra sessão a revoga no servidor: o cookie dela deixa de valer.
    const revoke = await attempt({ 'x-csrf-token': info.csrfToken });
    expect(revoke.statusCode).toBe(204);
    const revoked = await api.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: other.cookie } });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().code).toBe('AUTH_SESSION_EXPIRED');
    const again = await attempt({ 'x-csrf-token': info.csrfToken });
    expect(again.json().code).toBe('AUTH_SESSION_NOT_FOUND');

    // Id que não é UUID é recusado na borda, sem chegar ao banco.
    const malformed = await api.app.inject({
      method: 'DELETE',
      url: '/api/auth/sessions/nao-e-uuid',
      headers: { cookie, origin: ORIGIN, 'x-csrf-token': info.csrfToken },
    });
    expect(malformed.statusCode).toBe(422);

    // Sair: 204, cookie removido e sessão revogada no servidor.
    const logout = await api.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: ORIGIN, 'x-csrf-token': info.csrfToken },
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toMatch(/aion_session=;/);
    const after = await api.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('erros de login não revelam se foi o e-mail ou a senha, e 5 falhas seguidas bloqueiam o IP com Retry-After', async () => {
    const ip = '198.51.100.20';
    const badEmail = await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: 'outro@aion.test', password: OWNER.password },
      remoteAddress: ip,
    });
    const badPassword = await wrongLogin(ip);
    expect(badEmail.statusCode).toBe(401);
    expect(badEmail.json()).toEqual({ code: 'AUTH_INVALID_CREDENTIALS', message: 'E-mail ou senha incorretos.' });
    expect(badPassword.json()).toEqual(badEmail.json());

    // Já são 2 falhas (e-mail errado e senha errada); mais 2 e a quinta ainda responde como credencial inválida.
    for (let i = 0; i < 2; i += 1) await wrongLogin(ip);
    const fifth = await wrongLogin(ip);
    expect(fifth.statusCode).toBe(401);

    // Bloqueado: até a credencial correta é recusada, com o tempo de espera no cabeçalho.
    const locked = await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: OWNER.email, password: OWNER.password },
      remoteAddress: ip,
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({
      code: 'AUTH_LOCKED',
      message: 'Muitas tentativas. Tente novamente em alguns minutos.',
    });
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(14 * 60);
  });

  it('o IP do bloqueio vem do proxy confiável e não do cabeçalho forjado pelo cliente', async () => {
    const proxy = '10.1.2.3'; // par da conexão numa rede privada = Traefik
    // O cliente muda o X-Forwarded-For a cada tentativa tentando fugir do bloqueio; o IP real (à direita, o
    // que o proxy acrescentou) é sempre o mesmo.
    for (let i = 0; i < 5; i += 1) {
      await wrongLogin(proxy, { 'x-forwarded-for': `198.18.0.${i + 1}, 198.51.100.77` });
    }
    const locked = await wrongLogin(proxy, { 'x-forwarded-for': '198.18.0.99, 198.51.100.77' });
    expect(locked.json().code).toBe('AUTH_LOCKED');
    // Outro cliente real atrás do mesmo proxy não é afetado.
    const other = await wrongLogin(proxy, { 'x-forwarded-for': '198.51.100.78' });
    expect(other.json().code).toBe('AUTH_INVALID_CREDENTIALS');

    // Par que NÃO é proxy confiável (IP público): o cabeçalho é ignorado e vale o IP da conexão.
    for (let i = 0; i < 5; i += 1) {
      await wrongLogin('203.0.113.99', { 'x-forwarded-for': `198.18.1.${i + 1}` });
    }
    expect((await wrongLogin('203.0.113.99', { 'x-forwarded-for': '198.18.1.200' })).json().code).toBe('AUTH_LOCKED');
  });
});
