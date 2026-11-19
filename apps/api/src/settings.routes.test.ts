// Prova das preferências gerais (idioma e fuso, T28; "Como te chamar", phase 5, T4) pela borda HTTP: sessão em toda rota, Origin e CSRF no PUT, corpo estrito
// (campos extras, idioma fora da lista, fuso malformado ou desconhecido e nome com mais de 40 caracteres ou com caractere de controle recusados com 422 no
// envelope padrão, sem gravar nada), gravação e leitura de volta, a auditoria de quem mudou (sem o nome) e o nome fora dos logs. A regra de negócio e o efeito no contexto do modelo estão provados em @aion/core; aqui fica o que só a borda prova.
// Também cobre a rota da pesquisa na web (phase 1, T8): o interruptor e o estado MASCARADO da chave opcional da Parallel, nunca a chave.
// E as preferências de contexto em `/api/settings/context` (janelas e, na phase 9 T4, o "Modelo do resumo": só modelo validado, VALIDATION_FAILED no campo, corpo estrito e auditoria).
import { startFakeUpstreams, type FakeUpstreams } from '@aion/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

const CLIENT_IP = '203.0.113.93';

let api: TestApi;
let upstreams: FakeUpstreams;
let session: { cookie: string; csrfToken: string };

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  api = await createTestApi({ AION_PARALLEL_BASE_URL: upstreams.parallelBaseUrl });
  session = await api.login(CLIENT_IP);
});

afterAll(async () => {
  api.app.server.closeAllConnections();
  await api.cleanup();
  await upstreams.stop();
});

/** Chamada autenticada por padrão (cookie, Origin e token CSRF). */
async function call(method: 'GET' | 'PUT', payload?: unknown, headers: Record<string, string> = {}, url = '/api/settings') {
  return api.app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'user-agent': CHROME_UA, ...headers },
    remoteAddress: CLIENT_IP,
  });
}

const json = <T = Record<string, unknown>>(response: { json: () => unknown }) => response.json() as T;

describe('preferências independentes de contexto', () => {
  it('exige sessão/Origin/CSRF e recusa enum, escopo e campos fora do contrato', async () => {
    const url = '/api/settings/context';
    expect((await api.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await call('PUT', { scope: 'bots', windowTokens: 65536 }, { 'x-csrf-token': '' }, url)).statusCode).toBe(403);
    expect((await call('PUT', { scope: 'bots', windowTokens: 65536 }, { origin: 'https://evil.example' }, url)).statusCode).toBe(403);
    // 32768 saiu das opções na phase 11: o servidor recusa com 422 em qualquer escopo, e 524288 (512k) é o maior valor aceito.
    for (const payload of [{ scope: 'bots', windowTokens: '65536' }, { scope: 'bots', windowTokens: null }, { scope: 'bots', windowTokens: 32000 }, { scope: 'bots', windowTokens: 32768 }, { scope: 'general_chat', windowTokens: 32768 }, { scope: 'bots', windowTokens: 1048576 }, { scope: 'session', windowTokens: 65536 }, { scope: 'bots', windowTokens: 65536, model: 'x' }]) {
      expect((await call('PUT', payload, {}, url)).statusCode).toBe(422);
    }
    const before = json(await call('GET'));
    const second = await api.login('203.0.113.94');
    // O padrão do banco é 256k (migration 0046): gravar 64k nos bots e 512k no Chat geral torna observável que o PUT persistiu, em vez de repetir o padrão.
    await Promise.all([call('PUT', { scope: 'bots', windowTokens: 65536 }, {}, url), call('PUT', { scope: 'general_chat', windowTokens: 524288 }, { cookie: second.cookie, 'x-csrf-token': second.csrfToken }, url)]);
    expect(json(await call('GET', undefined, {}, url))).toEqual({ bots: 65536, generalChat: 524288, summaryModel: null });
    expect(json(await call('GET'))).toEqual(before);
  });
});

