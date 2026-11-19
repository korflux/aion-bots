// Prova da regra de novidade não lida (phase 3, T5; F4/A7; Suposição 5 da spec) contra PostgreSQL real, pelas duas listas que a expõem: a de bots
// (`BotService.list`) e a de sessões do Chat geral (`GeneralChatService.list`), ambas com a regra única `hasUnreadSql`.
//
// Casos: conversa nunca lida com novidade conta como não lida; mensagens do dono, texto em escrita, atividade de ferramenta e descartado não contam;
// a resposta concluída e o cartão de sistema contam; a leitura gravada pela presença (em qualquer sessão de login) apaga a novidade, e a novidade
// seguinte a acende de novo; o bot arquivado também traz `unread` (quem decide que ele não acende Bots é a web); o silenciamento de avisos não interfere.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { BotService } from '../bots/service';
import { migrateTestDatabase } from '../testing/migrate';
import { createPool, type Pool } from '../db/pool';
import { GeneralChatService } from '../general-chat/service';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { PresenceService } from './service';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-08T12:00:00Z');
const clock = () => now;

let database: TestDatabase;
let pool: Pool;
let bots: BotService;
let chats: GeneralChatService;
let presence: PresenceService;

/** Sessão de login válida (a presença grava por sessão). */
async function newSession(): Promise<string> {
  const created = await pool.query<{ id: string }>(
    `INSERT INTO sessions (token_hash, created_at, last_used_at, expires_at, ip) VALUES (md5(random()::text), $1, $1, $2, '127.0.0.1') RETURNING id`,
    [now, new Date(now.getTime() + 30 * DAY)],
  );
  return created.rows[0]!.id;
}

/** Bot com a conversa única dele. */
async function newBot(name: string): Promise<{ botId: string; conversationId: string }> {
  const bot = await pool.query<{ id: string }>(
    `INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ($1, lower($1), '#60A5FA', $2, $2) RETURNING id`,
    [name, now],
  );
  const botId = bot.rows[0]!.id;
  const conversation = await pool.query<{ id: string }>('INSERT INTO conversations (bot_id, created_at) VALUES ($1, $2) RETURNING id', [botId, now]);
  return { botId, conversationId: conversation.rows[0]!.id };
}

