// Prova do web push pela borda HTTP (T10; A13; F14): sessão e CSRF em todas as rotas, a configuração pública do Firebase (e só ela), o registro
// idempotente do dispositivo com o rótulo vindo do navegador, as validações de entrada (token em ASCII imprimível de até 4.096 caracteres,
// campos extras recusados), a remoção com NOT_FOUND na repetição, o token que NUNCA volta nas respostas nem vai à auditoria. Phase 3 (T3): a
// abertura do app (sem corpo, hora do servidor, 10 por minuto por sessão) e a conferência do service worker (até 21 ids, só `{ id, valid }`,
// 60 por minuto por sessão). Phase 16 (passo 4): a conferência traz título, corpo e id da aprovação só para evento válido com "Mostrar conteúdo" ligado, e as rotas
// dos dois interruptores (estado final idempotente, Origin e CSRF, auditoria só com o booleano e a origem). A regra de negócio, a validade e o envio estão provados em @aion/core; o ENVIO pelo worker, em `push.worker.test.ts`.
import { PUSH_APP_OPENS_PER_MINUTE, PUSH_CHECKS_PER_MINUTE, PUSH_CHECK_IDS_MAX, PUSH_RECEIPTS_PER_MINUTE, PUSH_TOKEN_MAX } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

const CLIENT_IP = '203.0.113.97';
const GHOST = '00000000-0000-4000-8000-000000000000';
const WEB_CONFIG = { apiKey: 'AIza-public-key', projectId: 'aion-test', messagingSenderId: '1234567890', appId: '1:1234567890:web:abc' };
const VAPID = 'B'.repeat(87);
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

let api: TestApi;
let session: Awaited<ReturnType<TestApi['login']>>;

beforeAll(async () => {
  api = await createTestApi({ AION_FCM_WEB_CONFIG: JSON.stringify(WEB_CONFIG), AION_FCM_VAPID_KEY: VAPID });
  session = await api.login(CLIENT_IP);
});

afterAll(async () => {
  await api.cleanup();
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Chamada autenticada por padrão (cookie, Origin e token CSRF) com a sessão informada. */
async function call(method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}, as = session) {
  return api.app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { origin: ORIGIN, cookie: as.cookie, 'x-csrf-token': as.csrfToken, 'user-agent': CHROME_UA, ...headers },
    remoteAddress: CLIENT_IP,
  });
}

const json = <T = Record<string, unknown>>(response: { json: () => unknown }) => response.json() as T;
const errorOf = (response: { json: () => unknown }) => response.json() as { code: string; message: string; fields?: { field: string; reason: string }[] };

describe('segurança da borda', () => {
  it('toda rota exige sessão válida e, as que alteram estado, Origin e token CSRF', async () => {
    const requests: [Method, string, unknown][] = [
      ['GET', '/api/push/config', undefined],
      ['GET', '/api/push/devices', undefined],
      ['POST', '/api/push/devices', { token: 'abc' }],
      ['DELETE', `/api/push/devices/${GHOST}`, undefined],
      ['PUT', '/api/push/opened', undefined],
      ['GET', '/api/push/events/check?ids=1', undefined],
      ['POST', '/api/push/receipts', { eventId: '1', deviceId: GHOST, state: 'received' }],
      ['GET', '/api/push/content', undefined],
      ['PUT', '/api/push/content', { origin: 'bots', enabled: false }],
    ];
    for (const [method, url, payload] of requests) {
      const anonymous = await api.app.inject({ method, url, payload: payload as object | undefined, headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
      expect(anonymous.statusCode, `${method} ${url} sem sessão`).toBe(401);
      expect(errorOf(anonymous).code).toBe('AUTH_SESSION_EXPIRED');
    }
    for (const [method, url, payload] of requests.filter(([method]) => method !== 'GET')) {
      const wrongOrigin = await call(method, url, payload, { origin: 'https://outro.exemplo' });
      expect(errorOf(wrongOrigin).code, `${method} ${url} com Origin errado`).toBe('CSRF_ORIGIN_INVALID');
      const noToken = await call(method, url, payload, { 'x-csrf-token': 'invalido' });
      expect(errorOf(noToken).code, `${method} ${url} com token CSRF errado`).toBe('CSRF_TOKEN_INVALID');
    }
  });
});

describe('configuração pública', () => {
  it('entrega só a configuração pública do app web e a chave VAPID, e nada da conta de serviço', async () => {
    const response = await call('GET', '/api/push/config');
    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ enabled: true, firebase: WEB_CONFIG, vapidKey: VAPID });
  });
});

