// Borda HTTP real: binário, sessão/CSRF, Unicode, downloads isolados e ausência de conteúdo nos logs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JPEG_FIXTURE, docxFixture, pdfFixture, xlsxFixture } from '@aion/core/testing';
import { ORIGIN, createTestApi, type TestApi } from './testing/harness';

let api: TestApi;
let auth: { cookie: string; csrfToken: string };
let bot: string;
beforeAll(async () => {
  api = await createTestApi(); auth = await api.login();
  const created = await api.app.inject({ method: 'POST', url: '/api/bots', headers: { cookie: auth.cookie, origin: ORIGIN, 'x-csrf-token': auth.csrfToken }, payload: { name: 'Anexos HTTP', color: '#60A5FA' } });
  expect(created.statusCode).toBe(201); bot = created.json<{ id: string }>().id;
});
afterAll(async () => { await api.cleanup(); });

/** Todos os uploads usam header ASCII percent-encoded, nunca nome na URL. */
const upload = (name: string, bytes: Buffer, headers: Record<string, string> = {}) => api.app.inject({
  method: 'POST', url: `/api/bots/${bot}/attachments`, payload: bytes,
  headers: { cookie: auth.cookie, origin: ORIGIN, 'x-csrf-token': auth.csrfToken, 'content-type': 'application/octet-stream', 'x-attachment-name': encodeURIComponent(name), ...headers },
});

