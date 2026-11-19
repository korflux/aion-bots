// Prova de A10 (F8) pela borda HTTP (T5): sessão e CSRF em todas as rotas, lista do provedor com favorito e teste,
// teste da primeira seleção e "testar novamente", favoritos, allowlist de modelos, limite de 10 testes por minuto e a
// validação de modelo e effort na criação e edição de bots. O provedor é o servidor falso local.
import { startFakeUpstreams, type FakeUpstreams } from '@aion/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

const PROVIDER_KEY = 'valid-provider-key-ABCD';
const CLIENT_IP = '203.0.113.88';

let upstreams: FakeUpstreams;
let api: TestApi;
let session: { cookie: string; csrfToken: string };
/** Corpo de toda resposta e cabeçalhos, para provar no fim que a chave do provedor nunca saiu do servidor. */
const seen: string[] = [];

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  api = await createTestApi({ AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl, AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl });
  session = await api.login(CLIENT_IP);
});

afterAll(async () => {
  await api.cleanup();
  await upstreams.stop();
});

/** Chamada autenticada por padrão (cookie, Origin e token CSRF). */
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await api.app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'user-agent': CHROME_UA, ...headers },
    remoteAddress: CLIENT_IP,
  });
  seen.push(response.body, JSON.stringify(response.headers));
  return response;
}

interface Entry {
  id: string;
  favorite: boolean;
  favoritedAt: string | null;
  test: { status: string; reason: string | null; effortLevels: string[]; testedAt: string } | null;
}
const json = <T = Record<string, unknown>>(response: { json: () => unknown }) => response.json() as T;
const errorOf = (response: { json: () => unknown }) => response.json() as { code: string; message: string; fields?: { field: string; reason: string }[] };

