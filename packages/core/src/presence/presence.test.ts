// Prova da presença e da leitura por conversa (phase 3, T2; A2; Suposições 3 a 5) contra PostgreSQL real com a migration 0021 aplicada e
// RELÓGIO CONTROLADO: a presença vale por 45 s sem renovação e só para sessão não vencida, a leitura só avança e pertence à conversa,
// revogar a sessão ou apagar a conversa leva a presença junto, o limite é de 30 escritas por minuto por sessão e o rollback da 0021
// preserva conversas e sessões. As consultas exercitadas são as que o envio de avisos (T3) e o "não lido" (T5) vão usar.
import { PRESENCE_TTL_MS, PRESENCE_WRITES_PER_MINUTE, type PresenceUpdate } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AuthService } from '../auth/service';
import { createCredentialVerifier } from '../auth/credentials';
import { migrateTestDatabase } from '../testing/migrate';
import { MIGRATIONS } from '../db/migrations';
import { createPool, type Pool } from '../db/pool';
import { DomainError } from '../errors';
import { createLogger } from '../logging';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { PresenceService, hasLivePresence, isReadThrough, readThroughOf } from './service';

const DAY = 24 * 60 * 60 * 1000;
const GHOST = '00000000-0000-4000-8000-000000000000';

let database: TestDatabase;
let pool: Pool;
let now = new Date('2026-10-08T12:00:00Z');
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};
const clock = () => now;

/** Código da DomainError lançada, ou OK. */
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `INESPERADO:${String(error)}`;
  }
};

/** Sessão de login válida por 30 dias a partir do relógio do teste. */
async function newSession(): Promise<string> {
  const created = await pool.query<{ id: string }>(
    `INSERT INTO sessions (token_hash, created_at, last_used_at, expires_at, ip) VALUES (md5(random()::text), $1, $1, $2, '127.0.0.1') RETURNING id`,
    [now, new Date(now.getTime() + 30 * DAY)],
  );
  return created.rows[0]!.id;
}

/** Bot com a conversa única dele; devolve o id do bot (o que a web informa) e o da conversa (o que T3/T5 consultam). */
async function newBot(name: string): Promise<{ botId: string; conversationId: string }> {
  const bot = await pool.query<{ id: string }>(
    `INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ($1, lower($1), '#60A5FA', $2, $2) RETURNING id`,
    [name, now],
  );
  const botId = bot.rows[0]!.id;
  const conversation = await pool.query<{ id: string }>('INSERT INTO conversations (bot_id, created_at) VALUES ($1, $2) RETURNING id', [botId, now]);
  return { botId, conversationId: conversation.rows[0]!.id };
}

