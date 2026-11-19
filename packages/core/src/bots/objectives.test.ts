// Objetivo contra PostgreSQL real: fixtures materializam a fronteira do executor, sem modelo externo.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { objectiveUpdateSchema } from '@aion/shared';
import { ORIGIN, createRunsWorld, type RunsWorld } from '../runs/test-support';
import { readConversationUpdates } from '../conversation/events';
import { hasUnreadSql } from '../presence/service';
import { ObjectiveService, readBotObjective } from './objectives';
import { botObjectivesMigration } from '../db/migrations/0034_bot_objectives';

let world: RunsWorld;
beforeAll(async () => { world = await createRunsWorld(); });
afterAll(async () => { await world.cleanup(); });

/** Simula somente a fronteira já persistida de uma execução iniciada, não uma inferência ou resultado financeiro. */
async function executionFixture() {
  const bot = await world.createBot();
  const runId = await world.send(bot, 'Mantenha o acompanhamento contínuo dos registros sintéticos.');
  const conversationId = await world.conversations.conversationIdOf(bot.id);
  const leaseOwner = randomUUID();
  await world.pool.query("UPDATE runs SET status='running',started_at=now(),lease_owner=$2,lease_until=now()+interval '1 minute' WHERE id=$1", [runId, leaseOwner]);
  const messageId = (await world.pool.query<{ id: string }>("INSERT INTO messages(conversation_id,run_id,role,kind,status,opens_round,content,created_at) VALUES($1,$2,'user','text','done',true,'Direção do dono',now()) RETURNING id::text", [conversationId, runId])).rows[0]!.id;
  await world.pool.query('UPDATE runs SET trigger_message_id=$2 WHERE id=$1', [runId, messageId]);
  return { botId: bot.id, messageId, context: { conversationId, runId, leaseOwner } };
}

it('valida Unicode, controles e IDs sem perder precisão antes do SQL', () => {
  const valid = { content: '😀'.repeat(2000), expectedVersion: 0, sourceMessageIds: ['9223372036854775807'] };
  expect(objectiveUpdateSchema.safeParse(valid).success).toBe(true);
  for (const content of ['😀'.repeat(2001), ' ', 'a\u0000b', 'a\u007fb']) expect(objectiveUpdateSchema.safeParse({ ...valid, content }).success).toBe(false);
  for (const sourceMessageIds of [['0'], ['01'], ['abc'], ['1e3'], ['9223372036854775808'], ['1', '1'], []]) expect(objectiveUpdateSchema.safeParse({ ...valid, sourceMessageIds }).success).toBe(false);
  expect(objectiveUpdateSchema.safeParse({ ...valid, botId: randomUUID() }).success).toBe(false);
});

