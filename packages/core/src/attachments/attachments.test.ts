// Provas de assinatura, orçamento, isolamento e concorrência usando banco e leitores reais.
import { randomBytes } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRunsWorld, ORIGIN, type RunsWorld } from '../runs/test-support';
import { GeneralChatService } from '../general-chat/service';
import { JPEG_FIXTURE, docxFixture, pdfFixture, xlsxFixture } from '../testing/attachment-fixtures';
import { SPREADSHEET_GUIDANCE } from '../runs/read-attachment';
import { AttachmentService, sanitizeAttachmentName } from './service';
import { extractDocument, validateSpreadsheet } from './extract';

let world: RunsWorld;
beforeAll(async () => { world = await createRunsWorld(); });
afterAll(async () => { await world.cleanup(); });

/** Serviço novo por cenário, sem contadores de outros testes. */
const service = (maxTotalBytes?: number) => new AttachmentService({ pool: world.pool, conversations: world.conversations, maxTotalBytes });

describe('leitores isolados', () => {
  it('extrai PDF e DOCX reais e conserva espaços, entidades e parágrafos', async () => {
    expect(await extractDocument(pdfFixture(), 'pdf')).toEqual({ text: 'Documento PDF de teste', truncated: false });
    expect(await extractDocument(docxFixture('Olá &amp; mundo'), 'docx')).toEqual({ text: 'Olá & mundo', truncated: false });
  });
  it('recusa PDF vazio/corrompido, PDF acima de300p, DOCX acima de50MB e XML com DTD', async () => {
    await expect(extractDocument(pdfFixture(''), 'pdf')).rejects.toMatchObject({ code: 'ATTACHMENT_NO_TEXT' });
    await expect(extractDocument(Buffer.from('%PDF-1.4 quebrado'), 'pdf')).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' });
    await expect(extractDocument(pdfFixture('texto', 301), 'pdf')).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' });
    await expect(extractDocument(docxFixture('texto', 50 * 1024 * 1024 + 1), 'docx')).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' });
    await expect(extractDocument(docxFixture('<!DOCTYPE x>'), 'docx')).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' });
  });
  it('recusa UTF8 inválido e vazio, marca truncamento e termina thread no prazo', async () => {
    await expect(extractDocument(Buffer.from([0xff]), 'text')).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' });
    await expect(extractDocument(Buffer.from('  \n'), 'text')).rejects.toMatchObject({ code: 'ATTACHMENT_NO_TEXT' });
    expect(await extractDocument(Buffer.from('x'.repeat(500_001)), 'text')).toEqual({ text: 'x'.repeat(500_000), truncated: true });
    await expect(extractDocument(pdfFixture(), 'pdf', 1)).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' });
    expect(await extractDocument(Buffer.from('depois'), 'text')).toEqual({ text: 'depois', truncated: false });
  });
});