describe('autenticação e configuração', () => {
  it('toda rota exige sessão e as que alteram estado exigem Origin e token CSRF; sem provedor, 409', async () => {
    const routes: ['GET' | 'POST' | 'PATCH', string, unknown?][] = [
      ['GET', '/api/models'],
      ['POST', '/api/models/test', { model: 'opencode/glm-5.1' }],
      ['POST', '/api/models/verify-image', { model: 'opencode/vision-model' }],
      ['PATCH', '/api/models/favorite', { model: 'opencode/glm-5.1', favorite: true }],
      ['PATCH', '/api/models/hidden', { model: 'opencode/glm-5.1', hidden: true }],
    ];
    for (const [method, url, payload] of routes) {
      const anonymous = await api.app.inject({ method, url, payload: payload as object | undefined, headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
      expect([url, anonymous.statusCode, errorOf(anonymous).code]).toEqual([url, 401, 'AUTH_SESSION_EXPIRED']);
    }
    for (const [method, url, payload] of routes.filter(([method]) => method !== 'GET')) {
      const noCsrf = await call(method, url, payload, { 'x-csrf-token': '' });
      expect([url, noCsrf.statusCode, errorOf(noCsrf).code]).toEqual([url, 403, 'CSRF_TOKEN_INVALID']);
      const wrongOrigin = await call(method, url, payload, { origin: 'https://evil.example' });
      expect([url, wrongOrigin.statusCode, errorOf(wrongOrigin).code]).toEqual([url, 403, 'CSRF_ORIGIN_INVALID']);
    }

    // Sem provedor configurado nenhuma das três funciona, e o provedor nem é chamado.
    const before = upstreams.requests.length;
    for (const [method, url, payload] of routes) {
      const response = await call(method, url, payload);
      expect([url, response.statusCode, errorOf(response).code]).toEqual([url, 409, 'PROVIDER_NOT_CONFIGURED']);
    }
    expect(upstreams.requests.length).toBe(before);
    // Contexto/preferências só leem perfis locais, inclusive quando não existe chave.
    expect((await api.app.inject({ method: 'GET', url: '/api/models/profiles' })).statusCode).toBe(401);
    const profiles = await call('GET', '/api/models/profiles');
    expect(profiles.statusCode).toBe(200);
    expect(json(profiles)).toEqual({ models: [] });
    expect(upstreams.requests.length).toBe(before);
  });
});

describe('jornada do seletor: listar, testar, favoritar e escolher no bot', () => {
  it('percorre a primeira e a segunda seleção, o effort filtrado e os favoritos, com erro em cada borda', async () => {
    expect((await call('POST', '/api/credentials/provider', { key: PROVIDER_KEY })).statusCode).toBe(200);

    // Lista: todos os modelos do provedor, contrato fechado (sem protocolo, sem campos internos).
    const listed = await call('GET', '/api/models');
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    const models = json<{ models: Entry[] }>(listed).models;
    expect(models).toHaveLength(14);
    expect(models[0]).toEqual({ id: 'opencode/broken-model', contextCapacity: null, favorite: false, favoritedAt: null, test: null, acceptsImages: null, unavailable: null, displayName: null, hidden: false, price: null });
    expect(Object.keys(models[0] as object).sort()).toEqual(['acceptsImages', 'contextCapacity', 'displayName', 'favorite', 'favoritedAt', 'hidden', 'id', 'price', 'test', 'unavailable']);
    // Recentes: sem nenhuma execução, a lista vem vazia (o campo existe no contrato); o preço do DeepSeek segue a tabela.
    expect(json<{ recents: string[] }>(listed).recents).toEqual([]);
    expect(models.find((model) => model.id === 'opencode/deepseek-v4.1-flash')).toMatchObject({ price: { input: 0.3, output: 1.2 } });

    // Primeira seleção: o teste roda e o resultado aparece na lista. O effort vem filtrado pelo que o provedor aceitou.
    const tested = await call('POST', '/api/models/test', { model: 'opencode/glm-5.1' });
    expect(tested.statusCode).toBe(200);
    const entry = json<Entry>(tested);
    expect(entry).toMatchObject({ id: 'opencode/glm-5.1', favorite: false, test: { status: 'ok', reason: null, effortLevels: ['low', 'medium', 'high'] } });
    expect(Object.keys(entry.test as object).sort()).toEqual(['effortLevels', 'reason', 'status', 'testedAt']);
    expect(json<{ models: Entry[] }>(await call('GET', '/api/models')).models.find((model) => model.id === 'opencode/glm-5.1')?.test?.status).toBe('ok');
    // Modelo sem ferramentas e modelo que falha: resultados (200), não erros.
    expect(json<Entry>(await call('POST', '/api/models/test', { model: 'opencode/deepseek-v4-pro' })).test).toMatchObject({ status: 'no_tools', reason: 'no_tool_call' });
    expect(json<Entry>(await call('POST', '/api/models/test', { model: 'opencode/broken-model' })).test).toMatchObject({ status: 'failed', reason: 'unsupported' });

    // Favoritos: marcar é idempotente e aparece na lista; desmarcar zera a data.
    const favorited = json<Entry>(await call('PATCH', '/api/models/favorite', { model: 'opencode/glm-5.1', favorite: true }));
    expect(favorited).toMatchObject({ id: 'opencode/glm-5.1', favorite: true, favoritedAt: expect.any(String), test: { status: 'ok' } });
    expect(json<Entry>(await call('PATCH', '/api/models/favorite', { model: 'opencode/glm-5.1', favorite: true })).favoritedAt).toBe(favorited.favoritedAt);
    expect(json<Entry>(await call('PATCH', '/api/models/favorite', { model: 'opencode/kimi-k2.7-code', favorite: true })).favorite).toBe(true);
    expect(json<Entry>(await call('PATCH', '/api/models/favorite', { model: 'opencode/kimi-k2.7-code', favorite: false }))).toMatchObject({ favorite: false, favoritedAt: null });
    // Ocultar (A7): idempotente, aparece na lista e nos perfis, não mexe no favorito nem no teste, e reexibir volta.
    const hidden = json<Entry & { hidden: boolean }>(await call('PATCH', '/api/models/hidden', { model: 'opencode/kimi-k2.7-code', hidden: true }));
    expect(hidden).toMatchObject({ id: 'opencode/kimi-k2.7-code', hidden: true, favorite: false });
    expect(json<{ models: (Entry & { hidden: boolean })[] }>(await call('GET', '/api/models')).models.filter((model) => model.hidden).map((model) => model.id)).toEqual(['opencode/kimi-k2.7-code']);
    expect(json<Entry & { hidden: boolean }>(await call('PATCH', '/api/models/hidden', { model: 'opencode/kimi-k2.7-code', hidden: true })).hidden).toBe(true);
    expect(json<Entry & { hidden: boolean }>(await call('PATCH', '/api/models/hidden', { model: 'opencode/kimi-k2.7-code', hidden: false })).hidden).toBe(false);
    expect(errorOf(await call('PATCH', '/api/models/hidden', { model: 'nao-existe', hidden: true })).code).toBe('MODEL_UNAVAILABLE');
    const beforeProfiles = upstreams.requests.length;
    const profiles = await call('GET', '/api/models/profiles');
    expect(profiles.statusCode).toBe(200);
    expect(json<{ models: Entry[] }>(profiles).models.find((entry) => entry.id === 'opencode/glm-5.1')).toEqual(favorited);
    expect(upstreams.requests.length).toBe(beforeProfiles);

    // Bordas: modelo fora da lista, corpo estrito (nada de URL ou campo extra), tipos errados.
    const since = upstreams.requests.length;
    const unknown = await call('POST', '/api/models/test', { model: 'nao-existe' });
    expect([unknown.statusCode, errorOf(unknown).code]).toEqual([422, 'MODEL_UNAVAILABLE']);
    expect(errorOf(await call('PATCH', '/api/models/favorite', { model: 'nao-existe', favorite: true })).code).toBe('MODEL_UNAVAILABLE');
    for (const [url, payload] of [
      ['/api/models/verify-image', {}],
      ['/api/models/verify-image', { model: 'opencode/vision-model', baseUrl: 'http://127.0.0.1:9' }],
      ['/api/models/test', {}],
      ['/api/models/test', { model: '' }],
      ['/api/models/test', { model: 'm'.repeat(210) }],
      ['/api/models/test', { model: 'glm-5.1\nx' }],
      ['/api/models/test', { model: 5 }],
      ['/api/models/test', { model: 'opencode/glm-5.1', baseUrl: 'http://127.0.0.1:9' }],
      ['/api/models/favorite', { model: 'opencode/glm-5.1' }],
      ['/api/models/favorite', { model: 'opencode/glm-5.1', favorite: 'sim' }],
      ['/api/models/favorite', { model: 'opencode/glm-5.1', favorite: true, extra: 1 }],
      ['/api/models/hidden', { model: 'opencode/glm-5.1' }],
      ['/api/models/hidden', { model: 'opencode/glm-5.1', hidden: 'sim' }],
      ['/api/models/hidden', { model: 'opencode/glm-5.1', hidden: true, extra: 1 }],
    ] as const) {
      const refused = await call(url.endsWith('favorite') || url.endsWith('hidden') ? 'PATCH' : 'POST', url, payload);
      expect([url, JSON.stringify(payload), refused.statusCode, errorOf(refused).code]).toEqual([url, JSON.stringify(payload), 422, 'VALIDATION_FAILED']);
    }
    expect(upstreams.requests.slice(since).filter((request) => request.method === 'POST')).toHaveLength(0); // nada chegou ao provedor

    // Bot: o modelo e o effort vêm do seletor e são conferidos no servidor.
    const base = { name: 'Financeiro', color: '#60A5FA' };
    const noEffortYet = await call('POST', '/api/bots', { ...base, model: 'opencode/kimi-k2.7-code', effort: 'high' });
    expect([noEffortYet.statusCode, errorOf(noEffortYet).code, errorOf(noEffortYet).fields]).toEqual([422, 'VALIDATION_FAILED', [{ field: 'effort', reason: 'O modelo não aceita este effort.' }]]);
    const outsideList = await call('POST', '/api/bots', { ...base, model: 'nao-existe' });
    expect([outsideList.statusCode, errorOf(outsideList).code]).toEqual([422, 'MODEL_UNAVAILABLE']);
    const effortWithoutModel = await call('POST', '/api/bots', { ...base, effort: 'high' });
    expect(errorOf(effortWithoutModel)).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ field: 'effort', reason: 'Escolha um modelo antes do effort.' }] });
    const unknownLevel = await call('POST', '/api/bots', { ...base, model: 'opencode/glm-5.1', effort: 'altissimo' });
    expect(errorOf(unknownLevel)).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ field: 'effort' }] });
    expect((await api.pool.query('SELECT 1 FROM bots')).rowCount).toBe(0); // nenhuma recusa criou bot

    const created = await call('POST', '/api/bots', { ...base, model: 'opencode/glm-5.1', effort: 'high' });
    expect(created.statusCode).toBe(201);
    const bot = json<{ id: string; model: string; effort: string }>(created);
    expect(bot).toMatchObject({ model: 'opencode/glm-5.1', effort: 'high' });

    // Editar: trocar de modelo mantendo um effort que o novo não aceita é recusado; limpar o effort junto passa.
    const switchKeepingEffort = await call('PATCH', `/api/bots/${bot.id}`, { model: 'opencode/glm-5.3-flash' });
    expect(errorOf(switchKeepingEffort)).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ field: 'effort' }] });
    expect(json(await call('GET', `/api/bots/${bot.id}`))).toMatchObject({ model: 'opencode/glm-5.1', effort: 'high' }); // a recusa não gravou nada
    expect(json(await call('PATCH', `/api/bots/${bot.id}`, { model: 'opencode/glm-5.3-flash', effort: null }))).toMatchObject({ model: 'opencode/glm-5.3-flash', effort: null });
    expect(json(await call('PATCH', `/api/bots/${bot.id}`, { model: null }))).toMatchObject({ model: null, effort: null });
  });

  it('limita a 10 testes por minuto: o 11º volta 429 com Retry-After e não chega ao provedor', async () => {
    // O teste anterior usou 3; completa a janela com os 7 que faltam e confere o 11º.
    const limiterApi = await createTestApi({ AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl, AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl });
    try {
      const own = await limiterApi.login('203.0.113.89');
      const send = (method: 'POST', url: string, payload: unknown) =>
        limiterApi.app.inject({ method, url, payload: payload as object, headers: { origin: ORIGIN, cookie: own.cookie, 'x-csrf-token': own.csrfToken }, remoteAddress: '203.0.113.89' });
      expect((await send('POST', '/api/credentials/provider', { key: PROVIDER_KEY })).statusCode).toBe(200);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect((await send('POST', '/api/models/test', { model: 'opencode/mute-model' })).statusCode, `teste ${attempt + 1}`).toBe(200);
      }
      const before = upstreams.requests.length;
      const limited = await send('POST', '/api/models/test', { model: 'opencode/mute-model' });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({ code: 'RATE_LIMITED', message: 'Muitas solicitações. Aguarde um instante e tente novamente.' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(upstreams.requests.length).toBe(before);
    } finally {
      await limiterApi.cleanup();
    }
  });
});

