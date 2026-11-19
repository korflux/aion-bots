// Harness dos testes da api: sobe a API real (configuração, migrations, verificador Argon2, hooks) sobre um
// banco exclusivo do teste, sem abrir porta. As requisições entram por `app.inject`.
import { createTestDatabase, type TestDatabase } from '@aion/core/testing';
import type { Env } from '@aion/core';
import { inject } from 'vitest';
import { createApi, type ApiRuntime, type CreateApiOptions } from '../bootstrap';

export const OWNER = { email: 'dono@aion.test', password: 'senha-de-teste-do-dono-1' };
export const ORIGIN = 'https://aion.test';
export const MASTER_KEY = Buffer.alloc(32, 5).toString('base64');
export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface TestApi extends ApiRuntime {
  database: TestDatabase;
  /** Ambiente com que a API foi criada (permite subir outra instância sobre o mesmo banco). */
  env: Env;
  /** Linhas de log emitidas pela API durante o teste. */
  logs: string[];
  /** Login pela API; devolve o valor do cookie e o token CSRF da nova sessão. */
  login(remoteAddress?: string): Promise<{ cookie: string; csrfToken: string; sessionId: string }>;
  cleanup(): Promise<void>;
}

/** Cria uma API de teste em modo produção (cookies Secure, HSTS, proxies privados confiáveis). `apiOptions.sse` encurta os tempos do SSE. */
export async function createTestApi(envOverrides: Env = {}, apiOptions: Pick<CreateApiOptions, 'sse'> = {}): Promise<TestApi> {
  const database = await createTestDatabase(inject('adminDatabaseUrl'));
  const logs: string[] = [];
  const env: Env = {
    NODE_ENV: 'production',
    DATABASE_URL: database.url,
    AION_OWNER_EMAIL: OWNER.email,
    AION_OWNER_PASSWORD: OWNER.password,
    AION_MASTER_KEY: MASTER_KEY,
    AION_PUBLIC_ORIGIN: ORIGIN,
    // Banco de teste é descartável e precisa do schema final: liga a permissão das migrations destrutivas (hoje a 0028, que remove `bots.mascot`). O padrão de
    // produção continua `false`, e security.test.ts prova que sem a variável a API recusa subir; um teste pode sobrescrever o valor por `envOverrides`.
    AION_ALLOW_DESTRUCTIVE_MIGRATIONS: 'true',
    ...envOverrides,
  };
  const runtime = await createApi(env, { logDestination: { write: (line) => void logs.push(line) }, ...apiOptions });
  await runtime.app.ready();

  return {
    ...runtime,
    database,
    env,
    logs,
    async login(remoteAddress = '203.0.113.50') {
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: ORIGIN, 'user-agent': CHROME_UA },
        payload: { email: OWNER.email, password: OWNER.password },
        remoteAddress,
      });
      if (response.statusCode !== 200) throw new Error(`login falhou no harness: ${response.statusCode}`);
      const cookie = `aion_session=${response.cookies.find((c) => c.name === 'aion_session')?.value ?? ''}`;
      const session = await runtime.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
      const body = session.json<{ csrfToken: string; sessionId: string }>();
      return { cookie, csrfToken: body.csrfToken, sessionId: body.sessionId };
    },
    async cleanup() {
      await runtime.close().catch(() => undefined);
      await database.drop();
    },
  };
}