describe('modelo do resumo em /api/settings/context (phase 9, T4)', () => {
  const url = '/api/settings/context';
  const MODEL = 'resumo-validado-e2e';
  const put = (payload: unknown, headers: Record<string, string> = {}) => call('PUT', payload, headers, url);
  const stored = async () => (await api.pool.query<{ summary_model: string | null }>('SELECT summary_model FROM app_settings')).rows[0]?.summary_model ?? null;

  it('exige sessão, Origin e CSRF como as demais gravações, e nada é gravado pelas recusas', async () => {
    const body = { scope: 'summary_model', summaryModel: null };
    expect((await api.app.inject({ method: 'PUT', url, payload: body, headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP })).statusCode).toBe(401);
    const noCsrf = await put(body, { 'x-csrf-token': '' });
    expect([noCsrf.statusCode, json<{ code: string }>(noCsrf).code]).toEqual([403, 'CSRF_TOKEN_INVALID']);
    const wrongOrigin = await put(body, { origin: 'https://evil.example' });
    expect([wrongOrigin.statusCode, json<{ code: string }>(wrongOrigin).code]).toEqual([403, 'CSRF_ORIGIN_INVALID']);
    expect(await stored()).toBeNull();
  });

  it('corpo estrito: formato fora do contrato (vazio, mais de 200 caracteres, controle, tipo errado, campo extra, mistura com a janela) é recusado com 422 sem gravar', async () => {
    for (const bad of [
      { scope: 'summary_model' },
      { scope: 'summary_model', summaryModel: '' },
      { scope: 'summary_model', summaryModel: 'a'.repeat(201) },
      { scope: 'summary_model', summaryModel: 'mo\ndelo' },
      { scope: 'summary_model', summaryModel: 7 },
      { scope: 'summary_model', summaryModel: [MODEL] },
      { scope: 'summary_model', summaryModel: null, extra: 1 },
      { scope: 'summary_model', summaryModel: null, windowTokens: 65536 },
      { scope: 'bots', windowTokens: 65536, summaryModel: MODEL },
      { summaryModel: null },
    ]) {
      const response = await put(bad);
      expect([JSON.stringify(bad), response.statusCode, json<{ code: string }>(response).code]).toEqual([JSON.stringify(bad), 422, 'VALIDATION_FAILED']);
    }
    expect(await stored()).toBeNull();
  });

  it('um modelo que não é validado (desconhecido, só favoritado, que falhou no teste) recebe VALIDATION_FAILED no campo e a escolha anterior segue', async () => {
    await api.pool.query(
      `INSERT INTO model_profiles (model_id, test_status, test_reason, test_protocol, effort_levels, tested_at, created_at, updated_at)
       VALUES ('resumo-falhou-e2e', 'failed', 'unsupported', NULL, '{}', now(), now(), now())`,
    );
    await api.pool.query("INSERT INTO model_profiles (model_id, favorited_at, created_at, updated_at) VALUES ('resumo-favorito-e2e', now(), now(), now())");
    const before = json(await call('GET', undefined, {}, url));
    for (const model of ['modelo-que-nao-existe', 'resumo-falhou-e2e', 'resumo-favorito-e2e']) {
      const response = await put({ scope: 'summary_model', summaryModel: model });
      expect([model, response.statusCode]).toEqual([model, 422]);
      expect(json(response)).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Dados inválidos.', fields: [{ field: 'summaryModel', reason: 'Escolha um modelo validado.' }] });
      expect(JSON.stringify(json(response))).not.toMatch(/stack|SELECT|model_profiles/); // envelope seguro, sem detalhe interno
    }
    expect(json(await call('GET', undefined, {}, url))).toEqual(before);
    expect(await stored()).toBeNull();
  });

  it('um modelo validado grava, é devolvido na resposta e na leitura, não mexe nas janelas, volta a nulo, e a auditoria traz só o escopo e o id do modelo', async () => {
    await api.pool.query(
      `INSERT INTO model_profiles (model_id, test_status, test_reason, test_protocol, effort_levels, tested_at, created_at, updated_at)
       VALUES ($1, 'ok', NULL, 'chat_completions', '{}', now(), now(), now())`,
      [MODEL],
    );
    const windows = json<{ bots: number; generalChat: number }>(await call('GET', undefined, {}, url));
    const saved = await put({ scope: 'summary_model', summaryModel: MODEL });
    expect(saved.statusCode).toBe(200);
    expect(json(saved)).toEqual({ bots: windows.bots, generalChat: windows.generalChat, summaryModel: MODEL });
    expect(json(await call('GET', undefined, {}, url))).toEqual({ bots: windows.bots, generalChat: windows.generalChat, summaryModel: MODEL });
    expect(await stored()).toBe(MODEL);
    // Gravar uma janela depois não apaga o modelo do resumo (e a resposta o traz).
    expect(json(await put({ scope: 'bots', windowTokens: 131072 }))).toEqual({ bots: 131072, generalChat: windows.generalChat, summaryModel: MODEL });
    await put({ scope: 'bots', windowTokens: windows.bots }); // devolve a janela de antes
    expect(json(await put({ scope: 'summary_model', summaryModel: null }))).toEqual({ ...windows, summaryModel: null });
    expect(await stored()).toBeNull();
    // As preferências de idioma e fuso seguem com os campos de sempre.
    expect(Object.keys(json(await call('GET'))).sort()).toEqual(['language', 'ownerName', 'timeZone']);

    const audit = await api.pool.query<{ actor: string; ip: string | null; details: Record<string, unknown> }>(
      "SELECT actor, ip, details FROM audit_log WHERE action = 'settings.context' AND details->>'scope' = 'summary_model' ORDER BY id",
    );
    expect(audit.rows.map((row) => row.details)).toEqual([{ scope: 'summary_model', summaryModel: MODEL }, { scope: 'summary_model', summaryModel: null }]);
    expect(audit.rows.every((row) => row.actor === 'owner' && row.ip === CLIENT_IP)).toBe(true);
  });
});