/** Sessão do Chat geral (conversa sem bot); o id é o mesmo para a web e para o core. */
async function newChat(): Promise<string> {
  return (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES ($1) RETURNING id', [now])).rows[0]!.id;
}

/** Mensagens do dono na conversa, em ordem; devolve os ids. */
async function addMessages(conversationId: string, count: number): Promise<string[]> {
  const created = await pool.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, created_at)
     SELECT $1::uuid, 'user', 'text', 'done', true, 'oi', $2::timestamptz FROM generate_series(1, $3::int) RETURNING id::text`,
    [conversationId, now, count],
  );
  return created.rows.map((row) => row.id).sort((a, b) => Number(a) - Number(b));
}

const bot = (botId: string, extra: Partial<PresenceUpdate> = {}): PresenceUpdate => ({ conversationKind: 'bot', conversationId: botId, present: true, ...extra });
const chat = (id: string, extra: Partial<PresenceUpdate> = {}): PresenceUpdate => ({ conversationKind: 'chat', conversationId: id, present: true, ...extra });

beforeAll(async () => {
  database = await createTestDatabase(inject('adminDatabaseUrl'));
  pool = createPool(database.url, { applicationName: 'aion-test-presence' });
  await migrateTestDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await database.drop();
});

describe('presença por sessão', () => {
  it('vale enquanto renovada, vence 45 s depois da última renovação, termina na hora e segue a conversa aberta no aparelho', async () => {
    const presence = new PresenceService({ pool, now: clock });
    const session = await newSession();
    const other = await newSession();
    const { botId, conversationId } = await newBot('Presença');
    const chatId = await newChat();

    expect(await hasLivePresence(pool, conversationId, now)).toBe(false);
    await presence.update(session, bot(botId));
    expect(await hasLivePresence(pool, conversationId, now)).toBe(true);
    expect(await hasLivePresence(pool, conversationId, new Date(now.getTime() + PRESENCE_TTL_MS - 1))).toBe(true);
    expect(await hasLivePresence(pool, conversationId, new Date(now.getTime() + PRESENCE_TTL_MS))).toBe(false);

    // Renovar a cada 20 s mantém a presença além dos 45 s iniciais.
    advance(20_000);
    await presence.update(session, bot(botId));
    advance(40_000);
    expect(await hasLivePresence(pool, conversationId, now)).toBe(true);

    // Trocar de conversa no mesmo aparelho move a presença; o término atrasado da anterior não apaga a atual.
    await presence.update(session, chat(chatId));
    expect(await hasLivePresence(pool, conversationId, now)).toBe(false);
    await presence.update(session, bot(botId, { present: false }));
    expect(await hasLivePresence(pool, chatId, now)).toBe(true);

    // Outro aparelho na mesma conversa: o término de um não encerra o do outro.
    await presence.update(other, chat(chatId));
    await presence.update(session, chat(chatId, { present: false }));
    expect(await hasLivePresence(pool, chatId, now)).toBe(true);
    await presence.update(other, chat(chatId, { present: false }));
    expect(await hasLivePresence(pool, chatId, now)).toBe(false);
  });

  it('revogar a sessão apaga a presença dela, sessão vencida não conta e apagar a conversa leva a presença junto', async () => {
    const presence = new PresenceService({ pool, now: clock });
    const verifier = await createCredentialVerifier({ email: 'dono@aion.test', password: 'senha-de-teste-do-dono-1' }, Buffer.alloc(32, 7));
    const logger = createLogger({ level: 'silent', name: 'test' });
    const auth = new AuthService({ pool, verifier, masterKey: Buffer.alloc(32, 7), logger, now: clock });
    const { botId, conversationId } = await newBot('Revogação');

    const revoked = await newSession();
    await presence.update(revoked, bot(botId));
    await auth.revokeSession(revoked, { ip: '127.0.0.1', userAgent: 'teste' });
    expect((await pool.query('SELECT 1 FROM conversation_presence WHERE session_id = $1', [revoked])).rowCount).toBe(0);
    expect(await hasLivePresence(pool, conversationId, now)).toBe(false);

    const expiring = await newSession();
    await presence.update(expiring, bot(botId));
    await pool.query('UPDATE sessions SET expires_at = $2 WHERE id = $1', [expiring, new Date(now.getTime() - 1)]);
    expect(await hasLivePresence(pool, conversationId, now)).toBe(false);

    const chatId = await newChat();
    const session = await newSession();
    await presence.update(session, chat(chatId));
    await pool.query('DELETE FROM conversations WHERE id = $1', [chatId]);
    expect((await pool.query('SELECT 1 FROM conversation_presence WHERE session_id = $1', [session])).rowCount).toBe(0);
  });
});

describe('leitura por conversa', () => {
  it('só avança, pertence à conversa e é recusada para conversa inexistente, sem gravar nada', async () => {
    const presence = new PresenceService({ pool, now: clock });
    const session = await newSession();
    const { botId, conversationId } = await newBot('Leitura');
    const chatId = await newChat();
    const [first, second, third] = await addMessages(conversationId, 3);
    const [foreign] = await addMessages(chatId, 1);

    expect(await readThroughOf(pool, conversationId)).toBeNull();
    expect(await isReadThrough(pool, conversationId, first!)).toBe(false);

    await presence.update(session, bot(botId, { readThrough: second, present: false }));
    expect(await readThroughOf(pool, conversationId)).toBe(second);
    expect(await isReadThrough(pool, conversationId, first!)).toBe(true);
    expect(await isReadThrough(pool, conversationId, second!)).toBe(true);
    expect(await isReadThrough(pool, conversationId, third!)).toBe(false);

    // Requisição atrasada de outro aparelho com posição anterior: a leitura não volta. Nulo não mexe.
    await presence.update(session, bot(botId, { readThrough: first }));
    await presence.update(session, bot(botId, { readThrough: null }));
    expect(await readThroughOf(pool, conversationId)).toBe(second);

    // Mensagem de outra conversa (anti-IDOR), conversa inexistente e o tipo errado para o id: nada muda.
    expect(await codeOf(presence.update(session, bot(botId, { readThrough: foreign })))).toBe('VALIDATION_FAILED');
    expect(await codeOf(presence.update(session, bot(botId, { readThrough: '999999999' })))).toBe('VALIDATION_FAILED');
    expect(await codeOf(presence.update(session, bot(GHOST)))).toBe('NOT_FOUND');
    expect(await codeOf(presence.update(session, chat(botId)))).toBe('NOT_FOUND');
    expect(await codeOf(presence.update(session, bot(chatId)))).toBe('NOT_FOUND');
    expect(await readThroughOf(pool, conversationId)).toBe(second);
    expect(await readThroughOf(pool, chatId)).toBeNull();
  });
});

describe('limite por sessão', () => {
  it('aceita 30 escritas por minuto por sessão, recusa a seguinte com RATE_LIMITED sem afetar outra sessão e libera com o tempo', async () => {
    const presence = new PresenceService({ pool, now: clock });
    const session = await newSession();
    const other = await newSession();
    const { botId } = await newBot('Limite');
    for (let index = 0; index < PRESENCE_WRITES_PER_MINUTE; index += 1) await presence.update(session, bot(botId));
    expect(await codeOf(presence.update(session, bot(botId)))).toBe('RATE_LIMITED');
    expect(await codeOf(presence.update(other, bot(botId)))).toBe('OK');
    advance(60_000);
    expect(await codeOf(presence.update(session, bot(botId)))).toBe('OK');
  });
});

describe('migration 0021', () => {
  it('o rollback remove só presença e leitura, preservando conversas e sessões, e o up roda de novo', async () => {
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0021_presence_read')!;
    expect(migration.destructive).toBeFalsy();
    const conversations = (await pool.query('SELECT 1 FROM conversations')).rowCount;
    const sessions = (await pool.query('SELECT 1 FROM sessions')).rowCount;
    await pool.query(migration.rollback);
    expect((await pool.query("SELECT to_regclass('conversation_presence') AS t")).rows[0].t).toBeNull();
    expect((await pool.query('SELECT 1 FROM conversations')).rowCount).toBe(conversations);
    expect((await pool.query('SELECT 1 FROM sessions')).rowCount).toBe(sessions);
    await pool.query(migration.up);
    expect(await readThroughOf(pool, (await pool.query<{ id: string }>('SELECT id FROM conversations LIMIT 1')).rows[0]!.id)).toBeNull();
  });
});