describe('sonda de imagem pela API', () => {
  it('persiste resultado e preserva envelope seguro na indisponibilidade', async () => {
    const response = await call('POST', '/api/models/verify-image', { model: 'opencode/vision-model' });
    expect(response.statusCode).toBe(200);
    expect(response.json().acceptsImages).toBe(true);
    const cached = await call('POST', '/api/models/verify-image', { model: 'opencode/vision-model' });
    expect(cached.json().acceptsImages).toBe(true);
    const failure = await call('POST', '/api/models/verify-image', { model: 'opencode/vision-unstable' });
    expect(failure.statusCode).toBe(503);
    expect(failure.json()).toEqual({ code: 'MODEL_IMAGE_CHECK_FAILED', message: 'Não consegui verificar o modelo agora. Tente de novo.' });
  });
});

describe('segredos', () => {
  it('a chave do provedor nunca aparece em resposta, cabeçalho ou log, e o teste só a usa contra o destino fixo', async () => {
    const everywhere = [...seen, ...api.logs].join('\n');
    expect(everywhere).not.toContain(PROVIDER_KEY);
    // Toda chamada de chat foi ao destino fixo da configuração, com a chave guardada.
    const chat = upstreams.requests.filter((request) => request.method === 'POST');
    expect(chat.length).toBeGreaterThan(0);
    expect(chat.every((request) => request.service === 'opencode-go' && request.path.startsWith('/opencode-go/v1/'))).toBe(true);
  });
});