describe('anexos pela HTTP', () => {
  it('recusa sem sessão/CSRF/Origin, nome inválido e corpo acima15MB no envelope próprio', async () => {
    expect((await upload('sem.txt', Buffer.from('texto'), { cookie: '' })).statusCode).toBe(401);
    expect((await upload('sem.txt', Buffer.from('texto'), { 'x-csrf-token': '' })).statusCode).toBe(403);
    expect((await upload('sem.txt', Buffer.from('texto'), { origin: 'https://fora.test' })).statusCode).toBe(403);
    expect((await upload('sem.txt', Buffer.from('texto'), { 'x-attachment-name': '%ZZ' })).json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const json = await api.app.inject({ method: 'POST', url: `/api/bots/${bot}/attachments`, headers: { cookie: auth.cookie, origin: ORIGIN, 'x-csrf-token': auth.csrfToken, 'x-attachment-name': 'arquivo.txt' }, payload: { content: 'dado-json' } });
    expect(json.statusCode).toBe(422); expect(json.json()).toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    const tooLarge = await upload('muito.pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(15 * 1024 * 1024)]));
    expect(tooLarge.statusCode).toBe(413); expect(tooLarge.json()).toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
  });
  it('aceita corpo acima256KB e entrega só texto semcache, nome Unicode vira.txt e JPEGprivate3600', async () => {
    const name = 'relatório-😀-secreto.docx';
    const document = await upload(name, docxFixture('segredo-documento-http'));
    expect(document.statusCode).toBe(201);
    const id = document.json<{ id: string }>().id;
    const download = await api.app.inject({ method: 'GET', url: `/api/bots/${bot}/attachments/${id}/content`, headers: { cookie: auth.cookie } });
    expect(download.body).toBe('segredo-documento-http');
    expect(download.headers['cache-control']).toBe('no-store');
    expect(download.headers['content-type']).toContain('text/plain');
    expect(download.headers['content-disposition']).toContain(encodeURIComponent('relatório-😀-secreto.txt'));
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    const large = await upload('grande.txt', Buffer.alloc(300_000, 120)); expect(large.statusCode).toBe(201);
    const image = await upload('foto-secreta.jpg', JPEG_FIXTURE); expect(image.statusCode).toBe(201);
    const imageId = image.json<{ id: string }>().id;
    const jpeg = await api.app.inject({ method: 'GET', url: `/api/bots/${bot}/attachments/${imageId}/content`, headers: { cookie: auth.cookie } });
    expect(jpeg.rawPayload).toEqual(JPEG_FIXTURE); expect(jpeg.headers['cache-control']).toBe('private, max-age=3600');
    expect(jpeg.headers['content-type']).toBe('image/jpeg'); expect(jpeg.headers['content-disposition']).toContain('inline');
    const denied = await api.app.inject({ method: 'GET', url: `/api/bots/${bot}/attachments/${imageId}/content` });
    expect(denied.headers['cache-control']).toBe('no-store');
    const errors = [denied.json()];
    const session = await api.chat.create();
    for (const method of ['GET', 'DELETE'] as const) {
      const other = await api.app.inject({ method, url: `/api/chat/sessions/${session.id}/attachments/${id}${method === 'GET' ? '/content' : ''}`, headers: { cookie: auth.cookie, origin: ORIGIN, 'x-csrf-token': auth.csrfToken } });
      expect(other.json()).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' }); expect(other.headers['cache-control']).toBe('no-store');
      errors.push(other.json());
    }
    const discarded = await api.app.inject({ method: 'DELETE', url: `/api/bots/${bot}/attachments/${id}`, headers: { cookie: auth.cookie, origin: ORIGIN, 'x-csrf-token': auth.csrfToken } });
    expect(discarded.statusCode).toBe(204);
    const logs = api.logs.join('');
    // Os downloads autorizados acima contêm o arquivo; os canais operacionais e erros nunca o reproduzem.
    expect(api.logs.some((line) => JSON.parse(line).level >= 30)).toBe(true);
    for (const secret of [name, encodeURIComponent(name), 'segredo-documento-http', 'foto-secreta.jpg', JPEG_FIXTURE.toString('base64'), '%ZZ']) {
      expect(logs).not.toContain(secret);
      expect(JSON.stringify(errors)).not.toContain(secret);
    }
  });
  // Phase 4, T5 (ATT-01, A19): o original da planilha só sai com sessão, sempre como anexo, nosniff e cache privado; erros seguem no-store.
  it('planilha: upload, download do original com sessão pelas duas rotas, recusas no envelope atual e exclusão que zera o conteúdo', async () => {
    const headers = { cookie: auth.cookie, origin: ORIGIN, 'x-csrf-token': auth.csrfToken };
    const sheet = xlsxFixture();
    const name = 'vendas (março) 2026.xlsx';
    const created = await upload(name, sheet);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ kind: 'spreadsheet', originalBytes: sheet.length, storedBytes: sheet.length });
    const id = created.json<{ id: string }>().id;
    for (const url of [`/api/bots/${bot}/attachments/${id}/content`, `/api/attachments/${id}/content`]) {
      const download = await api.app.inject({ method: 'GET', url, headers: { cookie: auth.cookie } });
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload).toEqual(sheet);
      expect(download.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(download.headers['content-disposition']).toBe(`attachment; filename="arquivo.xlsx"; filename*=UTF-8''${encodeURIComponent(name).replace(/[()]/g, (value) => `%${value.charCodeAt(0).toString(16)}`)}`);
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(download.headers['cache-control']).toBe('private, max-age=3600');
      const denied = await api.app.inject({ method: 'GET', url });
      expect(denied.statusCode).toBe(401); expect(denied.headers['cache-control']).toBe('no-store'); expect(denied.rawPayload).not.toEqual(sheet);
    }
    const json = await upload('dados.json', Buffer.from('{"ok": true}'));
    expect(json.statusCode).toBe(201); expect(json.json()).toMatchObject({ kind: 'document' });
    for (const [file, bytes, status, code] of [
      ['macro.xlsm', sheet, 422, 'ATTACHMENT_TYPE_UNSUPPORTED'],
      ['documento.xlsx', docxFixture(), 422, 'ATTACHMENT_TYPE_UNSUPPORTED'],
      ['bomba.xlsx', xlsxFixture({ extra: { 'xl/media/bomba.bin': new Uint8Array(100 * 1024 * 1024 + 1) } }), 422, 'ATTACHMENT_UNREADABLE'],
      ['grande.xlsx', Buffer.concat([sheet, Buffer.alloc(15 * 1024 * 1024)]), 413, 'ATTACHMENT_TOO_LARGE'],
    ] as const) {
      const refused = await upload(file, bytes);
      expect(refused.statusCode).toBe(status); expect(refused.json()).toMatchObject({ code });
    }
    expect((await api.app.inject({ method: 'DELETE', url: `/api/attachments/${id}`, headers: { cookie: auth.cookie } })).statusCode).toBe(403);
    expect((await api.app.inject({ method: 'DELETE', url: `/api/attachments/${id}`, headers })).statusCode).toBe(204);
    const gone = await api.app.inject({ method: 'GET', url: `/api/attachments/${id}/content`, headers: { cookie: auth.cookie } });
    expect(gone.json()).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' }); expect(gone.headers['cache-control']).toBe('no-store');
    expect(api.logs.join('')).not.toContain(name);
  });
  it('PDF real extrai e taxa responde RetryAfter', async () => {
    expect((await upload('texto.pdf', pdfFixture())).statusCode).toBe(201);
    let limited;
    for (let index = 0; index < 31; index++) {
      const response = await upload('executável.pdf', Buffer.from('MZ'));
      if (response.statusCode === 429) { limited = response; break; }
    }
    expect(limited?.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(limited?.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('rotas globais exigem sessão/CSRF, validam allowlist/lote e removem conteúdo com limite10/min', async () => {
    const headers = { cookie: auth.cookie, origin: ORIGIN, 'x-csrf-token': auth.csrfToken };
    expect((await api.app.inject({ method: 'GET', url: '/api/attachments' })).statusCode).toBe(401);
    const list = await api.app.inject({ method: 'GET', url: `/api/attachments?botId=${bot}&kind=document`, headers });
    expect(list.statusCode).toBe(200); expect(list.json().items.length).toBeGreaterThan(0);
    const file = list.json().items[0];
    expect(file).not.toHaveProperty('extracted_text');
    expect((await api.app.inject({ method: 'GET', url: '/api/attachments?unknown=1', headers })).json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await api.app.inject({ method: 'POST', url: '/api/attachments/delete-batch', headers: { cookie: auth.cookie }, payload: { ids: [file.id] } })).statusCode).toBe(403);
    for (const payload of [{ ids: Array(101).fill(file.id) }, { ids: [file.id], extra: true }, { ids: ['invalid'] }]) {
      expect((await api.app.inject({ method: 'POST', url: '/api/attachments/delete-batch', headers, payload })).json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect((await api.app.inject({ method: 'GET', url: `/api/attachments/${file.id}/content`, headers })).statusCode).toBe(200);
    expect((await api.app.inject({ method: 'DELETE', url: `/api/attachments/${file.id}`, headers, payload: { extra: true } })).json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await api.app.inject({ method: 'DELETE', url: `/api/attachments/${file.id}`, headers })).statusCode).toBe(204);
    expect((await api.app.inject({ method: 'GET', url: `/api/attachments/${file.id}/content`, headers })).json()).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    for (let index = 0; index < 10; index++) {
      const response = await api.app.inject({ method: 'POST', url: '/api/attachments/delete-batch', headers, payload: { ids: ['999999999'] } });
      expect(response.statusCode).toBe(200); expect(response.json().alreadyRemoved).toEqual(['999999999']);
    }
    const limited = await api.app.inject({ method: 'POST', url: '/api/attachments/delete-batch', headers, payload: { ids: ['999999999'] } });
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' }); expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
