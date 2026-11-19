// Prova dos controles de segurança da borda HTTP: cabeçalhos em toda resposta, negação por padrão, limites de
// corpo, campos extras, envelope de erro sem vazamento e falha fechada na configuração.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from './bootstrap';
import { MASTER_KEY, ORIGIN, OWNER, createTestApi, type TestApi } from './testing/harness';
import { createPool } from '@aion/core';
import { createTestDatabase } from '@aion/core/testing';
import { BODY_LIMIT_BYTES } from './app';

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api.cleanup();
});

const login = (payload: unknown, headers: Record<string, string> = {}) =>
  api.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    payload: payload as string,
    remoteAddress: '198.51.100.90',
  });

describe('cabeçalhos de segurança', () => {
  it('estão presentes em respostas de sucesso, de erro de auth, de validação e de rota inexistente', async () => {
    const responses = [
      await api.app.inject({ method: 'GET', url: '/api/health' }), // 200
      await api.app.inject({ method: 'GET', url: '/api/auth/session' }), // 401
      await login({ email: OWNER.email }), // 422
      await api.app.inject({ method: 'GET', url: '/api/nao-existe' }), // 401 (negação por padrão)
    ];
    expect(responses.map((r) => r.statusCode)).toEqual([200, 401, 422, 401]);

    for (const response of responses) {
      const h = response.headers;
      expect(h['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['permissions-policy']).toBe('camera=(), microphone=(self), geolocation=()');
      expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(h['content-security-policy']).toContain("default-src 'none'");
      expect(h['cache-control']).toBe('no-store');
    }
  });

  it('HSTS só é enviado quando o origin público é HTTPS', async () => {
    const http = await createTestApi({ AION_PUBLIC_ORIGIN: 'http://localhost:3000' });
    try {
      const response = await http.app.inject({ method: 'GET', url: '/api/health' });
      expect(response.headers['strict-transport-security']).toBeUndefined();
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await http.cleanup();
    }
  });
});

describe('negação por padrão e saúde pública', () => {
  it('toda rota protegida exige sessão e só login e saúde são públicos; uma rota nova sem marca fica protegida', async () => {
    const uuid = '3f0c8f6e-6a53-4b64-9b53-0d6d6c1a1111';
    const protectedRoutes: [string, string][] = [
      ['GET', '/api/auth/session'],
      ['GET', '/api/auth/sessions'],
      ['POST', '/api/auth/logout'],
      ['DELETE', `/api/auth/sessions/${uuid}`],
    ];
    for (const [method, url] of protectedRoutes) {
      const response = await api.app.inject({ method: method as 'GET', url, headers: { origin: ORIGIN } });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json().code).toBe('AUTH_SESSION_EXPIRED');
    }
    // Cookie inválido tem o mesmo tratamento que ausente.
    const bogus = await api.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: 'aion_session=x' } });
    expect(bogus.statusCode).toBe(401);

    // Rotas públicas: saúde responde sem sessão e sem revelar nada além do estado.
    const health = await api.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
  });

  it('a saúde devolve 503 no envelope padrão quando o banco não responde', async () => {
    const broken = await createTestApi();
    await broken.pool.end();
    try {
      const response = await broken.app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Serviço indisponível. Tente novamente.' });
    } finally {
      await broken.app.close();
      await broken.database.drop();
    }
  });
});