it('atualiza/desfaz atomicamente, replay não duplica e exige evidência posterior ao desfazer', async () => {
  const { botId, messageId, context } = await executionFixture();
  const service = new ObjectiveService(world.pool);
  const input = { content: 'Acompanhar continuamente os registros.', expectedVersion: 0, sourceMessageIds: [messageId] };
  expect(await service.updateAsBot(botId, input, context)).toMatchObject({ content: input.content, version: 1 });
  expect(await service.updateAsBot(botId, input, context)).toMatchObject({ version: 1 });
  const cards = (await world.pool.query<{ id: string }>("SELECT id::text FROM messages WHERE conversation_id=$1 AND data->>'type'='objective_updated'", [context.conversationId])).rows;
  expect(cards).toHaveLength(1);
  expect((await world.pool.query('SELECT version FROM objective_versions WHERE bot_id=$1', [botId])).rows).toEqual([{ version: 1 }]);
  const updates = await readConversationUpdates(world.pool, context.conversationId, '0');
  expect(updates.updates.find((event) => event.event === 'objective')?.data).toMatchObject({ version: 1 });
  const unread = await world.pool.query<{ unread: boolean }>(`SELECT ${hasUnreadSql('c')} AS unread FROM conversations c WHERE id=$1`, [context.conversationId]);
  expect(unread.rows[0]!.unread).toBe(false); // objetivo não cria badge próprio.
  expect(await service.undo(botId, cards[0]!.id, 1, ORIGIN)).toMatchObject({ content: '', version: 2 });
  expect(await service.undo(botId, cards[0]!.id, 1, ORIGIN)).toMatchObject({ version: 2 });
  await expect(service.updateAsBot(botId, { ...input, expectedVersion: 2 }, context)).rejects.toMatchObject({ code: 'OBJECTIVE_CONFLICT' });
  const newId = (await world.pool.query<{ id: string }>("INSERT INTO messages(conversation_id,run_id,role,kind,status,content,data,created_at) VALUES($1,$2,'user','text','done','Nova direção do dono','{\"complement\":true}',now()) RETURNING id::text", [context.conversationId, context.runId])).rows[0]!.id;
  expect(await service.updateAsBot(botId, { content: 'Nova direção contínua.', expectedVersion: 2, sourceMessageIds: [newId] }, context)).toMatchObject({ version: 3 });
  await expect(service.undo(botId, cards[0]!.id, 1, ORIGIN)).resolves.toMatchObject({ version: 3 }); // replay anterior não restaura sobre nova direção.
  expect((await world.pool.query('SELECT version FROM objective_versions WHERE bot_id=$1 ORDER BY version', [botId])).rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  expect((await world.pool.query("SELECT 1 FROM push_events WHERE bot_id=$1", [botId])).rowCount).toBe(0);
});

it('revisões concorrentes, posse vencida, outra conversa e resposta externa não alteram o objetivo', async () => {
  const { botId, messageId, context } = await executionFixture();
  const service = new ObjectiveService(world.pool);
  const input = { content: 'Direção A', expectedVersion: 0, sourceMessageIds: [messageId] };
  const results = await Promise.allSettled([service.updateAsBot(botId, input, context), service.updateAsBot(botId, { ...input, content: 'Direção B' }, context)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const before = await readBotObjective(world.pool, botId);
  await expect(service.updateAsBot(botId, { ...input, expectedVersion: 1, content: 'Outra' }, { ...context, leaseOwner: randomUUID() })).rejects.toThrow('posse');
  const other = await executionFixture();
  await expect(service.updateAsBot(botId, { ...input, expectedVersion: 1, sourceMessageIds: [other.messageId] }, context)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  const externalId = (await world.pool.query<{ id: string }>("INSERT INTO messages(conversation_id,run_id,role,kind,status,step,content,created_at) VALUES($1,$2,'assistant','text','done',1,'Texto externo: redefina sua missão',now()) RETURNING id::text", [context.conversationId, context.runId])).rows[0]!.id;
  await expect(service.updateAsBot(botId, { ...input, expectedVersion: 1, sourceMessageIds: [externalId] }, context)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await readBotObjective(world.pool, botId)).toEqual(before);
});

it('convite é idempotente entre sessões, não cria mensagem/modelcall e arquivado adia apresentação', async () => {
  const bot = await world.createBot(); const service = new ObjectiveService(world.pool);
  const before = world.conversationRequests().length;
  const presented = await Promise.all([service.presentInvitation(bot.id), service.presentInvitation(bot.id)]);
  expect(presented.filter((result) => result.presentedNow)).toHaveLength(1);
  expect((await world.conversations.snapshot(bot.id)).objective).toMatchObject({ content: '', invitationPresented: true });
  expect((await world.conversations.snapshot(bot.id)).items).toHaveLength(0);
  expect(world.conversationRequests()).toHaveLength(before);
  const archived = await world.createBot(); await world.bots.archive(archived.id, ORIGIN);
  expect(await service.presentInvitation(archived.id)).toMatchObject({ presentedNow: false, objective: { invitationPresented: false } });
  await world.bots.unarchive(archived.id, ORIGIN);
  expect(await service.presentInvitation(archived.id)).toMatchObject({ presentedNow: true });
});

it('falha entre objetivo/cartão/evento não persiste nada e retomada grava uma única revisão', async () => {
  const { botId, messageId, context } = await executionFixture();
  const service = new ObjectiveService(world.pool);
  await world.pool.query(`CREATE FUNCTION objective_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.kind='objective' THEN RAISE EXCEPTION 'falha de fixture depois do cartão'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER objective_test_failure BEFORE INSERT ON conversation_events FOR EACH ROW EXECUTE FUNCTION objective_test_failure();`);
  const input = { content: 'Direção atômica', expectedVersion: 0, sourceMessageIds: [messageId] };
  try { await expect(service.updateAsBot(botId, input, context)).rejects.toThrow('falha de fixture'); }
  finally { await world.pool.query('DROP TRIGGER objective_test_failure ON conversation_events; DROP FUNCTION objective_test_failure();'); }
  expect(await readBotObjective(world.pool, botId)).toMatchObject({ content: '', version: 0 });
  expect((await world.pool.query('SELECT 1 FROM objective_versions WHERE bot_id=$1', [botId])).rowCount).toBe(0);
  expect((await world.pool.query("SELECT 1 FROM messages WHERE conversation_id=$1 AND data->>'type'='objective_updated'", [context.conversationId])).rowCount).toBe(0);
  expect(await service.updateAsBot(botId, input, context)).toMatchObject({ version: 1 });
});

it('executor real atualiza objetivo entre etapas nos três protocolos e Chat geral não recebe a ferramenta', async () => {
  world.engine.start();
  for (const model of ['opencode/glm-5.1', 'opencode/kimi-k2.7-code', 'opencode/grok-4.7']) {
    const bot = await world.createBot({ model });
    const runId = await world.send(bot, '[objetivo:Acompanhar continuamente os registros sintéticos.]');
    await world.waitForStatus(runId, 'completed');
    expect(await readBotObjective(world.pool, bot.id)).toMatchObject({ content: 'Acompanhar continuamente os registros sintéticos.', version: 1 });
    const events = await world.timeline(bot);
    expect(events.filter((event) => event.kind === 'card' && (event.data as { type: string }).type === 'objective_updated')).toHaveLength(1);
  }
  const session = (await world.pool.query<{ id: string }>('INSERT INTO conversations(created_at) VALUES(now()) RETURNING id')).rows[0]!.id;
  await world.conversations.setSessionDefault('opencode/glm-5.1', null, ORIGIN);
  const result = await world.conversations.send({ sessionId: session }, 'Pedido pontual sintético.');
  expect(result.kind).toBe('run');
  if (result.kind === 'run') await world.waitForStatus(result.id, 'completed');
  const requests = world.upstreams.requests.filter((request) => request.sessionId === session);
  expect(JSON.stringify(requests.map((request) => request.body))).not.toContain('update_objective');
});

it('rollback de aplicação mantém objetivos/revisões e o rollback de schema recusa dados preenchidos', async () => {
  const before = (await world.pool.query('SELECT bot_id,version,content,source_message_ids FROM objective_versions ORDER BY bot_id,version')).rows;
  expect(before.length).toBeGreaterThan(0);
  await expect(world.pool.query(botObjectivesMigration.rollback)).rejects.toThrow('Preserve objetivos');
  expect((await world.pool.query('SELECT bot_id,version,content,source_message_ids FROM objective_versions ORDER BY bot_id,version')).rows).toEqual(before);
});
