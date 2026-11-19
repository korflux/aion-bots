// Jornadas de arquivos do dono: metadados, exclusão, referências ativas e limpeza física com banco real.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AttachmentService } from './service';
import { purgePendingAttachments } from './lifecycle';
import { GeneralChatService } from '../general-chat/service';
import { readAttachmentTool } from '../runs/read-attachment';
import { ORIGIN, createRunsWorld, waitFor, type RunsWorld } from '../runs/test-support';
import { JPEG_FIXTURE } from '../testing/attachment-fixtures';

let world: RunsWorld;
let files: AttachmentService;
beforeAll(async () => { world = await createRunsWorld(); files = new AttachmentService({ pool: world.pool, conversations: world.conversations }); });
afterAll(async () => { await world.cleanup(); });

it('pagina 50 metadados, filtra origens/tipos e mantém bot arquivado e sessão com seus tamanhos', async () => {
  const bot = await world.createBot();
  const id = await world.conversations.conversationIdOf(bot.id);
  const doc = await files.upload(bot.id, 'original.txt', Buffer.from('documento'));
  await world.pool.query(`INSERT INTO attachments(conversation_id,kind,name,original_bytes,stored_bytes,extracted_text)
    SELECT $1,'document','sintetico.txt',20,1,'x' FROM generate_series(1,51)`, [id]);
  await world.bots.archive(bot.id, ORIGIN);
  const session = await new GeneralChatService({ pool: world.pool }).create();
  const image = await files.upload({ sessionId: session.id }, 'foto.jpg', JPEG_FIXTURE);
  const query = vi.spyOn(world.pool, 'query');
  const page = await files.list({ botId: bot.id, kind: 'document' });
  expect(page.items).toHaveLength(50); expect(page.items[0]!.bot).toMatchObject({ id: bot.id, archived: true });
  expect(page.items.every((file) => !('image_bytes' in file) && !('extracted_text' in file))).toBe(true);
  expect(query.mock.calls.map((call) => String(call[0])).join(' ')).not.toMatch(/image_bytes|extracted_text/);
  query.mockRestore();
  const rest = await files.list({ botId: bot.id, cursor: page.nextCursor! });
  expect(rest.items).toHaveLength(2); expect(rest.items.at(-1)?.id).toBe(doc.id); expect(rest.nextCursor).toBeNull();
  const chat = await files.list({ origin: 'chat', kind: 'image' });
  expect(chat.items).toHaveLength(1); expect(chat.items[0]).toMatchObject({ id: image.id, sessionId: session.id, bot: null, originalBytes: JPEG_FIXTURE.length });
  expect(await files.globalContent(image.id)).toMatchObject({ bytes: JPEG_FIXTURE });
  expect(chat.usedBytes).toBe(page.usedBytes);
  await files.remove(image.id, ORIGIN);
  expect((await world.pool.query('SELECT image_bytes,extracted_text,stored_bytes,removed_at IS NOT NULL AS removed FROM attachments WHERE id=$1', [image.id])).rows[0]).toEqual({ image_bytes: null, extracted_text: null, stored_bytes: 0, removed: true });
});

it('filtro Tipo: PNG gerado pelo Python conta como imagem e os demais gerados como documento (design phase 4)', async () => {
  const bot = await world.createBot();
  const id = await world.conversations.conversationIdOf(bot.id);
  const inserted = await world.pool.query<{ id: string; format: string }>(`INSERT INTO attachments(conversation_id,kind,name,original_bytes,stored_bytes,file_bytes,format)
    VALUES ($1,'generated','grafico.png',3,3,$2,'png'), ($1,'generated','dados.csv',3,3,$2,'csv') RETURNING id::text AS id, format`, [id, Buffer.from([1, 2, 3])]);
  const png = inserted.rows.find((row) => row.format === 'png')!.id;
  const csv = inserted.rows.find((row) => row.format === 'csv')!.id;
  expect((await files.list({ botId: bot.id, kind: 'image' })).items.map((file) => file.id)).toEqual([png]);
  expect((await files.list({ botId: bot.id, kind: 'document' })).items.map((file) => file.id)).toEqual([csv]);
  expect((await files.list({ botId: bot.id })).items.map((file) => ({ kind: file.kind, format: file.format }))).toEqual([{ kind: 'generated', format: 'csv' }, { kind: 'generated', format: 'png' }]);
});