describe('GET e PUT /api/settings', () => {
  it('exige sessão; o PUT exige Origin e token CSRF', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const anonymous = await api.app.inject({ method, url: '/api/settings', payload: method === 'PUT' ? { language: 'pt-BR', timeZone: 'UTC', ownerName: '' } : undefined, headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
      expect([method, anonymous.statusCode, json<{ code: string }>(anonymous).code]).toEqual([method, 401, 'AUTH_SESSION_EXPIRED']);
    }
    const body = { language: 'pt-BR', timeZone: 'UTC', ownerName: '' };
    const noCsrf = await call('PUT', body, { 'x-csrf-token': '' });
    expect([noCsrf.statusCode, json<{ code: string }>(noCsrf).code]).toEqual([403, 'CSRF_TOKEN_INVALID']);
    const wrongOrigin = await call('PUT', body, { origin: 'https://evil.example' });
    expect([wrongOrigin.statusCode, json<{ code: string }>(wrongOrigin).code]).toEqual([403, 'CSRF_ORIGIN_INVALID']);
  });

  it('o padrão é o de antes (português do Brasil, America/Sao_Paulo, sem nome); gravar vale e é lido de volta', async () => {
    expect(json(await call('GET'))).toEqual({ language: 'pt-BR', timeZone: 'America/Sao_Paulo', ownerName: '' });
    const saved = await call('PUT', { language: 'en', timeZone: 'America/New_York', ownerName: '' });
    expect(saved.statusCode).toBe(200);
    expect(json(saved)).toEqual({ language: 'en', timeZone: 'America/New_York', ownerName: '' });
    expect(json(await call('GET'))).toEqual({ language: 'en', timeZone: 'America/New_York', ownerName: '' });
  });

  it('o nome grava, é aparado, é lido de volta e vazio o apaga; fica fora dos logs e da auditoria', async () => {
    const saved = await call('PUT', { language: 'en', timeZone: 'America/New_York', ownerName: '  Zeferino Quartzo  ' });
    expect(saved.statusCode).toBe(200);
    expect(json(saved)).toEqual({ language: 'en', timeZone: 'America/New_York', ownerName: 'Zeferino Quartzo' });
    expect(json(await call('GET'))).toEqual({ language: 'en', timeZone: 'America/New_York', ownerName: 'Zeferino Quartzo' });
    expect(json(await call('PUT', { language: 'en', timeZone: 'America/New_York', ownerName: 'ã'.repeat(39) + '😀' }))).toMatchObject({ ownerName: 'ã'.repeat(39) + '😀' }); // 40 caracteres
    const audit = await api.pool.query<{ details: unknown }>("SELECT details FROM audit_log WHERE action = 'settings.updated' ORDER BY id");
    expect(audit.rows.map((row) => row.details)).toContainEqual({ language: 'en', timeZone: 'America/New_York', ownerNameChanged: true });
    expect(JSON.stringify(audit.rows)).not.toContain('Zeferino');
    expect(api.logs.join(' ')).not.toContain('Zeferino'); // o corpo do PUT não é logado
    const cleared = await call('PUT', { language: 'en', timeZone: 'America/New_York', ownerName: '   ' });
    expect(json(cleared)).toEqual({ language: 'en', timeZone: 'America/New_York', ownerName: '' });
  });

  it('nome com mais de 40 caracteres, com caractere de controle ou que não é texto é recusado (422, VALIDATION_FAILED, no campo) e nada é gravado', async () => {
    const before = json(await call('GET'));
    for (const ownerName of ['a'.repeat(41), 'Mar\u0000co', 'Mar\nco', 'Mar\u007Fco', 'Mar\u2028co', 7, null, ['Marco']]) {
      const response = await call('PUT', { language: 'en', timeZone: 'America/New_York', ownerName });
      expect([JSON.stringify(ownerName), response.statusCode, json<{ code: string }>(response).code]).toEqual([JSON.stringify(ownerName), 422, 'VALIDATION_FAILED']);
      expect(json<{ fields: { field: string }[] }>(response).fields.map((item) => item.field)).toEqual(['ownerName']);
    }
    const missing = await call('PUT', { language: 'en', timeZone: 'America/New_York' }); // o PUT leva o objeto completo
    expect([missing.statusCode, json<{ code: string }>(missing).code]).toEqual([422, 'VALIDATION_FAILED']);
    expect(json(await call('GET'))).toEqual(before);
  });

  it('campos extras, idioma fora da lista e fuso malformado ou desconhecido são recusados e nada é gravado', async () => {
    for (const bad of [
      { language: 'en', timeZone: 'UTC', ownerName: '', extra: 1 },
      { language: 'klingon', timeZone: 'UTC', ownerName: '' },
      { language: 'en', ownerName: '' },
      { timeZone: 'UTC', ownerName: '' },
      { language: 'en', timeZone: 'não é um fuso!', ownerName: '' },
      { language: 'en', timeZone: 'A'.repeat(65), ownerName: '' },
      { language: 'en', timeZone: 7, ownerName: '' },
    ]) {
      const response = await call('PUT', bad);
      expect([JSON.stringify(bad), response.statusCode, json<{ code: string }>(response).code]).toEqual([JSON.stringify(bad), 422, 'VALIDATION_FAILED']);
    }
    // Formato válido, mas fuso que o runtime não conhece: a recusa traz o campo.
    const unknown = await call('PUT', { language: 'en', timeZone: 'Marte/Olimpo', ownerName: '' });
    expect(unknown.statusCode).toBe(422);
    expect(json<{ code: string; fields: unknown }>(unknown)).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ field: 'timeZone', reason: 'Fuso horário desconhecido.' }] });
    expect(json(await call('GET'))).toEqual({ language: 'en', timeZone: 'America/New_York', ownerName: '' });
  });

  it('audita quem mudou, de onde e o quê (sem o nome, só se mudou), sem mais nada', async () => {
    const audit = await api.pool.query<{ actor: string; ip: string | null; details: Record<string, unknown> }>(
      "SELECT actor, ip, details FROM audit_log WHERE action = 'settings.updated' ORDER BY id",
    );
    expect(audit.rows.every((row) => row.actor === 'owner' && row.ip === CLIENT_IP)).toBe(true);
    expect(audit.rows.map((row) => Object.keys(row.details).sort())).toEqual(audit.rows.map(() => ['language', 'ownerNameChanged', 'timeZone']));
    expect(audit.rows[0]?.details).toEqual({ language: 'en', timeZone: 'America/New_York', ownerNameChanged: false });
  });
});

