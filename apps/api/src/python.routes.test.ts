// Borda HTTP do Python (phase 4, T7; F10 e F11, A20 e A21): a rota de estado de Configurações → Python, que confere a saúde do sandbox NO SERVIDOR (o
// navegador nunca recebe o endereço nem o token), e o download dos arquivos gerados pela rota de conteúdo privado (só com sessão, `nosniff`, cache
// privado de uma hora, PNG inline e os demais como anexo).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pngFixture, startFakeSandbox, type FakeSandbox } from '@aion/core/testing';
import { ORIGIN, createTestApi, type TestApi } from './testing/harness';

describe('GET /api/settings/python', () => {
  it('"not_installed" sem a configuração, sem nenhuma chamada de rede', async () => {
    const api = await createTestApi();
    try {
      const auth = await api.login();
      const response = await api.app.inject({ method: 'GET', url: '/api/settings/python', headers: { cookie: auth.cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'not_installed' });
      expect((await api.app.inject({ method: 'GET', url: '/api/settings/python' })).statusCode).toBe(401);
    } finally {
      await api.cleanup();
    }
  });

  it('"available" com 200 do sandbox, "unavailable" aquecendo, fora do ar ou com token errado; o endereço e o token nunca saem', async () => {
    const sandbox = await startFakeSandbox();
    const api = await createTestApi({ AION_SANDBOX_URL: sandbox.url, AION_SANDBOX_TOKEN: sandbox.token });
    const wrong = await createTestApi({ AION_SANDBOX_URL: sandbox.url, AION_SANDBOX_TOKEN: 'token-errado-0123456789abcdef0123456789' });
    try {
      const auth = await api.login();
      const read = (target: TestApi, cookie: string) => target.app.inject({ method: 'GET', url: '/api/settings/python', headers: { cookie } });
      const ok = await read(api, auth.cookie);
      expect(ok.json()).toEqual({ status: 'available' });
      expect(ok.body).not.toContain(sandbox.token);
      expect(ok.body).not.toContain(sandbox.url);
      expect(ok.headers['cache-control']).toBe('no-store');
      sandbox.healthStatus = 503;
      expect((await read(api, auth.cookie)).json()).toEqual({ status: 'unavailable' });
      sandbox.healthStatus = 200;
      const wrongAuth = await wrong.login();
      expect((await read(wrong, wrongAuth.cookie)).json()).toEqual({ status: 'unavailable' });
      expect(sandbox.unauthorized).toBeGreaterThan(0);
      await sandbox.stop();
      expect((await read(api, auth.cookie)).json()).toEqual({ status: 'unavailable' });
      expect([...api.logs, ...wrong.logs].join('\n')).not.toContain(sandbox.token);
    } finally {
      await api.cleanup();
      await wrong.cleanup();
      await sandbox.stop();
    }
  });

  it('só uma das duas variáveis ou uma URL inválida não derruba a API: o Python fica "not_installed" e o log cita só o nome', async () => {
    const api = await createTestApi({ AION_SANDBOX_URL: 'http://aion_sandbox:8080/caminho', AION_SANDBOX_TOKEN: 'curto' });
    try {
      const auth = await api.login();
      expect((await api.app.inject({ method: 'GET', url: '/api/settings/python', headers: { cookie: auth.cookie } })).json()).toEqual({ status: 'not_installed' });
      const warnings = api.logs.filter((line) => line.includes('configuração opcional ignorada')).join('\n');
      expect(warnings).toContain('AION_SANDBOX_URL');
      expect(warnings).toContain('AION_SANDBOX_TOKEN');
      expect(warnings).not.toContain('curto');
      expect(warnings).not.toContain('/caminho');
    } finally {
      await api.cleanup();
    }
  });
});

describe('download dos arquivos gerados pelo Python', () => {
  let api: TestApi;
  let sandbox: FakeSandbox;
  let auth: { cookie: string; csrfToken: string };
  let bot: string;
  const png = pngFixture(2, 2);

  beforeAll(async () => {
    sandbox = await startFakeSandbox();
    api = await createTestApi();
    auth = await api.login();
    const created = await api.app.inject({ method: 'POST', url: '/api/bots', headers: { cookie: auth.cookie, origin: ORIGIN, 'x-csrf-token': auth.csrfToken }, payload: { name: 'Python HTTP', color: '#60A5FA' } });
    bot = created.json<{ id: string }>().id;
  });
  afterAll(async () => {
    await api.cleanup();
    await sandbox.stop();
  });

  /** Grava um arquivo gerado como o worker grava (kind `generated`, formato e bytes), ligado a uma mensagem da conversa do bot. */
  async function seedGenerated(name: string, format: string, bytes: Buffer): Promise<string> {
    const conversationId = await api.conversations.conversationIdOf(bot);
    const message = await api.pool.query<{ id: string }>(
      "INSERT INTO messages (conversation_id, role, kind, status, content, created_at) VALUES ($1, 'user', 'text', 'done', 'pedido', now()) RETURNING id::text AS id",
      [conversationId],
    );
    const inserted = await api.pool.query<{ id: string }>(
      "INSERT INTO attachments (conversation_id, message_id, kind, format, name, original_bytes, stored_bytes, file_bytes) VALUES ($1, $2, 'generated', $3, $4, $5, $5, $6) RETURNING id::text AS id",
      [conversationId, message.rows[0]!.id, format, name, bytes.length, bytes],
    );
    return inserted.rows[0]!.id;
  }

  it('PNG abre inline como imagem; CSV, JSON, MD e XLSX baixam como anexo com o tipo do formato; todos com nosniff e cache privado de 1 hora', async () => {
    const cases: [string, string, Buffer, string, string][] = [
      ['grafico.png', 'png', png, 'image/png', 'inline'],
      ['tabela.csv', 'csv', Buffer.from('a,b\n1,2\n'), 'text/csv; charset=utf-8', 'attachment'],
      ['dados.json', 'json', Buffer.from('{"ok":true}'), 'application/json; charset=utf-8', 'attachment'],
      ['notas.md', 'md', Buffer.from('# Título\n'), 'text/markdown; charset=utf-8', 'attachment'],
      ['texto.txt', 'txt', Buffer.from('texto\n'), 'text/plain; charset=utf-8', 'attachment'],
    ];
    for (const [name, format, bytes, type, disposition] of cases) {
      const id = await seedGenerated(name, format, bytes);
      for (const url of [`/api/bots/${bot}/attachments/${id}/content`, `/api/attachments/${id}/content`]) {
        const response = await api.app.inject({ method: 'GET', url, headers: { cookie: auth.cookie } });
        expect(response.statusCode).toBe(200);
        expect(response.rawPayload.equals(bytes)).toBe(true);
        expect(response.headers['content-type']).toBe(type);
        expect(response.headers['content-disposition']).toBe(`${disposition}; filename="arquivo.${format}"; filename*=UTF-8''${encodeURIComponent(name)}`);
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['cache-control']).toBe('private, max-age=3600');
      }
      // Sem sessão: 401 no envelope, sem conteúdo e sem cache.
      const denied = await api.app.inject({ method: 'GET', url: `/api/attachments/${id}/content` });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers['cache-control']).toBe('no-store');
      expect(denied.rawPayload.includes(bytes)).toBe(false);
    }
    // Outra conversa não alcança o arquivo (anti-IDOR pela rota da sessão).
    const id = await seedGenerated('isolado.csv', 'csv', Buffer.from('x\n'));
    const session = await api.chat.create();
    const other = await api.app.inject({ method: 'GET', url: `/api/chat/sessions/${session.id}/attachments/${id}/content`, headers: { cookie: auth.cookie } });
    expect(other.json()).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect(other.headers['cache-control']).toBe('no-store');
    // A listagem do dono mostra a origem (tipo `generated`) e o formato, sem conteúdo.
    const list = await api.app.inject({ method: 'GET', url: '/api/attachments', headers: { cookie: auth.cookie } });
    expect(list.json<{ items: { id: string; kind: string; format?: string }[] }>().items.find((item) => item.id === id)).toMatchObject({ kind: 'generated', format: 'csv' });
    expect(list.body).not.toContain('x\\n');
  });
});