describe('armazenamento', () => {
  it('guarda só texto de documento e JPEG, sem gravar mensagens/eventos/auditoria; higiene Unicode segura', async () => {
    const bot = await world.createBot({ name: 'Anexos' });
    const attachments = service();
    const before = await world.pool.query('SELECT (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM conversation_events) AS events, (SELECT count(*) FROM audit_log) AS audit');
    const document = await attachments.upload(bot.id, '../relatório.docx', docxFixture());
    const image = await attachments.upload(bot.id, 'pixel.jpg', JPEG_FIXTURE);
    const stored = await world.pool.query('SELECT kind, image_bytes, extracted_text, stored_bytes FROM attachments WHERE id = $1', [document.id]);
    expect(stored.rows[0]).toMatchObject({ kind: 'document', image_bytes: null, extracted_text: 'Documento de teste', stored_bytes: Buffer.byteLength('Documento de teste') });
    expect((await attachments.content(bot.id, image.id)).bytes).toEqual(JPEG_FIXTURE);
    expect((await world.pool.query('SELECT (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM conversation_events) AS events, (SELECT count(*) FROM audit_log) AS audit')).rows).toEqual(before.rows);
    expect(document.name).not.toMatch(/[\\/]/);
    expect(() => encodeURIComponent(sanitizeAttachmentName('a'.repeat(119) + '😀'.repeat(10) + '\ud800'))).not.toThrow();
  });
  it('recusa assinatura falsa, JPEG malformado, tamanhos e sexto pendente sem gravar', async () => {
    const bot = await world.createBot({ name: 'Recusas anexos' });
    const attachments = service();
    for (const [name, bytes, code] of [
      ['programa.pdf', Buffer.from('MZexecutável'), 'ATTACHMENT_TYPE_UNSUPPORTED'],
      ['foto.jpg', Buffer.from('PNG falso'), 'ATTACHMENT_TYPE_UNSUPPORTED'],
      ['foto.jpg', Buffer.from([255, 216, ...Array(12).fill(255), 255, 217]), 'ATTACHMENT_TYPE_UNSUPPORTED'],
      ['texto.txt', Buffer.alloc(1024 * 1024 + 1, 97), 'ATTACHMENT_TOO_LARGE'],
      ['relatório.pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(15 * 1024 * 1024)]), 'ATTACHMENT_TOO_LARGE'],
    ] as const) await expect(attachments.upload(bot.id, name, bytes)).rejects.toMatchObject({ code });
    const paddedImage = Buffer.concat([JPEG_FIXTURE.subarray(0, -2), Buffer.alloc(5 * 1024 * 1024), JPEG_FIXTURE.subarray(-2)]);
    await expect(attachments.upload(bot.id, 'foto.jpg', paddedImage)).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
    const successes = await Promise.all(Array.from({ length: 5 }, () => attachments.upload(bot.id, 'pixel.jpg', JPEG_FIXTURE)));
    await expect(attachments.upload(bot.id, 'pixel.jpg', JPEG_FIXTURE)).rejects.toMatchObject({ code: 'ATTACHMENT_LIMIT_REACHED' });
    await attachments.discard(bot.id, successes[0]!.id);
    await attachments.upload(bot.id, 'pixel.jpg', JPEG_FIXTURE);
    expect((await world.pool.query('SELECT count(*)::int AS total FROM attachments WHERE conversation_id = $1', [await world.conversations.conversationIdOf(bot.id)])).rows[0].total).toBe(5);
  });
  it('quota global é atômica entre conversas e não deixa bytes da recusa', async () => {
    const left = await world.createBot({ name: 'Quota A' });
    const right = await world.createBot({ name: 'Quota B' });
    const existing = Number((await world.pool.query('SELECT sum(stored_bytes)::text AS total FROM attachments')).rows[0].total);
    const attachments = service(existing + JPEG_FIXTURE.length);
    const results = await Promise.allSettled([attachments.upload(left.id, 'a.jpg', JPEG_FIXTURE), attachments.upload(right.id, 'b.jpg', JPEG_FIXTURE)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'ATTACHMENT_QUOTA_EXCEEDED' } });
  });
  it('outro bot ou sessão não lê nem descarta; arquivado recusa e exclusão/retencão apagam arquivos', async () => {
    const bot = await world.createBot({ name: 'Ciclo anexo' });
    const other = await world.createBot({ name: 'Outro anexo' });
    const attachments = service();
    const image = await attachments.upload(bot.id, 'foto.jpg', JPEG_FIXTURE);
    await expect(attachments.content(other.id, image.id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    await expect(attachments.discard(other.id, image.id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    const chat = new GeneralChatService({ pool: world.pool, now: () => new Date(Date.now() + 8 * 86400_000) });
    const session = await new GeneralChatService({ pool: world.pool }).create();
    await expect(attachments.content({ sessionId: session.id }, image.id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    await attachments.upload({ sessionId: session.id }, 'foto.jpg', JPEG_FIXTURE);
    expect(await chat.purgeExpired()).toBeGreaterThan(0);
    expect((await world.pool.query('SELECT id FROM attachments WHERE conversation_id = $1', [session.id])).rows).toEqual([]);
    await world.bots.archive(bot.id, ORIGIN);
    await expect(attachments.upload(bot.id, 'foto.jpg', JPEG_FIXTURE)).rejects.toMatchObject({ code: 'BOT_ARCHIVED' });
    await world.bots.deleteArchived(bot.id, bot.name, ORIGIN);
    expect((await world.pool.query('SELECT id FROM attachments WHERE id = $1', [image.id])).rows).toEqual([]);
  });
  it('limita o31ºenvio e recupera na janela seguinte', async () => {
    let now = new Date();
    const attachments = new AttachmentService({ pool: world.pool, conversations: world.conversations, now: () => now });
    const bot = await world.createBot({ name: 'Taxa anexo' });
    for (let index = 0; index < 30; index++) await expect(attachments.upload(bot.id, 'falso.pdf', Buffer.from('MZ'))).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    await expect(attachments.upload(bot.id, 'falso.pdf', Buffer.from('MZ'))).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 60 });
    now = new Date(now.getTime() + 60_001);
    await expect(attachments.upload(bot.id, 'falso.pdf', Buffer.from('MZ'))).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
  });
});

// Phase 4, T5 (F9, ATT-01, A19): `.json` como texto e `.xlsx` como planilha com o original guardado, validada no leitor isolado.
describe('planilhas e JSON', () => {
  const MB = 1024 * 1024;
  it('o leitor isolado aceita a planilha real e recusa macro, ZIP sem spreadsheetml, zip bomb, entradas demais e ZIP incompleto', async () => {
    await expect(validateSpreadsheet(xlsxFixture())).resolves.toBeUndefined();
    await expect(validateSpreadsheet(xlsxFixture({ mainType: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' }))).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    await expect(validateSpreadsheet(xlsxFixture({ extra: { 'xl/vbaProject.bin': new Uint8Array(10) } }))).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    await expect(validateSpreadsheet(docxFixture())).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    await expect(validateSpreadsheet(Buffer.from(zipSync({ 'dados.csv': strToU8('a,b') })))).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    // Zip bomb: 100 MB + 1 de zeros comprimem para poucos KB; o orçamento descompactado recusa antes de inflar tudo.
    const bomb = xlsxFixture({ extra: { 'xl/media/bomba.bin': new Uint8Array(100 * MB + 1) } });
    expect(bomb.length).toBeLessThan(MB);
    await expect(validateSpreadsheet(bomb)).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' });
    // Várias entradas que somam mais de 100 MB passam do orçamento total, não só da entrada isolada.
    await expect(validateSpreadsheet(xlsxFixture({ extra: Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`xl/media/parte-${index}.bin`, new Uint8Array(34 * MB)])) }))).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' });
    await expect(validateSpreadsheet(xlsxFixture({ extra: Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`xl/x/${index}`, new Uint8Array(0)])) }))).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' });
    await expect(validateSpreadsheet(xlsxFixture().subarray(0, -30))).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' });
  });

  it('guarda o original da planilha sem texto, conta o original no espaço, aceita JSON como texto e recusa .xlsm e acima de 15 MB', async () => {
    const bot = await world.createBot({ name: 'Planilhas' });
    const attachments = service();
    const sheet = xlsxFixture();
    const stored = await attachments.upload(bot.id, '../vendas 2026.xlsx', sheet);
    expect(stored).toMatchObject({ kind: 'spreadsheet', name: '.._vendas 2026.xlsx', originalBytes: sheet.length, storedBytes: sheet.length, truncated: false });
    const row = await world.pool.query('SELECT image_bytes, extracted_text, file_bytes FROM attachments WHERE id = $1', [stored.id]);
    expect(row.rows[0]).toEqual({ image_bytes: null, extracted_text: null, file_bytes: sheet });
    expect(await attachments.content(bot.id, stored.id)).toEqual({ kind: 'spreadsheet', name: '.._vendas 2026.xlsx', bytes: sheet });
    const json = await attachments.upload(bot.id, 'dados.json', Buffer.from('{"total": 42}'));
    expect(json).toMatchObject({ kind: 'document', name: 'dados.json' });
    expect((await attachments.content(bot.id, json.id)).bytes.toString('utf8')).toBe('{"total": 42}');
    for (const [name, bytes, code] of [
      ['macro.xlsm', xlsxFixture(), 'ATTACHMENT_TYPE_UNSUPPORTED'],
      ['macro.xlsx', xlsxFixture({ mainType: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' }), 'ATTACHMENT_TYPE_UNSUPPORTED'],
      ['texto.xlsx', docxFixture(), 'ATTACHMENT_TYPE_UNSUPPORTED'],
      ['texto.xlsx', Buffer.from('a;b\n1;2'), 'ATTACHMENT_TYPE_UNSUPPORTED'],
      ['bomba.xlsx', xlsxFixture({ extra: { 'xl/media/bomba.bin': new Uint8Array(100 * MB + 1) } }), 'ATTACHMENT_UNREADABLE'],
      ['grande.xlsx', xlsxFixture({ extra: { 'xl/media/ruido.bin': randomBytes(15 * MB) } }), 'ATTACHMENT_TOO_LARGE'],
      ['grande.json', Buffer.alloc(MB + 1, 32), 'ATTACHMENT_TOO_LARGE'],
      ['binario.json', Buffer.from([0x7b, 0xff, 0x7d]), 'ATTACHMENT_UNREADABLE'],
    ] as const) await expect(attachments.upload(bot.id, name, bytes)).rejects.toMatchObject({ code });
    // O espaço total conta o original inteiro da planilha (AION_ATTACHMENTS_MAX_TOTAL_MB).
    const used = Number((await world.pool.query('SELECT sum(stored_bytes)::text AS total FROM attachments')).rows[0].total);
    await expect(service(used + sheet.length - 1).upload(bot.id, 'cheia.xlsx', sheet)).rejects.toMatchObject({ code: 'ATTACHMENT_QUOTA_EXCEEDED' });
    await service(used + sheet.length).upload(bot.id, 'cabe.xlsx', sheet);
  });

  it('na conversa, contexto e read_attachment orientam usar run_python; exclusão zera o original e a listagem filtra como Documento', async () => {
    world.engine.start();
    const bot = await world.createBot({ name: 'Planilha na conversa' });
    const attachments = service();
    const sheet = await attachments.upload(bot.id, 'vendas.xlsx', xlsxFixture());
    const since = world.conversationRequests().length;
    const run = (await world.conversations.send(bot.id, 'Analise a planilha', [sheet.id])).id;
    await world.waitForStatus(run, 'completed');
    const body = JSON.stringify(world.conversationRequests()[since]!.body);
    expect(body).toContain(`Anexo id=${sheet.id}; nome=${JSON.stringify(JSON.stringify('vendas.xlsx')).slice(1, -1)}; tipo=spreadsheet`);
    expect(body).toContain(SPREADSHEET_GUIDANCE);
    expect(body).not.toContain('conteudo_anexo_nao_confiavel_');
    const reread = await world.send(bot, `[anexo-ler:${sheet.id}|0]`);
    await world.waitForStatus(reread, 'completed');
    const activity = (await world.timeline(bot)).find((entry) => entry.runId === reread && entry.kind === 'activity')!;
    expect(activity.content).toBe(`Anexo ${sheet.id}: ${SPREADSHEET_GUIDANCE}`);
    expect(activity.data.detail).toMatchObject({ type: 'attachment_read', attachmentId: sheet.id, kind: 'spreadsheet', offset: 0 });
    const listed = await attachments.list({ botId: bot.id, kind: 'document' });
    expect(listed.items.map((item) => [item.id, item.kind])).toEqual([[sheet.id, 'spreadsheet']]);
    expect((await attachments.list({ botId: bot.id, kind: 'image' })).items).toEqual([]);
    expect(await attachments.removeBatch([sheet.id], ORIGIN)).toMatchObject({ deleted: [sheet.id], freedBytes: sheet.storedBytes });
    const removed = await world.pool.query('SELECT file_bytes, stored_bytes, removed_at IS NOT NULL AS removed FROM attachments WHERE id = $1', [sheet.id]);
    expect(removed.rows[0]).toEqual({ file_bytes: null, stored_bytes: 0, removed: true });
    await expect(attachments.content(bot.id, sheet.id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect((await world.timeline(bot)).find((entry) => entry.runId === reread && entry.kind === 'activity')!.content).toBe('[conteúdo removido]');
  });
});