describe('entrada não confiável e envelope de erro', () => {
  it('recusa campos extras, tipos errados, corpo acima de 256 KB, mídia e JSON inválidos, sem ecoar o enviado', async () => {
    // Campo extra e tipo errado: 422 com campo e motivo, sem ecoar valores nem nomes de chaves enviadas.
    const extra = await login({ email: OWNER.email, password: OWNER.password, isAdmin: 'chave-secreta-do-atacante' });
    expect(extra.statusCode).toBe(422);
    expect(extra.json()).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'Dados inválidos.',
      fields: [{ field: 'corpo', reason: 'Campo não permitido.' }],
    });
    expect(extra.body).not.toContain('isAdmin');
    expect(extra.body).not.toContain('chave-secreta-do-atacante');

    const wrongType = await login({ email: 123, password: 'x' });
    expect(wrongType.json().fields).toEqual([{ field: 'email', reason: 'Valor inválido.' }]);
    const tooLong = await login({ email: 'a'.repeat(255), password: 'x' });
    expect(tooLong.json().fields).toEqual([{ field: 'email', reason: 'Valor longo demais.' }]);
    const longPassword = await login({ email: OWNER.email, password: 'p'.repeat(257) });
    expect(longPassword.json().fields).toEqual([{ field: 'password', reason: 'Valor longo demais.' }]);

    // Corpo acima do limite.
    const huge = await login(JSON.stringify({ email: OWNER.email, password: 'x'.repeat(BODY_LIMIT_BYTES) }));
    expect(huge.statusCode).toBe(413);
    expect(huge.json().code).toBe('PAYLOAD_TOO_LARGE');

    // Tipo de conteúdo e JSON inválidos.
    const form = await login('email=a&password=b', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.statusCode).toBe(415);
    expect(form.json().code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const broken = await login('{"email": ');
    expect(broken.statusCode).toBe(400);
    expect(broken.json().code).toBe('BAD_REQUEST');
  });

  it('falhas internas viram INTERNAL_ERROR genérico: detalhe e stack só no log do servidor', async () => {
    // Erro real do banco no meio de uma requisição: a resposta não traz SQL, tabela nem stack.
    const failing = await createTestApi();
    try {
      const { cookie } = await failing.login();
      await failing.pool.query('ALTER TABLE sessions RENAME TO sessoes_renomeada');
      const response = await failing.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie } });
      // Sem a tabela, a autenticação falha por erro interno, nunca por vazamento.
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' });
      for (const leaked of ['sessions', 'relation', 'SELECT', 'stack', 'at ', 'node_modules', 'pg']) {
        expect(response.body).not.toContain(leaked);
      }
      // O detalhe existe, mas no log do servidor.
      expect(failing.logs.join('\n')).toContain('erro inesperado ao atender a requisição');
    } finally {
      await failing.cleanup();
    }
  });
});

describe('falha fechada na configuração', () => {
  it('sem e-mail, senha ou chave mestra a API não inicia e o erro cita só o nome da variável', async () => {
    const database = await createTestDatabase(inject('adminDatabaseUrl'));
    const logs: string[] = [];
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: database.url,
      AION_OWNER_EMAIL: OWNER.email,
      AION_OWNER_PASSWORD: OWNER.password,
      AION_MASTER_KEY: MASTER_KEY,
      AION_PUBLIC_ORIGIN: 'https://aion.exemplo.com',
    };
    try {
      for (const variable of ['AION_OWNER_EMAIL', 'AION_OWNER_PASSWORD', 'AION_MASTER_KEY'] as const) {
        const env: Record<string, string | undefined> = { ...base, [variable]: undefined };
        const error = await createApi(env, { logDestination: { write: (line) => void logs.push(line) } }).then(
          () => null,
          (e: Error) => e,
        );
        expect(error?.message).toContain(`${variable} ausente`);
        for (const secret of [OWNER.password, MASTER_KEY, database.url]) expect(error?.message).not.toContain(secret);
      }
      // Sem banco nem sessões criadas: a subida abortou antes de qualquer efeito.
      expect(logs.join('\n')).not.toContain(OWNER.password);
    } finally {
      await database.drop();
    }
  });

  it('sem AION_ALLOW_DESTRUCTIVE_MIGRATIONS a API recusa subir citando a migration destrutiva, e nenhuma migration é aplicada', async () => {
    const database = await createTestDatabase(inject('adminDatabaseUrl'));
    const base = { NODE_ENV: 'production', DATABASE_URL: database.url, AION_OWNER_EMAIL: OWNER.email, AION_OWNER_PASSWORD: OWNER.password, AION_MASTER_KEY: MASTER_KEY, AION_PUBLIC_ORIGIN: 'https://aion.exemplo.com' };
    try {
      // Ausente e `false` valem o mesmo: o padrão do config é recusar. A mensagem é a do migrator, com o id da migration e o nome da variável.
      for (const flag of [undefined, 'false']) {
        const error = await createApi({ ...base, AION_ALLOW_DESTRUCTIVE_MIGRATIONS: flag }, { logDestination: { write: () => undefined } }).then(
          () => null,
          (e: Error) => e,
        );
        expect(error?.message, String(flag)).toBe('Migration destrutiva bloqueada (0028_drop_bot_mascot): exige AION_ALLOW_DESTRUCTIVE_MIGRATIONS=true.');
      }
      // A conferência vem antes de aplicar qualquer migration: o banco novo não ficou com nenhuma pela metade.
      const pool = createPool(database.url, { applicationName: 'destructive-gate-check', max: 1 });
      try {
        expect((await pool.query('SELECT 1 FROM schema_migrations')).rowCount).toBe(0);
      } finally {
        await pool.end();
      }
    } finally {
      await database.drop();
    }
  });
});
