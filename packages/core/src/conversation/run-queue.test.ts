// A fonte única da fila deve traduzir a exclusão concorrente em erro de domínio antes de inserir dados em uma conversa inexistente.
import { expect, it } from 'vitest';
import { DomainError } from '../errors';
import { createRunsWorld, waitFor } from '../runs/test-support';
import { queueRun } from './run-queue';

it('a exclusão que vence a trava responde BOT_NOT_FOUND e não deixa execução nem evento órfão', async () => {
  const world = await createRunsWorld();
  const holder = await world.pool.connect();
  const sender = await world.pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    const bot = await world.createBot();
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM bots WHERE id = $1 FOR UPDATE', [bot.id]);
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await sender.query('BEGIN');
    pending = queueRun(sender, { botId: bot.id, conversationId, input: 'envio concorrente', at: new Date(), enforceLimit: true }).catch((error: unknown) => error);
    await waitFor('a fila esperando o bot que será excluído', async () => (await world.pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query = 'SELECT id FROM bots WHERE id = $1 FOR UPDATE'", [pid],
    )).rowCount === 1);
    // Bot recém-criado sem trabalho: só essas três tabelas o referenciam. A exclusão mantém a trava até o COMMIT.
    await holder.query('DELETE FROM conversations WHERE bot_id = $1', [bot.id]);
    await holder.query('DELETE FROM bot_memories WHERE bot_id = $1', [bot.id]);
    await holder.query('DELETE FROM bots WHERE id = $1', [bot.id]);
    await holder.query('COMMIT');
    expect(await pending).toEqual(expect.objectContaining<Partial<DomainError>>({ code: 'BOT_NOT_FOUND' }));
    await sender.query('ROLLBACK');
    expect((await world.pool.query('SELECT 1 FROM runs WHERE conversation_id = $1', [conversationId])).rowCount).toBe(0);
    expect((await world.pool.query('SELECT 1 FROM conversation_events WHERE conversation_id = $1', [conversationId])).rowCount).toBe(0);
    await expect(queueRun(sender, { botId: null, conversationId, input: 'sessão ausente', at: new Date(), enforceLimit: true })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  } finally {
    await holder.query('ROLLBACK');
    await pending;
    await sender.query('ROLLBACK');
    holder.release();
    sender.release();
    await world.cleanup();
  }
});