describe('GET e PUT /api/settings/web-search', () => {
  const PATH = '/api/settings/web-search';
  const anonymousState = { enabled: true, key: { kind: 'web_search', configured: false, masked: null, updatedAt: null, modelCount: null } };

  it('exige sessão; o PUT exige Origin e token CSRF', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const anonymous = await api.app.inject({ method, url: PATH, payload: method === 'PUT' ? { enabled: false } : undefined, headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
      expect([method, anonymous.statusCode, json<{ code: string }>(anonymous).code]).toEqual([method, 401, 'AUTH_SESSION_EXPIRED']);
    }
    const noCsrf = await call('PUT', { enabled: false }, { 'x-csrf-token': '' }, PATH);
    expect([noCsrf.statusCode, json<{ code: string }>(noCsrf).code]).toEqual([403, 'CSRF_TOKEN_INVALID']);
    const wrongOrigin = await call('PUT', { enabled: false }, { origin: 'https://evil.example' }, PATH);
    expect([wrongOrigin.statusCode, json<{ code: string }>(wrongOrigin).code]).toEqual([403, 'CSRF_ORIGIN_INVALID']);
    expect(json(await call('GET', undefined, {}, PATH))).toEqual(anonymousState); // nada foi gravado pelas recusas
  });

  it('vem ligada e anônima por padrão; desligar e ligar vale e é lido de volta, devolvendo o estado completo', async () => {
    expect(json(await call('GET', undefined, {}, PATH))).toEqual(anonymousState);
    const languageAndZone = json(await call('GET'));
    const off = await call('PUT', { enabled: false }, {}, PATH);
    expect(off.statusCode).toBe(200);
    expect(json(off)).toEqual({ ...anonymousState, enabled: false });
    expect(json(await call('GET', undefined, {}, PATH))).toEqual({ ...anonymousState, enabled: false });
    expect(json(await call('PUT', { enabled: true }, {}, PATH))).toEqual(anonymousState);
    // A rota do idioma e fuso não foi afetada: segue com os dois campos de sempre, com os valores que tinha.
    expect(json(await call('GET'))).toEqual(languageAndZone);
    expect(Object.keys(languageAndZone).sort()).toEqual(['language', 'ownerName', 'timeZone']);
  });

  it('corpo estrito: campo extra, texto, número, nulo e corpo vazio são recusados (422) e nada é gravado', async () => {
    for (const bad of [{ enabled: 'true' }, { enabled: 1 }, { enabled: null }, { enabled: true, extra: 1 }, { language: 'en' }, {}]) {
      const response = await call('PUT', bad, {}, PATH);
      expect([JSON.stringify(bad), response.statusCode, json<{ code: string }>(response).code]).toEqual([JSON.stringify(bad), 422, 'VALIDATION_FAILED']);
    }
    expect(json<{ enabled: boolean }>(await call('GET', undefined, {}, PATH)).enabled).toBe(true);
  });

  it('a leitura traz a chave só mascarada: nenhuma resposta, cabeçalho ou log tem a chave inteira', async () => {
    const key = 'valid-parallel-web-key-QWER';
    await api.credentials.save('web_search', key, { ip: CLIENT_IP, userAgent: CHROME_UA });
    const read = await call('GET', undefined, {}, PATH);
    expect(json(read)).toEqual({ enabled: true, key: { kind: 'web_search', configured: true, masked: '••••QWER', updatedAt: expect.any(String), modelCount: null } });
    const toggled = await call('PUT', { enabled: false }, {}, PATH);
    const everything = [read.body, JSON.stringify(read.headers), toggled.body, JSON.stringify(toggled.headers), ...api.logs].join(' ');
    expect(everything).not.toContain(key);
    await call('PUT', { enabled: true }, {}, PATH);
    await api.credentials.disconnect('web_search', { ip: CLIENT_IP, userAgent: CHROME_UA });
    expect(json(await call('GET', undefined, {}, PATH))).toEqual(anonymousState); // desconectar volta ao anônimo
  });

  it('audita cada mudança do interruptor (quem, de onde e o valor), sem mais nada', async () => {
    const audit = await api.pool.query<{ actor: string; ip: string | null; details: Record<string, unknown> }>(
      "SELECT actor, ip, details FROM audit_log WHERE action = 'settings.web_search' ORDER BY id",
    );
    expect(audit.rows.map((row) => row.details)).toEqual([{ enabled: false }, { enabled: true }, { enabled: false }, { enabled: true }]);
    expect(audit.rows.every((row) => row.actor === 'owner' && row.ip === CLIENT_IP)).toBe(true);
  });
});