/** Sessão do Chat geral (conversa sem bot). */
async function newChat(): Promise<string> {
  return (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES ($1) RETURNING id', [now])).rows[0]!.id;
}

/** As linhas da linha do tempo que importam para a regra, com o formato que o CHECK da 0006 exige para cada tipo. */
type Line = 'owner' | 'streaming' | 'answer' | 'activity' | 'discarded' | 'card';
const LINE_SQL: Record<Line, string> = {
  owner: `'user', 'text', 'done', NULL`,
  streaming: `'assistant', 'text', 'streaming', 1`,
  answer: `'assistant', 'text', 'done', 1`,
  activity: `'assistant', 'activity', 'completed', 1`,
  discarded: `'assistant', 'text', 'discarded', 1`,
  card: `'system', 'card', 'done', NULL`,
};

/** Acrescenta uma linha à conversa e devolve o id. */
async function add(conversationId: string, line: Line): Promise<string> {
  const created = await pool.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, role, kind, status, step, content, created_at) VALUES ($1, ${LINE_SQL[line]}, 'x', $2) RETURNING id::text`,
    [conversationId, now],
  );
  return created.rows[0]!.id;
}

const botUnread = async (botId: string): Promise<boolean | undefined> => (await bots.list()).find((bot) => bot.id === botId)?.unread;
const chatUnread = async (id: string): Promise<boolean | undefined> => (await chats.list()).items.find((session) => session.id === id)?.unread;

beforeAll(async () => {
  database = await createTestDatabase(inject('adminDatabaseUrl'));
  pool = createPool(database.url, { applicationName: 'aion-test-unread' });
  await migrateTestDatabase(pool);
  bots = new BotService({ pool, models: { validateSelection: async () => undefined }, now: clock });
  chats = new GeneralChatService({ pool, now: clock });
  presence = new PresenceService({ pool, now: clock });
});

afterAll(async () => {
  await pool.end();
  await database.drop();
});

describe('novidade não lida na lista de bots', () => {
  it('só a resposta concluída e o cartão contam, a leitura de outra sessão apaga e a novidade seguinte acende de novo', async () => {
    const { botId, conversationId } = await newBot('Leitor');
    expect(await botUnread(botId), 'sem mensagens').toBe(false);

    // O que não é novidade: mensagem do dono, texto ainda em escrita, atividade de ferramenta e texto descartado (conversa nunca lida).
    for (const line of ['owner', 'streaming', 'activity', 'discarded'] as const) await add(conversationId, line);
    expect(await botUnread(botId), 'só linhas que não contam').toBe(false);

    // A resposta concluída, numa conversa nunca lida (leitura nula), conta como não lida.
    const answer = await add(conversationId, 'answer');
    expect(await botUnread(botId), 'resposta concluída sem leitura gravada').toBe(true);

    // A leitura gravada em OUTRA sessão de login (outro aparelho) apaga a novidade para todos.
    await presence.update(await newSession(), { conversationKind: 'bot', conversationId: botId, present: true, readThrough: answer });
    expect(await botUnread(botId), 'lida em outra sessão').toBe(false);

    // Depois da leitura: a mensagem do dono não acende; o cartão de sistema (rotina, falha...) acende.
    await add(conversationId, 'owner');
    expect(await botUnread(botId)).toBe(false);
    const card = await add(conversationId, 'card');
    expect(await botUnread(botId), 'cartão posterior à leitura').toBe(true);
    await presence.update(await newSession(), { conversationKind: 'bot', conversationId: botId, present: false, readThrough: card });
    expect(await botUnread(botId), 'lida no término da presença').toBe(false);

    // O aviso de rotina confirmada registra a ação do próprio dono: não acende.
    await pool.query(
      `INSERT INTO messages (conversation_id, role, kind, status, content, data, created_at) VALUES ($1, 'system', 'card', 'done', 'x', $2, $3)`,
      [conversationId, JSON.stringify({ type: 'routine_confirmed', routineId: null, routineName: 'R', action: 'create' }), now],
    );
    expect(await botUnread(botId), 'confirmação do próprio dono').toBe(false);
  });

  it('o bot arquivado também traz a novidade, e silenciar os avisos dele não a apaga', async () => {
    const { botId, conversationId } = await newBot('Arquivado com novidade');
    await add(conversationId, 'card');
    await pool.query('UPDATE bots SET archived_at = $2 WHERE id = $1', [botId, now]);
    await pool.query("INSERT INTO push_mutes (bot_id, kind, created_at) VALUES ($1, 'run_completed', $2)", [botId, now]);
    const listed = (await bots.list()).find((bot) => bot.id === botId);
    expect(listed).toMatchObject({ archivedAt: now.toISOString(), unread: true });
  });

  it('a lista inteira sai numa consulta só, com a novidade de cada bot independente das outras', async () => {
    const quiet = await newBot('Quieto');
    const loud = await newBot('Falante');
    await add(quiet.conversationId, 'owner');
    await add(loud.conversationId, 'answer');
    const listed = await bots.list();
    expect(listed.find((bot) => bot.id === quiet.botId)?.unread).toBe(false);
    expect(listed.find((bot) => bot.id === loud.botId)?.unread).toBe(true);
  });
});

describe('novidade não lida na lista do Chat geral', () => {
  it('a mesma regra vale para a sessão: resposta concluída acende, a leitura apaga, o cartão seguinte acende de novo', async () => {
    const id = await newChat();
    await add(id, 'owner');
    await add(id, 'streaming');
    expect(await chatUnread(id), 'dono e texto em escrita').toBe(false);

    const answer = await add(id, 'answer');
    expect(await chatUnread(id), 'resposta concluída nunca lida').toBe(true);
    expect((await chats.get(id)).unread, 'a leitura de uma sessão também traz o campo').toBe(true);

    await presence.update(await newSession(), { conversationKind: 'chat', conversationId: id, present: true, readThrough: answer });
    expect(await chatUnread(id)).toBe(false);
    await add(id, 'activity');
    expect(await chatUnread(id), 'atividade de ferramenta não conta').toBe(false);
    await add(id, 'card');
    expect(await chatUnread(id), 'cartão posterior à leitura').toBe(true);
  });
});
