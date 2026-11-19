// Prova da escrita de presença e leitura pela borda HTTP (phase 3, T2; A2): sessão, Origin e CSRF, corpo estrito de até 1 KB, a presença
// gravada para a sessão do COOKIE (dois logins = duas linhas), revogar a sessão pela API apaga a presença dela, NOT_FOUND para conversa
// inexistente, VALIDATION_FAILED para mensagem de outra conversa e RATE_LIMITED acima de 30 por minuto por sessão. Monotonicidade e o
// vencimento de 45 s com relógio controlado estão provados no core (`presence.test.ts`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

const CLIENT_IP = '203.0.113.71';
const GHOST = '00000000-0000-4000-8000-000000000000';

let api: TestApi;
let session: Awaited<ReturnType<TestApi['login']>>;

beforeAll(async () => {
  api = await createTestApi();
  session = await api.login(CLIENT_IP);
});

afterAll(async () => {
  await api.cleanup();
});

/** Chamada autenticada por padrão (cookie, Origin e token CSRF) com a sessão informada. */
async function call(method: 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}, as = session) {
  return api.app.inject({
    method,
    url,
    payload: payload as object | string | undefined,
    headers: { origin: ORIGIN, cookie: as.cookie, 'x-csrf-token': as.csrfToken, 'user-agent': CHROME_UA, ...headers },
    remoteAddress: CLIENT_IP,
  });
}

const put = (payload: unknown, headers: Record<string, string> = {}, as = session) => call('PUT', '/api/presence', payload, headers, as);
const codeOf = (response: { json: () => unknown }) => (response.json() as { code: string }).code;

/** Linhas de presença por sessão, como o banco as guarda. */
const presenceRows = async () =>
  (await api.pool.query<{ session_id: string; conversation_id: string }>('SELECT session_id, conversation_id FROM conversation_presence ORDER BY session_id')).rows;

async function createBot(name: string): Promise<string> {
  const created = await call('POST', '/api/bots', { name, color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 25 });
  expect(created.statusCode).toBe(201);
  return (created.json() as { id: string }).id;
}

describe('segurança da borda', () => {
  it('exige sessão, Origin e token CSRF, e recusa corpo fora do contrato ou acima de 1 KB sem gravar nada', async () => {
    const botId = await createBot('Presença borda');
    const body = { conversationKind: 'bot', conversationId: botId, present: true };

    const anonymous = await api.app.inject({ method: 'PUT', url: '/api/presence', payload: body, headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
    expect(anonymous.statusCode).toBe(401);
    expect(codeOf(anonymous)).toBe('AUTH_SESSION_EXPIRED');
    expect(codeOf(await put(body, { origin: 'https://outro.exemplo' }))).toBe('CSRF_ORIGIN_INVALID');
    expect(codeOf(await put(body, { 'x-csrf-token': 'invalido' }))).toBe('CSRF_TOKEN_INVALID');

    for (const invalid of [
      { ...body, sessionId: session.sessionId }, // campo extra: a sessão nunca vem do navegador
      { ...body, conversationKind: 'routine' },
      { ...body, conversationId: 'nao-e-uuid' },
      { ...body, readThrough: 12 },
      { ...body, readThrough: '-1' },
      { conversationKind: 'bot', conversationId: botId },
    ]) {
      const response = await put(invalid);
      expect(response.statusCode, JSON.stringify(invalid)).toBe(422);
      expect(codeOf(response)).toBe('VALIDATION_FAILED');
    }
    const oversized = await put(JSON.stringify({ ...body, readThrough: null, padding: 'x'.repeat(1024) }), { 'content-type': 'application/json' });
    expect(oversized.statusCode).toBe(413);
    expect(codeOf(oversized)).toBe('PAYLOAD_TOO_LARGE');
    expect(await presenceRows()).toEqual([]);
  });
});

describe('presença e leitura', () => {
  it('grava por sessão do cookie, avança a leitura, recusa conversa inexistente e mensagem alheia, e a revogação apaga a presença', async () => {
    const botId = await createBot('Presença fluxo');
    const chat = await call('POST', '/api/chat/sessions');
    expect(chat.statusCode).toBe(201);
    const chatId = (chat.json() as { id: string }).id;
    const conversationId = (await api.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [botId])).rows[0]!.id;
    const message = await api.pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, created_at) VALUES ($1, 'user', 'text', 'done', true, 'oi', now()) RETURNING id::text`,
      [conversationId],
    );
    const messageId = message.rows[0]!.id;

    const phone = await api.login(CLIENT_IP);
    expect((await put({ conversationKind: 'bot', conversationId: botId, readThrough: messageId, present: true })).statusCode).toBe(204);
    expect((await put({ conversationKind: 'chat', conversationId: chatId, present: true }, {}, phone)).statusCode).toBe(204);
    const rows = await presenceRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.session_id === session.sessionId)?.conversation_id).toBe(conversationId);
    expect(rows.find((row) => row.session_id === phone.sessionId)?.conversation_id).toBe(chatId);
    expect((await api.pool.query('SELECT read_through_message_id::text AS r FROM conversations WHERE id = $1', [conversationId])).rows[0].r).toBe(messageId);

    expect(codeOf(await put({ conversationKind: 'bot', conversationId: GHOST, present: true }))).toBe('NOT_FOUND');
    expect(codeOf(await put({ conversationKind: 'chat', conversationId: botId, present: true }))).toBe('NOT_FOUND');
    const foreign = await put({ conversationKind: 'chat', conversationId: chatId, readThrough: messageId, present: true });
    expect(foreign.statusCode).toBe(422);
    expect(codeOf(foreign)).toBe('VALIDATION_FAILED');

    // Encerrar a sessão do celular em Conta apaga a presença dela; a do PC continua.
    expect((await call('DELETE', `/api/auth/sessions/${phone.sessionId}`)).statusCode).toBe(204);
    expect((await presenceRows()).map((row) => row.session_id)).toEqual([session.sessionId]);

    // Término: a presença desta sessão some.
    expect((await put({ conversationKind: 'bot', conversationId: botId, present: false })).statusCode).toBe(204);
    expect(await presenceRows()).toEqual([]);
  });

  it('acima de 30 escritas por minuto na mesma sessão devolve RATE_LIMITED com Retry-After, sem afetar outra sessão', async () => {
    const botId = await createBot('Presença limite');
    const busy = await api.login(CLIENT_IP);
    const body = { conversationKind: 'bot', conversationId: botId, present: true };
    for (let index = 0; index < 30; index += 1) expect((await put(body, {}, busy)).statusCode).toBe(204);
    const limited = await put(body, {}, busy);
    expect(limited.statusCode).toBe(429);
    expect(codeOf(limited)).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await put(body)).statusCode).toBe(204);
  });
});