it('mantém queued/retry/aguardando aprovação, limpa leituras e mensagem persiste; quota e auditoria usam só bytes/tipo/contagem', async () => {
  const bot = await world.createBot();
  const file = await files.upload(bot.id, 'nome-privado.txt', Buffer.from('conteudo-privado'));
  const initial = await world.conversations.send(bot.id, '[falha]', [file.id]);
  await expect(files.remove(file.id, ORIGIN)).rejects.toMatchObject({ code: 'ATTACHMENT_IN_USE' });
  const engine = world.createEngine(); engine.start();
  await world.waitForStatus(initial.id, 'failed');
  await engine.stop();
  const retry = await world.conversations.retry(bot.id, initial.id);
  expect((await files.list({ botId: bot.id })).items[0]?.inUse).toBe(true);
  await expect(files.remove(file.id, ORIGIN)).rejects.toMatchObject({ code: 'ATTACHMENT_IN_USE' });
  await world.pool.query("UPDATE runs SET status = 'waiting_approval' WHERE id = $1", [retry.id]);
  const held = await files.removeBatch([file.id, '999999999'], ORIGIN);
  expect(held).toMatchObject({ inUse: [file.id], alreadyRemoved: ['999999999'], deleted: [] });
  await world.pool.query("UPDATE runs SET status = 'completed' WHERE id = $1", [retry.id]);
  const conversationId = await world.conversations.conversationIdOf(bot.id);
  await world.pool.query(`INSERT INTO messages(conversation_id,run_id,role,kind,status,step,content,data,created_at) VALUES($1,$2,'assistant','activity','completed',1,'conteudo-privado',$3,now())`, [conversationId, retry.id, JSON.stringify({ tool: 'read_attachment', arguments: '{malformed', detail: { type: 'attachment_read', attachmentId: file.id, kind: 'document', offset: 0 } })]);
  const before = await files.list({});
  const result = await files.removeBatch([file.id, '000' + file.id, '999999999'], ORIGIN);
  expect(result).toMatchObject({ deleted: [file.id], freedBytes: file.storedBytes, alreadyRemoved: ['999999999'] });
  expect((await files.list({})).usedBytes).toBe(before.usedBytes - file.storedBytes);
  expect((await world.pool.query('SELECT extracted_text,image_bytes,stored_bytes,removed_at IS NOT NULL AS removed FROM attachments WHERE id=$1', [file.id])).rows[0]).toEqual({ extracted_text: null, image_bytes: null, stored_bytes: 0, removed: true });
  const timeline = await world.timeline(bot);
  expect(timeline.find((entry) => entry.role === 'user')).toBeDefined();
  expect(timeline.find((entry) => entry.kind === 'activity')).toMatchObject({ content: '[conteúdo removido]', data: { detail: null } });
  const message = (await world.conversations.snapshot(bot.id)).items.find((entry) => entry.kind === 'text' && entry.role === 'user');
  expect(message?.kind === 'text' ? message.attachments?.[0] : undefined).toMatchObject({ removed: true });
  await expect(files.globalContent(file.id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  await files.remove(file.id, ORIGIN);
  const audit = (await world.pool.query("SELECT details FROM audit_log WHERE action='attachment.delete'")).rows;
  expect(JSON.stringify(audit)).not.toMatch(/nome-privado|conteudo-privado/);
  expect(audit).toContainEqual({ details: { type: 'document', count: 1, bytes: file.storedBytes } });
  const tight = new AttachmentService({ pool: world.pool, conversations: world.conversations, maxTotalBytes: (await files.list({})).usedBytes + 1 });
  const one = await tight.upload(bot.id, 'um.txt', Buffer.from('x'));
  await expect(tight.upload(bot.id, 'dois.txt', Buffer.from('x'))).rejects.toMatchObject({ code: 'ATTACHMENT_QUOTA_EXCEEDED' });
  await tight.remove(one.id, ORIGIN);
  expect((await tight.upload(bot.id, 'dois.txt', Buffer.from('x'))).storedBytes).toBe(1);
});

it('releitura antiga registra referência antes de ler e concorre com exclusão sem ressuscitar texto', async () => {
  const bot = await world.createBot();
  const file = await files.upload(bot.id, 'releitura.txt', Buffer.from('texto-para-nao-ressuscitar'));
  const engine = world.createEngine(); engine.start();
  const initial = await world.conversations.send(bot.id, 'Leia', [file.id]);
  await world.waitForStatus(initial.id, 'completed');
  let release!: () => void;
  let captured = false;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const prepare = readAttachmentTool.prepare.bind(readAttachmentTool);
  const spy = vi.spyOn(readAttachmentTool, 'prepare').mockImplementation((raw) => {
    const call = prepare(raw);
    return { ...call, async execute(context) { const result = await call.execute(context); captured = true; await barrier; return result; } };
  });
  try {
    const run = await world.send(bot, `[anexo-ler:000${file.id}]`);
    await waitFor('leitura capturada antes de settleActivity', async () => captured);
    const activity = (await world.timeline(bot)).find((entry) => entry.runId === run && entry.kind === 'activity')!;
    expect(activity).toMatchObject({ status: 'running', data: { detail: { attachmentId: file.id } } });
    const deletion = await files.removeBatch([file.id], ORIGIN);
    expect(deletion.inUse).toEqual([file.id]);
    release();
    await world.waitForStatus(run, 'completed');
    await files.remove(file.id, ORIGIN);
    expect((await world.timeline(bot)).find((entry) => entry.id === activity.id)).toMatchObject({ content: '[conteúdo removido]', data: { detail: null } });
    // Uma nova leitura do arquivo removido não restaura a referência nem o conteúdo no fechamento.
    spy.mockRestore();
    const removedRead = await world.send(bot, `[anexo-ler:000${file.id}]`);
    await world.waitForStatus(removedRead, 'completed');
    expect((await world.timeline(bot)).find((entry) => entry.runId === removedRead && entry.kind === 'activity')).toMatchObject({ status: 'failed', content: expect.stringContaining('Arquivo removido pelo dono'), data: { detail: null } }); // A15: o arquivo removido é falha da atividade, sem texto nem referência restaurados
  } finally { release(); spy.mockRestore(); await engine.stop(); }
});

it('pendentes respeitam limite exato de24h; bot e sessão removem centenas sem órfãos e auditam bytes', async () => {
  const bot = await world.createBot();
  const conversationId = await world.conversations.conversationIdOf(bot.id);
  const now = new Date('2030-01-02T00:00:00Z');
  await world.pool.query(`INSERT INTO attachments(conversation_id,kind,name,original_bytes,stored_bytes,extracted_text,created_at)
    SELECT $1,'document','semente.txt',1,1,'x',$2 FROM generate_series(1,250)`, [conversationId, new Date(now.getTime() - 24 * 3600_000 - 1)]);
  await world.pool.query("INSERT INTO attachments(conversation_id,kind,name,original_bytes,stored_bytes,extracted_text,created_at) VALUES($1,'document','limite.txt',1,1,'x',$2)", [conversationId, new Date(now.getTime() - 24 * 3600_000)]);
  expect(await purgePendingAttachments(world.pool, now)).toBeGreaterThanOrEqual(250);
  expect((await world.pool.query('SELECT count(*) FROM attachments WHERE conversation_id=$1', [conversationId])).rows[0]).toEqual({ count: '1' });
  await world.pool.query(`INSERT INTO attachments(conversation_id,kind,name,original_bytes,stored_bytes,extracted_text) SELECT $1,'document','semente.txt',2,2,'xx' FROM generate_series(1,350)`, [conversationId]);
  await world.bots.archive(bot.id, ORIGIN); await world.bots.deleteArchived(bot.id, bot.name, ORIGIN);
  expect((await world.pool.query('SELECT count(*) FROM attachments WHERE conversation_id=$1', [conversationId])).rows[0]).toEqual({ count: '0' });
  expect((await world.pool.query("SELECT details FROM audit_log WHERE action='bot.delete' AND target=$1", [bot.id])).rows[0]?.details).toMatchObject({ attachments: 351, attachmentBytes: 701 });
  const chat = new GeneralChatService({ pool: world.pool, now: () => now });
  const session = await chat.create();
  await world.pool.query(`INSERT INTO attachments(conversation_id,kind,name,original_bytes,stored_bytes,extracted_text) SELECT $1,'document','sessao.txt',1,1,'x' FROM generate_series(1,350)`, [session.id]);
  const future = new GeneralChatService({ pool: world.pool, now: () => new Date('2030-02-02T00:00:00Z') });
  expect(await future.purgeExpired()).toBeGreaterThan(0);
  expect((await world.pool.query('SELECT count(*) FROM attachments WHERE conversation_id=$1', [session.id])).rows[0]).toEqual({ count: '0' });
});

it('exclusão espera registro concorrente de leitura na sessão sem deadlock de FK e revalida após a trava', async () => {
  const chat = await new GeneralChatService({ pool: world.pool }).create();
  const ref = { sessionId: chat.id };
  await world.conversations.setPreference(ref, 'opencode/glm-5.1', null);
  const file = await files.upload(ref, 'corrida.txt', Buffer.from('conteudo-da-corrida'));
  const first = await world.conversations.send(ref, 'Leia', [file.id]);
  const engine = world.createEngine(); engine.start();
  await world.waitForStatus(first.id, 'completed'); await engine.stop();
  const reading = await world.conversations.send(ref, 'Reler arquivo antigo');
  const tx = await world.pool.connect();
  let deletion: Promise<void> | undefined;
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE', [reading.id]);
    deletion = files.remove(file.id, ORIGIN);
    // Captura logo a rejeição para que ela só seja afirmada depois do COMMIT da leitura concorrente.
    const outcome = deletion.then(() => 'removed', (error: { code: string }) => error.code);
    await waitFor('exclusão esperando a trava da execução', async () => (await world.pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM runs WHERE conversation_id%'")).rowCount);
    // A FK pede KEY SHARE na conversa: isto precisa concluir mesmo quando a exclusão segura seu dono.
    await tx.query(`INSERT INTO messages(conversation_id,run_id,role,kind,status,step,data,created_at) VALUES($1,$2,'assistant','activity','running',1,$3,now())`, [chat.id, reading.id, JSON.stringify({ tool: 'read_attachment', arguments: '{invalid-json', detail: { type: 'attachment_read', attachmentId: file.id, kind: 'document', offset: 0 } })]);
    await tx.query('COMMIT');
    expect(await outcome).toBe('ATTACHMENT_IN_USE');
    expect((await files.globalContent(file.id)).bytes.toString()).toBe('conteudo-da-corrida');
    await world.pool.query("UPDATE runs SET status='completed' WHERE id=$1", [reading.id]);
    await files.remove(file.id, ORIGIN);
  } finally { await tx.query('ROLLBACK'); tx.release(); await deletion?.catch(() => undefined); }
});