describe('configuração do push inválida', () => {
  it('NÃO derruba a API: ela sobe, o push fica desligado e o log registra só o nome da variável (o caso do JSON com as aspas estragadas pelo painel)', async () => {
    const mangled = '{apiKey:AIza-valor-secreto,projectId:aion-test}';
    const degraded = await createTestApi({ AION_FCM_WEB_CONFIG: mangled, AION_FCM_VAPID_KEY: VAPID });
    try {
      const login = await degraded.login('203.0.113.98');
      const response = await degraded.app.inject({ method: 'GET', url: '/api/push/config', headers: { cookie: login.cookie }, remoteAddress: '203.0.113.98' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ enabled: false });
      const warning = degraded.logs.find((line) => line.includes('configuração opcional ignorada'));
      expect(warning).toContain('AION_FCM_WEB_CONFIG');
      expect(degraded.logs.join('')).not.toContain('AIza-valor-secreto');
    } finally {
      await degraded.cleanup();
    }
  });
});

describe('dispositivos', () => {
  it('registrar é idempotente por token, o rótulo vem do navegador e o token nunca volta nem vai à auditoria', async () => {
    const token = `fcm-token-${'x'.repeat(40)}:APA91b_secreto`;
    const first = await call('POST', '/api/push/devices', { token });
    expect(first.statusCode).toBe(200);
    const device = json<{ id: string; label: string; createdAt: string; lastSeenAt: string }>(first);
    expect(Object.keys(device).sort()).toEqual(['createdAt', 'id', 'label', 'lastSeenAt']);
    expect(device.label).toBe('Chrome no Windows');

    const again = await call('POST', '/api/push/devices', { token }, { 'user-agent': ANDROID_UA });
    expect(json<{ id: string; label: string }>(again)).toMatchObject({ id: device.id, label: 'Chrome no Android' });

    const second = json<{ id: string }>(await call('POST', '/api/push/devices', { token: `${token}-outro` }));
    expect(second.id).not.toBe(device.id);

    const list = await call('GET', '/api/push/devices');
    expect(json<{ devices: { id: string }[] }>(list).devices.map((entry) => entry.id)).toEqual([device.id, second.id]);
    for (const response of [first, again, list]) expect(response.body).not.toContain('APA91b_secreto');

    const audit = await api.pool.query<{ action: string; target: string; details: unknown }>("SELECT action, target, details FROM audit_log WHERE action LIKE 'push.%' ORDER BY id");
    expect(audit.rows.filter((row) => row.action === 'push.device_register').map((row) => row.target)).toEqual([device.id, second.id]); // o segundo registro do mesmo token não repete
    expect(JSON.stringify(audit.rows)).not.toContain('APA91b_secreto');
  });

  it('recusa token vazio, grande demais, com espaço ou caractere de controle e campos extras', async () => {
    const bad: unknown[] = [
      {},
      { token: '' },
      { token: 'a'.repeat(PUSH_TOKEN_MAX + 1) },
      { token: 'tem espaço' },
      { token: 'quebra\nde-linha' },
      { token: 'acentuação-é' },
      { token: 123 },
      { token: 'valido', label: 'Extra' },
    ];
    for (const payload of bad) {
      const response = await call('POST', '/api/push/devices', payload);
      expect(response.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(422);
      expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    }
    // No limite de tamanho é aceito.
    expect((await call('POST', '/api/push/devices', { token: 'a'.repeat(PUSH_TOKEN_MAX) })).statusCode).toBe(200);
  });

  it('remover apaga o dispositivo, é auditado, e repetir ou usar um id que não existe é NOT_FOUND', async () => {
    const created = json<{ id: string }>(await call('POST', '/api/push/devices', { token: 'token-para-remover' }));
    const removed = await call('DELETE', `/api/push/devices/${created.id}`);
    expect(removed.statusCode).toBe(204);
    expect((json<{ devices: { id: string }[] }>(await call('GET', '/api/push/devices'))).devices.map((entry) => entry.id)).not.toContain(created.id);

    for (const id of [created.id, GHOST]) {
      const missing = await call('DELETE', `/api/push/devices/${id}`);
      expect(missing.statusCode).toBe(404);
      expect(errorOf(missing).code).toBe('NOT_FOUND');
    }
    expect((await call('DELETE', '/api/push/devices/nao-e-uuid')).statusCode).toBe(422);

    const audit = await api.pool.query<{ target: string }>("SELECT target FROM audit_log WHERE action = 'push.device_remove'");
    expect(audit.rows.map((row) => row.target)).toEqual([created.id]);
  });
});

describe('abertura do app (phase 3, T3; F3)', () => {
  it('grava a hora do servidor numa linha só e sem auditoria, recusa qualquer corpo e limita a 10 por minuto por sessão', async () => {
    const device = await api.login(CLIENT_IP);
    const before = Date.now();
    const opened = await call('PUT', '/api/push/opened', undefined, {}, device);
    expect(opened.statusCode).toBe(204);
    expect(opened.body).toBe('');
    const rows = (await api.pool.query<{ opened_at: Date }>('SELECT opened_at FROM app_opened')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.opened_at.getTime()).toBeGreaterThanOrEqual(before - 1000);

    const withBody = await call('PUT', '/api/push/opened', { openedAt: '2099-01-01T00:00:00Z' }, {}, device);
    expect(withBody.statusCode).toBe(413);
    expect(errorOf(withBody).code).toBe('PAYLOAD_TOO_LARGE');
    expect((await api.pool.query<{ opened_at: Date }>('SELECT opened_at FROM app_opened')).rows[0]!.opened_at.getTime()).toBeLessThan(Date.parse('2099-01-01T00:00:00Z'));

    for (let index = 1; index < PUSH_APP_OPENS_PER_MINUTE; index += 1) expect((await call('PUT', '/api/push/opened', undefined, {}, device)).statusCode).toBe(204);
    const limited = await call('PUT', '/api/push/opened', undefined, {}, device);
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect((await call('PUT', '/api/push/opened', undefined, {}, await api.login(CLIENT_IP))).statusCode).toBe(204); // outra sessão segue
    expect((await api.pool.query("SELECT 1 FROM audit_log WHERE action LIKE 'push.%open%'")).rows).toEqual([]);
  });
});

describe('conferência do service worker (phase 3, T3; F2)', () => {
  it('responde { id, valid } por id pedido (com título e corpo do tipo, a chave estando ligada), com id desconhecido inválido, recusa ids fora do contrato e limita a 60 por minuto por sessão', async () => {
    const bot = await call('POST', '/api/bots', { name: 'Bot da conferência', color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 25 });
    expect(bot.statusCode).toBe(201);
    const botId = json<{ id: string }>(bot).id;
    // Criado agora, depois de qualquer abertura gravada antes neste arquivo: vale.
    const event = await api.pool.query<{ id: string }>("INSERT INTO push_events (kind, bot_id, created_at) VALUES ('run_completed', $1, now()) RETURNING id::text AS id", [botId]);
    const eventId = event.rows[0]!.id;
    const checker = await api.login(CLIENT_IP);

    const answer = await call('GET', `/api/push/events/check?ids=${eventId},999999999`, undefined, {}, checker);
    expect(answer.statusCode).toBe(200);
    // Chave ligada (padrão): o evento válido traz título e corpo; o desconhecido, só `valid: false`. Sem mensagem a resumir, o corpo é o tipo do evento.
    expect(json(answer)).toEqual({ events: [{ id: eventId, valid: true, title: 'Bot da conferência', body: 'Execução concluída' }, { id: '999999999', valid: false }] });

    const tooMany = Array.from({ length: PUSH_CHECK_IDS_MAX + 1 }, (_, index) => String(index + 1)).join(',');
    for (const query of ['', 'ids=', 'ids=abc', 'ids=1,,2', 'ids=-1', 'ids=1.5', `ids=${'9'.repeat(19)}`, `ids=${tooMany}`, 'ids=1&extra=2']) {
      const response = await call('GET', `/api/push/events/check?${query}`, undefined, {}, checker);
      expect(response.statusCode, query.slice(0, 40)).toBe(422);
      expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    }
    const atLimit = Array.from({ length: PUSH_CHECK_IDS_MAX }, () => eventId).join(',');
    expect((await call('GET', `/api/push/events/check?ids=${atLimit}`, undefined, {}, checker)).statusCode).toBe(200);

    for (let index = 2; index < PUSH_CHECKS_PER_MINUTE; index += 1) expect((await call('GET', `/api/push/events/check?ids=${eventId}`, undefined, {}, checker)).statusCode).toBe(200);
    const limited = await call('GET', `/api/push/events/check?ids=${eventId}`, undefined, {}, checker);
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
  });
});

// Interruptores "Mostrar conteúdo" (phase 16, passo 4; A3, A4): ligados por padrão; a rota muda uma origem por chamada com o estado final (idempotente); a conferência obedece à chave
// da origem; só a mudança real é auditada, e a trilha leva apenas a origem e o booleano.
describe('Mostrar conteúdo (phase 16, A3, A4)', () => {
  it('nascem ligados, mudam por origem, são idempotentes, recusam corpo inválido e a conferência obedece à chave', async () => {
    expect(json(await call('GET', '/api/push/content'))).toEqual({ bots: true, generalChat: true });
    const bot = await call('POST', '/api/bots', { name: 'Bot da chave', color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 25 });
    const botId = json<{ id: string }>(bot).id;
    const eventId = (await api.pool.query<{ id: string }>("INSERT INTO push_events (kind, bot_id, created_at) VALUES ('run_completed', $1, now()) RETURNING id::text AS id", [botId])).rows[0]!.id;
    const checker = await api.login(CLIENT_IP);
    const checkEvent = async () => json<{ events: Record<string, unknown>[] }>(await call('GET', `/api/push/events/check?ids=${eventId}`, undefined, {}, checker)).events[0];
    expect(await checkEvent()).toMatchObject({ valid: true, title: 'Bot da chave' });

    const before = (await api.pool.query("SELECT 1 FROM audit_log WHERE action = 'push.content_set'")).rows.length;
    for (let times = 0; times < 2; times += 1) {
      const off = await call('PUT', '/api/push/content', { origin: 'bots', enabled: false });
      expect(off.statusCode).toBe(200);
      expect(json(off)).toEqual({ bots: false, generalChat: true });
    }
    expect(json(await call('GET', '/api/push/content'))).toEqual({ bots: false, generalChat: true });
    // Chave desligada: a conferência volta ao `{ id, valid }` de antes, sem título, corpo nem id de aprovação.
    expect(await checkEvent()).toEqual({ id: eventId, valid: true });

    expect(json(await call('PUT', '/api/push/content', { origin: 'bots', enabled: true }))).toEqual({ bots: true, generalChat: true });
    expect(await checkEvent()).toMatchObject({ title: 'Bot da chave' });
    const audit = await api.pool.query<{ target: string; details: unknown; actor: string }>("SELECT target, details, actor FROM audit_log WHERE action = 'push.content_set' ORDER BY id");
    expect(audit.rows.slice(before)).toEqual([{ target: 'bots', details: { enabled: false }, actor: 'owner' }, { target: 'bots', details: { enabled: true }, actor: 'owner' }]);

    for (const body of [{}, { origin: 'bots' }, { enabled: true }, { origin: 'tudo', enabled: true }, { origin: 'bots', enabled: 'sim' }, { origin: 'bots', enabled: true, extra: 1 }, { origin: null, enabled: true }]) {
      const bad = await call('PUT', '/api/push/content', body);
      expect([bad.statusCode, errorOf(bad).code], JSON.stringify(body)).toEqual([422, 'VALIDATION_FAILED']);
    }
    expect(json(await call('GET', '/api/push/content'))).toEqual({ bots: true, generalChat: true });
  });
});

// Registro do service worker (phase 16, passo 2; A1 na parte do aparelho e A9): o aparelho reporta recebido, exibido, suprimido com motivo e tocado; a rota
// é idempotente por evento, dispositivo e estado, e toda recusa (sem sessão, sem CSRF ou Origin, corpo acima de 1 KB, valor fora da allowlist, estado e
// motivo que não combinam, dispositivo ou evento inexistente, mais de 120 por minuto) responde com o código estável e NÃO grava nada.
describe('registro do service worker (phase 16; A1, A9)', () => {
  const receiptCount = async () => Number((await api.pool.query<{ total: string }>('SELECT count(*) AS total FROM push_receipts')).rows[0]!.total);

  async function seedEventAndDevice(): Promise<{ eventId: string; deviceId: string; reporter: typeof session }> {
    const bot = await call('POST', '/api/bots', { name: `Bot do registro ${Math.random().toString(36).slice(2, 8)}`, color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 25 });
    expect(bot.statusCode).toBe(201);
    const event = await api.pool.query<{ id: string }>("INSERT INTO push_events (kind, bot_id, created_at) VALUES ('run_completed', $1, now()) RETURNING id::text AS id", [json<{ id: string }>(bot).id]);
    const device = await call('POST', '/api/push/devices', { token: `device-receipt-${Math.random().toString(36).slice(2, 10)}` });
    expect(device.statusCode).toBe(200);
    return { eventId: event.rows[0]!.id, deviceId: json<{ id: string }>(device).id, reporter: await api.login(CLIENT_IP) };
  }

  it('grava cada estado com o motivo, responde 204 sem corpo e repetir não duplica (idempotente por evento, dispositivo e estado)', async () => {
    const { eventId, deviceId, reporter } = await seedEventAndDevice();
    const post = (body: unknown) => call('POST', '/api/push/receipts', body, {}, reporter);

    for (const body of [
      { eventId, deviceId, state: 'received' },
      { eventId, deviceId, state: 'shown', reason: 'check_timeout' },
      { eventId, deviceId, state: 'suppressed', reason: 'owner_looking' },
      { eventId, deviceId, state: 'clicked' },
    ]) {
      const response = await post(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(204);
      expect(response.body).toBe('');
    }
    const rows = () =>
      api.pool.query<{ state: string; reason: string | null }>('SELECT state, reason FROM push_receipts WHERE event_id = $1 AND device_id = $2 ORDER BY state', [eventId, deviceId]);
    expect((await rows()).rows).toEqual([
      { state: 'clicked', reason: null },
      { state: 'received', reason: null },
      { state: 'shown', reason: 'check_timeout' },
      { state: 'suppressed', reason: 'owner_looking' },
    ]);

    // Repetir o mesmo estado (o service worker pode reenviar) responde sucesso e não duplica nem troca o motivo gravado.
    expect((await post({ eventId, deviceId, state: 'received' })).statusCode).toBe(204);
    expect((await post({ eventId, deviceId, state: 'suppressed', reason: 'invalid' })).statusCode).toBe(204);
    expect((await rows()).rows).toHaveLength(4);
    expect((await rows()).rows.find((row) => row.state === 'suppressed')?.reason).toBe('owner_looking');
    expect((await api.pool.query("SELECT 1 FROM audit_log WHERE action LIKE 'push.receipt%'")).rows).toEqual([]); // telemetria, sem auditoria
  });

  it('recusa sem sessão, sem CSRF ou Origin, acima de 1 KB, fora da allowlist, estado e motivo que não combinam, dispositivo ou evento inexistente, e não grava nada', async () => {
    const { eventId, deviceId, reporter } = await seedEventAndDevice();
    const valid = { eventId, deviceId, state: 'received' };
    const before = await receiptCount();
    const post = (body: unknown, headers: Record<string, string> = {}) => call('POST', '/api/push/receipts', body, headers, reporter);

    const anonymous = await api.app.inject({ method: 'POST', url: '/api/push/receipts', payload: valid, headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
    expect([anonymous.statusCode, errorOf(anonymous).code]).toEqual([401, 'AUTH_SESSION_EXPIRED']);
    expect(errorOf(await post(valid, { 'x-csrf-token': 'invalido' })).code).toBe('CSRF_TOKEN_INVALID');
    // Sem o cabeçalho do token (cookie e Origin corretos): a recusa é a mesma de um token inválido.
    const missingToken = await api.app.inject({ method: 'POST', url: '/api/push/receipts', payload: valid, headers: { origin: ORIGIN, cookie: reporter.cookie, 'user-agent': CHROME_UA }, remoteAddress: CLIENT_IP });
    expect([missingToken.statusCode, errorOf(missingToken).code]).toEqual([403, 'CSRF_TOKEN_INVALID']);
    expect(errorOf(await post(valid, { origin: 'https://outro.exemplo' })).code).toBe('CSRF_ORIGIN_INVALID');

    const huge = await post({ ...valid, enchimento: 'x'.repeat(1100) });
    expect([huge.statusCode, errorOf(huge).code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);

    const invalidBodies: Record<string, unknown> = {
      'estado fora da allowlist': { ...valid, state: 'seen' },
      'motivo fora da allowlist': { eventId, deviceId, state: 'suppressed', reason: 'outro' },
      'suprimido sem motivo': { eventId, deviceId, state: 'suppressed' },
      'suprimido por conferência sem resposta': { eventId, deviceId, state: 'suppressed', reason: 'check_timeout' },
      'exibido por conversa aberta': { eventId, deviceId, state: 'shown', reason: 'owner_looking' },
      'recebido com motivo': { ...valid, reason: 'invalid' },
      'campo extra com conteúdo': { ...valid, title: 'Bot' },
      'id do evento mal formado': { ...valid, eventId: 'abc' },
      'id do evento com mais de 18 dígitos': { ...valid, eventId: '9'.repeat(19) },
      'id do dispositivo que não é uuid': { ...valid, deviceId: 'device-1' },
      'sem o estado': { eventId, deviceId },
      'corpo que não é objeto': ['received'],
    };
    for (const [name, body] of Object.entries(invalidBodies)) {
      const response = await post(body);
      expect([response.statusCode, errorOf(response).code], name).toEqual([422, 'VALIDATION_FAILED']);
    }

    const ghostDevice = await post({ ...valid, deviceId: GHOST });
    expect([ghostDevice.statusCode, errorOf(ghostDevice).code]).toEqual([404, 'NOT_FOUND']);
    const ghostEvent = await post({ ...valid, eventId: '999999999' });
    expect([ghostEvent.statusCode, errorOf(ghostEvent).code]).toEqual([404, 'NOT_FOUND']);

    expect(await receiptCount()).toBe(before); // nenhuma recusa gravou
    expect((await post(valid)).statusCode).toBe(204); // e o pedido bom do mesmo corpo base passa
    expect(await receiptCount()).toBe(before + 1);
  });

  it('o dispositivo removido deixa de poder reportar, e a exclusão do evento leva os registros junto', async () => {
    const { eventId, deviceId, reporter } = await seedEventAndDevice();
    const post = (state: string) => call('POST', '/api/push/receipts', { eventId, deviceId, state }, {}, reporter);
    expect((await post('received')).statusCode).toBe(204);
    expect((await call('DELETE', `/api/push/devices/${deviceId}`)).statusCode).toBe(204);
    expect((await post('shown')).statusCode).toBe(404);
    // O registro já gravado fica (o funil conta o que o aparelho reportou antes de sair), e some com o evento (retenção ou exclusão do bot).
    expect((await api.pool.query('SELECT 1 FROM push_receipts WHERE event_id = $1', [eventId])).rowCount).toBe(1);
    await api.pool.query('DELETE FROM push_events WHERE id = $1', [eventId]);
    expect((await api.pool.query('SELECT 1 FROM push_receipts WHERE event_id = $1', [eventId])).rowCount).toBe(0);
  });

  it('limita a 120 por minuto por sessão sem afetar outra sessão', async () => {
    const { eventId, deviceId, reporter } = await seedEventAndDevice();
    const body = { eventId, deviceId, state: 'received' };
    for (let index = 0; index < PUSH_RECEIPTS_PER_MINUTE; index += 1) expect((await call('POST', '/api/push/receipts', body, {}, reporter)).statusCode).toBe(204);
    const limited = await call('POST', '/api/push/receipts', body, {}, reporter);
    expect([limited.statusCode, errorOf(limited).code]).toEqual([429, 'RATE_LIMITED']);
    expect((await call('POST', '/api/push/receipts', body, {}, await api.login(CLIENT_IP))).statusCode).toBe(204);
  });
});
