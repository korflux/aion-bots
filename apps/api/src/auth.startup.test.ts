// Prova de A1 na SUBIDA real da API: "trocar a senha no ambiente e reiniciar encerra todas as sessões".
// O serviço já é provado em packages/core; aqui se prova que o bootstrap de fato aciona a revogação.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from './bootstrap';
import { ORIGIN, OWNER, createTestApi, type TestApi } from './testing/harness';

let first: TestApi;

beforeAll(async () => {
  first = await createTestApi();
});

afterAll(async () => {
  await first.cleanup();
});

describe('reinício da API', () => {
  it('com a mesma credencial as sessões seguem valendo; com a senha trocada no ambiente todas são revogadas', async () => {
    const { cookie } = await first.login('203.0.113.80');
    const status = async (api: { app: TestApi['app'] }) =>
      (await api.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } })).statusCode;
    expect(await status(first)).toBe(200);

    // Reinício com o mesmo ambiente: a sessão continua valendo.
    const quiet = { logDestination: { write: () => undefined } };
    const same = await createApi(first.env, quiet);
    try {
      await same.app.ready();
      expect(await status(same)).toBe(200);
    } finally {
      await same.close();
    }

    // Reinício com a senha trocada: a sessão antiga some, a senha antiga não entra e a nova entra.
    const changed = await createApi({ ...first.env, AION_OWNER_PASSWORD: 'outra-senha-de-teste-2' }, quiet);
    try {
      await changed.app.ready();
      expect(await status(changed)).toBe(401);
      const login = (password: string) =>
        changed.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin: ORIGIN },
          payload: { email: OWNER.email, password },
          remoteAddress: '203.0.113.81',
        });
      expect((await login(OWNER.password)).statusCode).toBe(401);
      expect((await login('outra-senha-de-teste-2')).statusCode).toBe(200);
    } finally {
      await changed.close();
    }
  });
});
