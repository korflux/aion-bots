// Contrato binário: Unicode só no header codificado, CSRF e cancelamento sem vazar corpo técnico.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadAttachment } from './attachments-api';
afterEach(() => vi.unstubAllGlobals());
describe('upload de anexos', () => {
  it('leva bytes e nome codificado com sessão/CSRF e conserva erro seguro da borda', async () => {
    const metadata = { id: '1', kind: 'document', name: 'relatório.pdf', originalBytes: 4, storedBytes: 4, truncated: false, createdAt: '2026-10-06T12:00:00.000Z', removedAt: null };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(metadata), { status: 201 })).mockResolvedValueOnce(new Response(JSON.stringify({ code: 'RATE_LIMITED', message: 'Aguarde para anexar.' }), { status: 429, headers: { 'retry-after': '30' } }));
    vi.stubGlobal('fetch', fetcher);
    const body = new Blob(['PDF']); const controller = new AbortController();
    expect(await uploadAttachment({ kind: 'bot', id: 'bot' }, body, 'relatório.pdf', 'csrf', controller.signal)).toEqual(metadata);
    expect(fetcher.mock.calls[0]).toEqual(['/api/bots/bot/attachments', expect.objectContaining({ method: 'POST', body, credentials: 'same-origin', headers: expect.objectContaining({ 'content-type': 'application/octet-stream', 'x-attachment-name': 'relat%C3%B3rio.pdf', 'x-csrf-token': 'csrf' }), signal: expect.any(AbortSignal) })]);
    await expect(uploadAttachment({ kind: 'session', id: 'chat' }, body, 'a.txt', 'csrf', controller.signal)).rejects.toMatchObject({ code: 'RATE_LIMITED', message: 'Aguarde para anexar.', retryAfterSeconds: 30 });
  });
  it('recusa resposta de sucesso inválida sem apresentar diagnóstico do schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'conteúdo interno' }), { status: 201 })));
    await expect(uploadAttachment({ kind: 'bot', id: 'bot' }, new Blob(['texto']), 'a.txt', 'csrf', new AbortController().signal)).rejects.toMatchObject({ code: 'UNKNOWN', message: 'Não foi possível anexar o arquivo.' });
  });
});