describe('Anthropic pela API (phase 17; A1, A3, A4, A6)', () => {
  const OPENCODE_KEY = 'valid-provider-key-QRST';
  const ANTHROPIC_KEY = 'valid-anthropic-WXYZ';
  const IP = '203.0.113.89';

  it('com as duas chaves o catálogo traz os modelos por provedor, testa e usa o modelo da Anthropic com a chave dela; remover a chave tira o provedor e nenhuma chamada sai com ela; nada vaza', async () => {
    const own = await createTestApi({ AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl, AION_ANTHROPIC_BASE_URL: upstreams.anthropicBaseUrl, AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl });
    try {
      const ownSession = await own.login(IP);
      const bodies: string[] = [];
      const send = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
        const response = await own.app.inject({ method, url, payload: payload as object | undefined, headers: { origin: ORIGIN, cookie: ownSession.cookie, 'x-csrf-token': ownSession.csrfToken, 'user-agent': CHROME_UA }, remoteAddress: IP });
        bodies.push(response.body, JSON.stringify(response.headers));
        return response;
      };
      const anthropicCalls = () => upstreams.requests.filter((request) => request.service === 'anthropic');

      // Sem nenhuma chave: "configure um provedor"; só com a da Anthropic, a lista é só dela.
      expect(errorOf(await send('GET', '/api/models')).code).toBe('PROVIDER_NOT_CONFIGURED');
      const saved = await send('POST', '/api/credentials/anthropic', { key: ANTHROPIC_KEY });
      expect(saved.statusCode).toBe(200);
      expect(json(saved)).toEqual({ kind: 'anthropic', configured: true, masked: '••••WXYZ', updatedAt: expect.any(String), modelCount: 8 });
      expect(json<{ models: Entry[] }>(await send('GET', '/api/models')).models.every((entry) => entry.id.startsWith('anthropic/'))).toBe(true);

      // A6: com as duas chaves, cada modelo vem como provedor/modelo, o OpenCode Go antes e a Anthropic depois.
      expect((await send('POST', '/api/credentials/provider', { key: OPENCODE_KEY })).statusCode).toBe(200);
      const listed = json<{ models: (Entry & { contextCapacity?: { provider: string; contextTokens: number; outputTokens: number | null } | null })[] }>(await send('GET', '/api/models')).models;
      const ids = listed.map((entry) => entry.id);
      expect(ids).toHaveLength(14 + 8);
      expect(ids.slice(0, 14).every((id) => id.startsWith('opencode/'))).toBe(true);
      expect(ids.slice(14).every((id) => id.startsWith('anthropic/'))).toBe(true);
      expect(listed.find((entry) => entry.id === 'anthropic/claude-haiku-5-5')!.contextCapacity).toMatchObject({ provider: 'anthropic', contextTokens: 1_000_000, outputTokens: 128_000 });

      // Testar, favoritar e escolher no bot: tudo com o id do produto e a chave da Anthropic.
      const before = anthropicCalls().length;
      const tested = await send('POST', '/api/models/test', { model: 'anthropic/claude-haiku-5-5' });
      expect(tested.statusCode).toBe(200);
      expect(json<Entry>(tested).test).toMatchObject({ status: 'ok', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] });
      expect(anthropicCalls().slice(before).every((request) => request.key === ANTHROPIC_KEY && request.bearer === false)).toBe(true);
      expect((await send('PATCH', '/api/models/favorite', { model: 'anthropic/claude-haiku-5-5', favorite: true })).statusCode).toBe(200);
      const bot = await send('POST', '/api/bots', { name: 'Bot Claude', color: '#60A5FA', instructions: '', model: 'anthropic/claude-haiku-5-5', effort: 'high', stepLimit: 25 });
      expect(bot.statusCode).toBe(201);
      expect(json<{ model: string; effort: string }>(bot)).toMatchObject({ model: 'anthropic/claude-haiku-5-5', effort: 'high' });
      // O modelo sem a lista dele, ou de outro provedor com o id errado, é recusado sem chegar ao provedor.
      expect(errorOf(await send('POST', '/api/bots', { name: 'Bot X', color: '#60A5FA', instructions: '', model: 'anthropic/glm-5.1', effort: null, stepLimit: 25 })).code).toBe('MODEL_UNAVAILABLE');

      // A4: remover a chave da Anthropic registra só a máscara, tira o provedor do catálogo e nenhuma chamada sai com a chave removida.
      expect((await send('DELETE', '/api/credentials/anthropic')).statusCode).toBe(204);
      const afterRemoval = anthropicCalls().length;
      expect(json<{ models: Entry[] }>(await send('GET', '/api/models')).models.every((entry) => entry.id.startsWith('opencode/'))).toBe(true);
      expect(errorOf(await send('POST', '/api/models/test', { model: 'anthropic/claude-haiku-5-5' })).code).toBe('PROVIDER_NOT_CONFIGURED');
      expect(errorOf(await send('PATCH', '/api/models/favorite', { model: 'anthropic/claude-haiku-5-5', favorite: false })).code).toBe('PROVIDER_NOT_CONFIGURED');
      expect(anthropicCalls()).toHaveLength(afterRemoval);
      const audit = await own.pool.query<{ action: string; target: string; details: Record<string, unknown> }>("SELECT action, target, details FROM audit_log WHERE action LIKE 'credential.%' AND target = 'anthropic' ORDER BY id");
      expect(audit.rows).toEqual([
        { action: 'credential.save', target: 'anthropic', details: { masked: '••••WXYZ', previousMasked: null, replaced: false } },
        { action: 'credential.disconnect', target: 'anthropic', details: { masked: '••••WXYZ' } },
      ]);

      // A3: nenhuma resposta, cabeçalho, log, linha de auditoria ou do banco tem a chave inteira.
      const stored = await own.pool.query("SELECT (SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]') FROM credentials c) AS credentials, (SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]') FROM audit_log a) AS audit");
      const everywhere = [...bodies, ...own.logs, JSON.stringify(stored.rows)].join('\n');
      for (const key of [ANTHROPIC_KEY, OPENCODE_KEY]) expect(everywhere, key).not.toContain(key);
    } finally {
      await own.cleanup();
    }
  });
});
