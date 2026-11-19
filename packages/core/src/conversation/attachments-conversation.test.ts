// Jornada dos anexos na fila, na mensagem e no retry, com PostgreSQL e worker reais.
import { conversationAttachmentSchema, messageViewSchema, runViewSchema, sendMessageRequestSchema } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentService } from '../attachments/service';
import { GeneralChatService } from '../general-chat/service';
import { createRunsWorld, waitFor, type RunsWorld } from '../runs/test-support';
import { JPEG_FIXTURE } from '../testing/attachment-fixtures';

let world: RunsWorld;
let files: AttachmentService;
beforeAll(async () => { world = await createRunsWorld(); files = new AttachmentService({ pool: world.pool, conversations: world.conversations }); });
afterAll(async () => { await world.cleanup(); });

describe('anexos na conversa', () => {
  it('fila e SSE têm metadados; claim cria uma única bolha; retry conserva anexos; mensagem sem arquivo segue vazia', async () => {
    const bot = await world.createBot();
    const file = await files.upload(bot.id, 'relatório.txt', Buffer.from('conteúdo privado do documento'));
    const metadata = { id: file.id, name: file.name, kind: 'document', sizeBytes: file.originalBytes, removed: false };
    const queued = await world.conversations.send(bot.id, '[falha]', [file.id]);
    expect(queued.attachments).toEqual([metadata]);
    const queuedSnapshot = await world.conversations.snapshot(bot.id);
    expect(queuedSnapshot.items).toEqual([]);
    expect(queuedSnapshot.runs[0]?.attachments).toEqual([metadata]);
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    expect((await world.conversations.updatesSince(conversationId, '0')).updates.find((item) => item.event === 'run')?.data.attachments).toEqual([metadata]);
    const engine = world.createEngine(); engine.start();
    try {
      await waitFor('falha com anexo', async () => (await world.runRow(queued.id)).status === 'failed');
      const snapshot = await world.conversations.snapshot(bot.id);
      const user = snapshot.items.find((item) => item.kind === 'text' && item.role === 'user')!;
      expect(user.attachments).toEqual([metadata]);
      expect((await world.conversations.page(bot.id, undefined)).items.find((item) => item.id === user.id)?.attachments).toEqual([metadata]);
      expect((await world.conversations.updatesSince(conversationId, queuedSnapshot.lastEventId)).updates.flatMap((item) => (item.event === 'message' && item.data.id === user.id ? [item.data] : []))[0]?.attachments).toEqual([metadata]);
      const retry = await world.conversations.retry(bot.id, queued.id);
      expect(retry.attachments).toEqual([metadata]);
      await waitFor('retry encerrado', async () => ['completed', 'failed'].includes((await world.runRow(retry.id)).status));
      expect((await world.conversations.snapshot(bot.id)).items.filter((item) => item.kind === 'text' && item.role === 'user')).toHaveLength(1);
      const link = (await world.pool.query('SELECT run_id, message_id FROM attachments WHERE id = $1', [file.id])).rows[0];
      expect(link).toEqual({ run_id: queued.id, message_id: user.id });
      const plain = await world.conversations.send(bot.id, 'olá');
      expect(plain.attachments).toEqual([]);
      await waitFor('texto simples encerrado', async () => (await world.runRow(plain.id)).status === 'completed');
      expect((await world.conversations.snapshot(bot.id)).items.find((item) => item.runId === plain.id)?.attachments).toEqual([]);
      expect(JSON.stringify(snapshot)).not.toContain('conteúdo privado');
    } finally { await engine.stop(); }
  });

  it('recusa alheio, repetido, removido e ligado sem vínculo parcial; imagem usa preferência efetiva e exige true', async () => {
    const bot = await world.createBot(); const other = await world.createBot();
    const own = await files.upload(bot.id, 'a.txt', Buffer.from('a'));
    const foreign = await files.upload(other.id, 'b.txt', Buffer.from('b'));
    const removed = await files.upload(bot.id, 'c.txt', Buffer.from('c'));
    await world.pool.query('UPDATE attachments SET removed_at = now(), extracted_text = NULL, stored_bytes = 0 WHERE id = $1', [removed.id]);
    for (const ids of [[own.id, foreign.id], [own.id, own.id], [own.id, removed.id]]) {
      await expect(world.conversations.send(bot.id, 'recusada', ids)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
      expect((await world.pool.query('SELECT run_id FROM attachments WHERE id = $1', [own.id])).rows[0].run_id).toBeNull();
    }
    await expect(world.conversations.send(bot.id, 'muitos', Array(6).fill(own.id))).rejects.toMatchObject({ code: 'ATTACHMENT_LIMIT_REACHED' });
    const image = await files.upload(bot.id, 'foto.jpg', JPEG_FIXTURE);
    for (const state of [null, false]) {
      await world.pool.query('UPDATE model_profiles SET accepts_images = $1 WHERE model_id = $2', [state, 'opencode/glm-5.1']);
      await expect(world.conversations.send(bot.id, 'foto', [own.id, image.id])).rejects.toMatchObject({ code: 'MODEL_NO_IMAGE_SUPPORT' });
    }
    expect((await world.pool.query('SELECT id FROM runs WHERE conversation_id = $1', [await world.conversations.conversationIdOf(bot.id)])).rows).toEqual([]);
    await world.models.verifyImage('opencode/vision-model');
    await world.conversations.setPreference(bot.id, 'opencode/vision-model', null);
    const accepted = await world.conversations.send(bot.id, 'foto', [own.id, image.id]);
    expect(accepted.attachments).toHaveLength(2);
    await expect(world.conversations.send(bot.id, 'reutilizada', [own.id])).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });

  it('descarte e dois envios concorrentes não reutilizam pendente, e sessão mantém título textual', async () => {
    const bot = await world.createBot();
    const file = await files.upload(bot.id, 'a.txt', Buffer.from('a'));
    const results = await Promise.allSettled([world.conversations.send(bot.id, 'um', [file.id]), world.conversations.send(bot.id, 'dois', [file.id]), files.discard(bot.id, file.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    const session = await new GeneralChatService({ pool: world.pool }).create();
    await world.conversations.setSessionDefault('opencode/glm-5.1', null, { ip: '127.0.0.1', userAgent: 'teste' });
    const document = await files.upload({ sessionId: session.id }, 'nome não é título.txt', Buffer.from('documento'));
    const run = await world.conversations.send({ sessionId: session.id }, 'Título vindo da mensagem', [document.id]);
    expect(run.attachments?.[0]?.id).toBe(document.id);
    expect((await world.pool.query('SELECT title FROM conversations WHERE id = $1', [session.id])).rows[0].title).toBe('Título vindo da mensagem');
  });

  it('contratos antigos recebem lista vazia; IDs inválidos, repetidos, excesso e campo extra são recusados', () => {
    expect(sendMessageRequestSchema.safeParse({ content: 'olá', attachmentIds: ['1', '1'] }).success).toBe(false);
    expect(sendMessageRequestSchema.safeParse({ content: 'olá', attachmentIds: Array(6).fill('1') }).success).toBe(false);
    expect(sendMessageRequestSchema.safeParse({ content: 'olá', attachmentIds: ['inválido'] }).success).toBe(false);
    expect(sendMessageRequestSchema.safeParse({ content: 'olá', outro: true }).success).toBe(false);
    const at = new Date().toISOString();
    expect(messageViewSchema.parse({ id: '1', runId: null, createdAt: at, kind: 'text', role: 'user', status: 'done', content: 'olá' }).attachments).toEqual([]);
    expect(runViewSchema.parse({ id: '1', status: 'queued', input: 'olá', routineName: null, toolCalls: 0, failureCode: null, createdAt: at, startedAt: null, finishedAt: null }).attachments).toEqual([]);
    expect(conversationAttachmentSchema.parse({ id: '1', name: 'arquivo', kind: 'document', sizeBytes: 1, removed: true }).removed).toBe(true);
  });
});
