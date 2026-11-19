// Prova do chat geral pela borda HTTP (T12; A15; F16): sessão exigida, CSRF nas alterações, validação na borda (id, corpo estrito e campos
// extras recusados), o contrato de cada rota, o isolamento entre bots e sessões (o id de um nunca abre o outro, por nenhuma rota), a
// conversa dentro da sessão pelas mesmas rotas do bot (mensagem, modelo, SSE, parar), a resposta de aprovação sem opção permanente e
// as execuções da sessão em Atividades. A API real roda com o motor real no mesmo processo (em produção é o worker), sobre o provedor e o
// Composio falsos. As regras (retenção, contexto, fila) estão provadas em @aion/core; aqui fica o que só a borda prova.
import { RunEngine, createComposioClient, createOpenCodeGoClient } from '@aion/core';
import { seedLegacyChatApproval, startFakeUpstreams, type FakeUpstreams } from '@aion/core/testing';
import type { ActivitiesPage, ChatSession, ChatSessionList, ConversationSnapshot, RunView } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedRounds } from './testing/conversation-seed';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

const PROVIDER_KEY = 'valid-provider-key-ABCD';
const CONNECTOR_KEY = 'valid-connector-key-WXYZ';
const CLIENT_IP = '203.0.113.96';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

let upstreams: FakeUpstreams;
let api: TestApi;
let engine: RunEngine;
let baseUrl: string;
let session: { cookie: string; csrfToken: string };

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  api = await createTestApi({ AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl, AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl });
  baseUrl = await api.app.listen({ port: 0, host: '127.0.0.1' });
  session = await api.login(CLIENT_IP);
  engine = new RunEngine({
    pool: api.pool,
    credentials: api.credentials,
    provider: createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, chatTimeoutMs: 15_000 }),
    models: api.models,
    connector: createComposioClient({ baseUrl: upstreams.composioBaseUrl }),
    logger: api.logger,
    config: { pollMs: 20, heartbeatMs: 40, flushMs: 15 },
  });
  engine.start();
  expect((await call('POST', '/api/credentials/provider', { key: PROVIDER_KEY })).statusCode).toBe(200);
  expect((await call('POST', '/api/credentials/connector', { key: CONNECTOR_KEY })).statusCode).toBe(200);
});

afterAll(async () => {
  await engine.stop();
  api.app.server.closeAllConnections();
  await api.cleanup();
  await upstreams.stop();
});

/** Chamada autenticada por padrão (cookie, Origin e token CSRF); `headers` sobrescreve (ex.: tirar o CSRF). */
async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return api.app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'user-agent': CHROME_UA, ...headers },
    remoteAddress: CLIENT_IP,
  });
}

const json = <T = Record<string, unknown>>(response: { json: () => unknown }) => response.json() as T;
const errorOf = (response: { json: () => unknown }) => response.json() as { code: string; message: string; fields?: { field: string; reason: string }[] };

async function waitFor<T>(description: string, probe: () => Promise<T | null | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`prazo estourado esperando: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Apaga os rascunhos vazios que testes anteriores deixaram: "Novo chat" os reaproveita, e um teste que parte de uma sessão recém-criada não pode herdar o modelo de outro. */
async function discardDrafts(): Promise<void> {
  await api.pool.query(
    `DELETE FROM conversations c WHERE c.bot_id IS NULL AND NOT c.saved
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id) AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id)`,
  );
}

/** Sessão nova com o modelo escolhido (uma sessão não tem padrão de bot e o mundo não tem favoritos). */
async function openSession(): Promise<ChatSession> {
  const created = await call('POST', '/api/chat/sessions');
  expect(created.statusCode).toBe(201);
  const chat = json<ChatSession>(created);
  expect((await call('PATCH', `/api/chat/sessions/${chat.id}/conversation`, { model: 'opencode/glm-5.1', effort: null })).statusCode).toBe(200);
  return chat;
}

async function createBot(): Promise<{ id: string }> {
  const created = await call('POST', '/api/bots', { name: `Bot ${Math.random().toString(36).slice(2, 8)}`, color: '#60A5FA', instructions: '', model: 'opencode/glm-5.1', effort: null, stepLimit: 25 });
  expect(created.statusCode).toBe(201);
  return json<{ id: string }>(created);
}

const statusOf = async (sessionId: string, runId: string): Promise<string | undefined> =>
  json<ConversationSnapshot>(await call('GET', `/api/chat/sessions/${sessionId}/conversation`)).runs.find((run) => run.id === runId)?.status;

const runStatus = async (runId: string): Promise<string> => (await api.pool.query<{ status: string }>('SELECT status FROM runs WHERE id = $1', [runId])).rows[0]!.status;

async function send(sessionId: string, content: string): Promise<string> {
  const sent = await call('POST', `/api/chat/sessions/${sessionId}/messages`, { content });
  expect(sent.statusCode).toBe(201);
  return json<RunView>(sent).id;
}

describe('sessão, CSRF e validação na borda', () => {
  it('a sessão recebe anexos pelo mesmo contrato e os publica na bolha sem conteúdo do documento', async () => {
    const chat = await openSession();
    const uploaded = await call('POST', `/api/chat/sessions/${chat.id}/attachments`, Buffer.from('privado'), {
      'content-type': 'application/octet-stream', 'x-attachment-name': 'sessao.txt',
    });
    expect(uploaded.statusCode).toBe(201);
    const id = json<{ id: string }>(uploaded).id;
    expect(errorOf(await call('POST', `/api/chat/sessions/${chat.id}/messages`, { content: 'olá', attachmentIds: [id, id] })).code).toBe('ATTACHMENT_NOT_FOUND');
    const sent = await call('POST', `/api/chat/sessions/${chat.id}/messages`, { content: 'olá anexo', attachmentIds: [id] });
    expect(sent.statusCode).toBe(201);
    expect(json<RunView>(sent).attachments?.[0]).toEqual({ id, name: 'sessao.txt', kind: 'document', sizeBytes: Buffer.byteLength('privado'), removed: false });
    await waitFor('anexo na bolha da sessão', async () => {
      const snapshot = json<ConversationSnapshot>(await call('GET', `/api/chat/sessions/${chat.id}/conversation`));
      return snapshot.items.find((item) => item.kind === 'text' && item.role === 'user' && item.attachments?.[0]?.id === id);
    });
  });
  it('exige sessão válida e, nas alterações, Origin e token CSRF', async () => {
    const anonymous = await api.app.inject({ method: 'GET', url: '/api/chat/sessions', headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
    expect([anonymous.statusCode, errorOf(anonymous).code]).toEqual([401, 'AUTH_SESSION_EXPIRED']);

    const chat = await openSession();
    for (const [method, url, payload] of [
      ['POST', '/api/chat/sessions', undefined],
      ['PATCH', `/api/chat/sessions/${chat.id}`, { saved: true }],
      ['POST', `/api/chat/sessions/${chat.id}/messages`, { content: 'oi' }],
      ['POST', `/api/chat/sessions/${chat.id}/runs/stop`, undefined],
    ] as const) {
      const noCsrf = await call(method, url, payload, { 'x-csrf-token': '' });
      expect([url, noCsrf.statusCode, errorOf(noCsrf).code]).toEqual([url, 403, 'CSRF_TOKEN_INVALID']);
      const badOrigin = await call(method, url, payload, { origin: 'https://evil.example' });
      expect([url, badOrigin.statusCode, errorOf(badOrigin).code]).toEqual([url, 403, 'CSRF_ORIGIN_INVALID']);
    }
    // Nada mudou com as tentativas recusadas.
    expect(json<ChatSession>(await call('GET', `/api/chat/sessions/${chat.id}`))).toMatchObject({ saved: false, title: null });
  });

  it('valida o id e o corpo: id que não é UUID, corpo com campo extra ou tipo errado, e o título e as datas nunca vêm do cliente', async () => {
    const chat = await openSession();
    const badId = await call('GET', '/api/chat/sessions/nao-e-uuid');
    expect([badId.statusCode, errorOf(badId).code]).toEqual([422, 'VALIDATION_FAILED']);
    for (const body of [{ saved: 'sim' }, { saved: true, title: 'hackeado' }, { saved: true, expiresAt: '2030-01-01T00:00:00Z' }, {}, { title: 'x' }]) {
      const bad = await call('PATCH', `/api/chat/sessions/${chat.id}`, body);
      expect([JSON.stringify(body), bad.statusCode, errorOf(bad).code]).toEqual([JSON.stringify(body), 422, 'VALIDATION_FAILED']);
    }
    for (const content of ['', '   ', 'x'.repeat(32_001), 'a\u0000b']) {
      const bad = await call('POST', `/api/chat/sessions/${chat.id}/messages`, { content });
      expect([bad.statusCode, errorOf(bad).code]).toEqual([422, 'VALIDATION_FAILED']);
    }
    const extra = await call('POST', `/api/chat/sessions/${chat.id}/messages`, { content: 'oi', botId: UNKNOWN });
    expect(extra.statusCode).toBe(422);
    expect(json<ChatSession>(await call('GET', `/api/chat/sessions/${chat.id}`))).toMatchObject({ saved: false, title: null });
  });
});

describe('lista filtrada: a vista "Salvos" (phase 5, T10)', () => {
  it('?saved=true devolve só as salvas (sem a conversa de um bot) e recusa qualquer outro valor ou parâmetro na borda', async () => {
    // "Novo chat" devolve sempre o mesmo rascunho: salvar a primeira (uma escolha do dono) a tira do rascunho, e só então a segunda nasce, com uma mensagem no banco para
    // também entrar na lista completa.
    const saved = await openSession();
    expect(json<ChatSession>(await call('PATCH', `/api/chat/sessions/${saved.id}`, { saved: true })).saved).toBe(true);
    const temporary = await openSession();
    expect(temporary.id).not.toBe(saved.id);
    await api.pool.query("INSERT INTO messages (conversation_id, role, kind, status, content, created_at) VALUES ($1, 'user', 'text', 'done', 'temporária', now())", [temporary.id]);
    const bot = await createBot();
    const botConversation = (await api.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;

    const everything = json<ChatSessionList>(await call('GET', '/api/chat/sessions')).items;
    expect(everything.map((item) => item.id)).toEqual(expect.arrayContaining([saved.id, temporary.id]));
    const onlySaved = json<ChatSessionList>(await call('GET', '/api/chat/sessions?saved=true')).items;
    expect(onlySaved.length).toBeGreaterThan(0);
    expect(onlySaved.every((item) => item.saved && item.expiresAt === null)).toBe(true);
    expect(onlySaved.map((item) => item.id)).toContain(saved.id);
    expect(onlySaved.map((item) => item.id)).not.toContain(temporary.id);
    expect(onlySaved.map((item) => item.id)).not.toContain(botConversation);

    // Allowlist: só "true" é aceito; "false", texto livre e parâmetros extras são recusados, e a rota continua exigindo sessão.
    for (const query of ['saved=false', 'saved=1', 'saved=sim', 'saved=', 'status=saved', 'saved=true&limit=5']) {
      const bad = await call('GET', `/api/chat/sessions?${query}`);
      expect([query, bad.statusCode, errorOf(bad).code]).toEqual([query, 422, 'VALIDATION_FAILED']);
    }
    const anonymous = await api.app.inject({ method: 'GET', url: '/api/chat/sessions?saved=true', headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
    expect([anonymous.statusCode, errorOf(anonymous).code]).toEqual([401, 'AUTH_SESSION_EXPIRED']);
  });
});

describe('isolamento entre bots e sessões', () => {
  it('o id de um bot não abre uma sessão por nenhuma rota, e o de uma sessão não abre um bot; sessão inexistente é SESSION_NOT_FOUND', async () => {
    const bot = await createBot();
    const chat = await openSession();
    const sessionRoutes = [
      ['GET', '/api/chat/sessions/ID'],
      ['PATCH', '/api/chat/sessions/ID', { saved: true }],
      ['GET', '/api/chat/sessions/ID/conversation'],
      ['GET', '/api/chat/sessions/ID/conversation/messages'],
      ['POST', '/api/chat/sessions/ID/messages', { content: 'oi' }],
      ['PATCH', '/api/chat/sessions/ID/conversation', { model: 'opencode/glm-5.1', effort: null }],
      ['POST', '/api/chat/sessions/ID/runs/stop'],
      ['POST', '/api/chat/sessions/ID/runs/1/retry'],
      ['GET', '/api/chat/sessions/ID/conversation/events'],
    ] as const;
    for (const foreign of [bot.id, UNKNOWN]) {
      for (const [method, url, payload] of sessionRoutes) {
        const response = await call(method, url.replace('ID', foreign), payload);
        expect([url, response.statusCode, errorOf(response).code]).toEqual([url, 404, 'SESSION_NOT_FOUND']);
      }
    }
    // O contrário: o id de uma sessão não é um bot (as rotas do bot continuam as de sempre).
    const asBot = await call('GET', `/api/bots/${chat.id}/conversation`);
    expect([asBot.statusCode, errorOf(asBot).code]).toEqual([404, 'BOT_NOT_FOUND']);
    const sendAsBot = await call('POST', `/api/bots/${chat.id}/messages`, { content: 'oi' });
    expect([sendAsBot.statusCode, errorOf(sendAsBot).code]).toEqual([404, 'BOT_NOT_FOUND']);
    // A lista de sessões não traz a conversa de nenhum bot (nem o rascunho vazio, que ainda não é uma sessão do painel).
    const listed = json<ChatSessionList>(await call('GET', '/api/chat/sessions')).items.map((item) => item.id);
    expect(listed).not.toContain(chat.id);
    const botConversation = (await api.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
    expect(listed).not.toContain(botConversation);
  });
});

describe('a conversa dentro da sessão', () => {
  it('"Novo chat" devolve sempre o mesmo rascunho vazio, fora da lista, até a primeira mensagem; depois dela nasce outro', async () => {
    await discardDrafts();
    const first = json<ChatSession>(await call('POST', '/api/chat/sessions'));
    const again = await call('POST', '/api/chat/sessions');
    expect([again.statusCode, json<ChatSession>(again).id]).toEqual([201, first.id]);
    expect(json<ChatSessionList>(await call('GET', '/api/chat/sessions')).items.map((item) => item.id)).not.toContain(first.id);
    expect(json<ChatSession>(await call('GET', `/api/chat/sessions/${first.id}`))).toMatchObject({ id: first.id, title: null });

    expect((await call('PATCH', `/api/chat/sessions/${first.id}/conversation`, { model: 'opencode/glm-5.1', effort: null })).statusCode).toBe(200);
    const run = await send(first.id, 'primeira mensagem do novo chat');
    await waitFor('execução concluída', async () => (await runStatus(run)) === 'completed');
    const next = json<ChatSession>(await call('POST', '/api/chat/sessions'));
    expect(next.id).not.toBe(first.id);
    expect(json<ChatSessionList>(await call('GET', '/api/chat/sessions')).items.map((item) => item.id)).toContain(first.id);
  });

  it('cria, conversa pelas mesmas rotas do bot, ganha o título e expira em 7 dias; salvar tira a expiração', async () => {
    await discardDrafts();
    const created = json<ChatSession>(await call('POST', '/api/chat/sessions'));
    expect(created).toEqual({ id: expect.any(String), title: null, saved: false, createdAt: expect.any(String), lastActivityAt: created.createdAt, expiresAt: expect.any(String), unread: false });

    // Sem modelo escolhido o envio é recusado (a sessão não tem padrão de bot); depois de escolher, funciona.
    const noModel = await call('POST', `/api/chat/sessions/${created.id}/messages`, { content: 'oi' });
    expect([noModel.statusCode, errorOf(noModel).code]).toEqual([422, 'MODEL_UNAVAILABLE']);
    const preference = await call('PATCH', `/api/chat/sessions/${created.id}/conversation`, { model: 'opencode/glm-5.1', effort: null });
    expect(json(preference)).toEqual({ model: 'opencode/glm-5.1', effort: null, effortLevels: ['low', 'medium', 'high'] });

    const run = await send(created.id, '  Quero um resumo da semana  ');
    await waitFor('execução concluída', async () => (await statusOf(created.id, run)) === undefined && (await runStatus(run)) === 'completed');
    const snapshot = json<ConversationSnapshot>(await call('GET', `/api/chat/sessions/${created.id}/conversation`));
    expect(snapshot.providerConfigured).toBe(true);
    expect(snapshot.model).toEqual({ model: 'opencode/glm-5.1', effort: null, effortLevels: ['low', 'medium', 'high'] });
    expect(snapshot.items.map((item) => (item.kind === 'text' ? [item.role, item.content] : item.kind))).toEqual([
      ['user', 'Quero um resumo da semana'],
      ['assistant', expect.stringContaining('Resposta: ')],
    ]);
    const older = await call('GET', `/api/chat/sessions/${created.id}/conversation/messages?before=${snapshot.items[1]!.id}`);
    expect(json<{ items: unknown[]; hasMore: boolean }>(older)).toMatchObject({ items: [{ kind: 'text', role: 'user' }], hasMore: false });

    const listed = json<ChatSessionList>(await call('GET', '/api/chat/sessions')).items.find((item) => item.id === created.id)!;
    expect(listed.title).toBe('Quero um resumo da semana');
    expect(Date.parse(listed.expiresAt!) - Date.parse(listed.lastActivityAt)).toBe(7 * 24 * 3_600_000);

    const saved = json<ChatSession>(await call('PATCH', `/api/chat/sessions/${created.id}`, { saved: true }));
    expect(saved).toMatchObject({ saved: true, expiresAt: null });
    expect(json<ChatSession>(await call('PATCH', `/api/chat/sessions/${created.id}`, { saved: false })).expiresAt).toBe(listed.expiresAt);
  });

  it('a sessão carrega o histórico em rodadas como o bot (10 por vez, `before` é o id da mensagem) sem misturar as linhas de outra conversa', async () => {
    const chat = await openSession();
    // Ruído de outra conversa (a de um bot): nenhuma página da sessão pode trazer linha dela.
    const bot = await createBot();
    const botConversation = (await api.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
    await seedRounds(api.pool, botConversation, [1, 1, 1]);
    const seeded = await seedRounds(api.pool, chat.id, Array.from({ length: 12 }, (_, index) => index % 2));
    const idsOf = (from: number, to: number) => seeded.slice(from, to).flatMap((round) => round.ids);
    const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);
    const page = async (query: string) => json<{ items: { id: string }[]; hasMore: boolean }>(await call('GET', `/api/chat/sessions/${chat.id}/conversation/messages${query}`));

    const opening = json<ConversationSnapshot>(await call('GET', `/api/chat/sessions/${chat.id}/conversation`));
    expect(ids(opening)).toEqual(idsOf(2, 12)); // as 10 últimas rodadas
    expect(opening.hasMore).toBe(true);
    const older = await page(`?before=${opening.items[0]!.id}`);
    expect(ids(older)).toEqual(idsOf(0, 2));
    expect(older.hasMore).toBe(false);
    expect(ids(await page('?rounds=3'))).toEqual(idsOf(9, 12));
    expect((await call('GET', `/api/chat/sessions/${chat.id}/conversation/messages?limit=5`)).statusCode).toBe(422); // o parâmetro antigo, em itens, não existe mais
    expect((await call('GET', `/api/chat/sessions/${chat.id}/conversation/messages?rounds=51`)).statusCode).toBe(422);
  });

  it('transmite a conversa da sessão pelo SSE com o estado atual de cada linha, retomando por ?after=', async () => {
    const chat = await openSession();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/chat/sessions/${chat.id}/conversation/events?after=0`, { headers: { cookie: session.cookie }, signal: controller.signal });
    try {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('x-accel-buffering')).toBe('no');

      const run = await send(chat.id, 'transmita');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + 15_000;
      while (!/event: run\ndata: \{[^\n]*"status":"completed"/.test(buffer)) {
        if (Date.now() > deadline) throw new Error(`SSE sem o fim da execução; lido: ${buffer}`);
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      expect(buffer).toContain('event: message');
      expect(buffer).toMatch(/"role":"user","status":"done","content":"transmita"/);
      expect(buffer).toMatch(new RegExp(`event: run\\ndata: \\{"id":"${run}"`));
    } finally {
      controller.abort();
    }
  });

  it('a aprovação da sessão pendente de antes da phase 13 não aceita resposta permanente (422, com o motivo); permitir uma vez é aceito e a chamada é recusada sem executar no Composio; Atividades traz a pendência e a execução sem bot', async () => {
    const chat = await openSession();
    // A pendência de uma ação do conector na sessão, como a phase 12 a deixava no banco: o conector saiu do Chat geral na phase 13 e nada mais a cria (os testes de A6 e A7 do núcleo provam o motivo),
    // então a prova da borda a semeia, com a proveniência da atividade gravada.
    const run = (await seedLegacyChatApproval({ pool: api.pool, approvals: api.approvals, sessionId: chat.id, withProvenance: true })).runId;

    const page = json<ActivitiesPage>(await call('GET', '/api/activities'));
    const pending = page.pending.find((item) => item.runId === run)!;
    expect(pending).toMatchObject({ bot: null, sessionId: chat.id, actionLabel: 'Send Email · Gmail' });
    expect(page.items.find((item) => item.runId === run)).toMatchObject({ bot: null, sessionId: chat.id, status: 'waiting_approval', routineName: null });
    expect(pending.messageId).toMatch(/^\d+$/);

    for (const decision of ['allow_always', 'deny_always']) {
      const refused = await call('POST', `/api/approvals/${pending.approvalId}/respond`, { decision });
      expect([refused.statusCode, errorOf(refused).code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(errorOf(refused).fields?.[0]?.field).toBe('decision');
    }
    expect(await runStatus(run)).toBe('waiting_approval');
    expect((await api.pool.query('SELECT 1 FROM bot_approval_rules')).rowCount).toBe(0);

    const allowed = await call('POST', `/api/approvals/${pending.approvalId}/respond`, { decision: 'allow_once' });
    expect([allowed.statusCode, json<{ status: string }>(allowed).status]).toEqual([200, 'approved']);
    await waitFor('execução concluída', async () => (await runStatus(run)) === 'completed');
    // O Chat geral não tem conector: a chamada permitida foi recusada e nenhuma ação chegou ao Composio.
    expect(upstreams.requests.filter((request) => request.service === 'composio' && request.path.includes('/tools/execute/'))).toHaveLength(0);
    expect((await api.pool.query<{ status: string }>("SELECT status FROM messages WHERE run_id = $1 AND kind = 'activity'", [run])).rows).toEqual([{ status: 'failed' }]);
  });

  it('parar pela sessão vale só para a execução certa daquela sessão (?runId=), e a de outra sessão não é tocada', async () => {
    // A segunda sessão só é uma sessão nova depois que a primeira recebeu uma mensagem (antes disso "Novo chat" devolve o mesmo rascunho).
    const a = await openSession();
    const runA = await send(a.id, '[demorar]');
    const b = await openSession();
    expect(b.id).not.toBe(a.id);
    const runB = await send(b.id, '[demorar]');
    await waitFor('as duas rodando', async () => (await runStatus(runA)) === 'running' && (await runStatus(runB)) === 'running');

    const wrongSession = await call('POST', `/api/chat/sessions/${a.id}/runs/stop?runId=${runB}`);
    expect([wrongSession.statusCode, errorOf(wrongSession).code]).toEqual([409, 'RUN_NOT_ACTIVE']);
    const malformed = await call('POST', `/api/chat/sessions/${a.id}/runs/stop?runId=abc`);
    expect([malformed.statusCode, errorOf(malformed).code]).toEqual([422, 'VALIDATION_FAILED']);
    expect((await call('POST', `/api/chat/sessions/${a.id}/runs/stop?runId=${runA}`)).statusCode).toBe(200);
    await waitFor('A interrompida', async () => (await runStatus(runA)) === 'interrupted');
    expect(await runStatus(runB)).toBe('running');
    expect((await call('POST', `/api/chat/sessions/${b.id}/runs/stop`)).statusCode).toBe(200);
    await waitFor('B interrompida', async () => (await runStatus(runB)) === 'interrupted');
  });
});

describe('modelo padrão do Chat geral (T23)', () => {
  it('exige sessão, Origin e CSRF; só aceita um modelo da lista do provedor, sem campos extras nem modelo nulo; o padrão vale para a sessão nova e o envio sem ele é recusado', async () => {
    await api.pool.query('DELETE FROM general_chat_settings'); // começa sem padrão, e termina sem ele (os demais testes dependem disso)
    try {
      const anonymous = await api.app.inject({ method: 'GET', url: '/api/chat/settings', headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
      expect([anonymous.statusCode, errorOf(anonymous).code]).toEqual([401, 'AUTH_SESSION_EXPIRED']);
      const valid = { model: 'opencode/glm-5.1', effort: null };
      const resolved = { ...valid, effortLevels: ['low', 'medium', 'high'] };
      const noCsrf = await call('PUT', '/api/chat/settings', valid, { 'x-csrf-token': '' });
      expect([noCsrf.statusCode, errorOf(noCsrf).code]).toEqual([403, 'CSRF_TOKEN_INVALID']);
      const wrongOrigin = await call('PUT', '/api/chat/settings', valid, { origin: 'https://evil.example' });
      expect([wrongOrigin.statusCode, errorOf(wrongOrigin).code]).toEqual([403, 'CSRF_ORIGIN_INVALID']);

      // Sem padrão: a leitura traz modelo nulo, e uma sessão nova não tem modelo (o envio é recusado).
      expect(json(await call('GET', '/api/chat/settings'))).toEqual({ model: null, effort: null, effortLevels: [] });
      await discardDrafts();
      const fresh = json<ChatSession>(await call('POST', '/api/chat/sessions'));
      expect(json<ConversationSnapshot>(await call('GET', `/api/chat/sessions/${fresh.id}/conversation`)).model).toEqual({ model: null, effort: null, effortLevels: [] });
      const refused = await call('POST', `/api/chat/sessions/${fresh.id}/messages`, { content: 'oi' });
      expect([refused.statusCode, errorOf(refused).code]).toEqual([422, 'MODEL_UNAVAILABLE']);

      // Formato e allowlist na borda: modelo nulo ou ausente, campo extra, effort fora do vocabulário, modelo com caractere de controle.
      for (const bad of [{ model: null, effort: null }, { effort: null }, { model: 'opencode/glm-5.1' }, { ...valid, extra: true }, { model: 'opencode/glm-5.1', effort: 'altissimo' }, { model: 'glm\u0000x', effort: null }, { model: '', effort: null }]) {
        const response = await call('PUT', '/api/chat/settings', bad);
        expect([JSON.stringify(bad), response.statusCode, errorOf(response).code]).toEqual([JSON.stringify(bad), 422, 'VALIDATION_FAILED']);
      }
      // Fora da lista do provedor e effort que o modelo não aceita (o glm-5.1 do provedor falso aceita baixo, médio e alto): recusados sem gravar nada.
      const unknown = await call('PUT', '/api/chat/settings', { model: 'nao-existe', effort: null });
      expect([unknown.statusCode, errorOf(unknown).code]).toEqual([422, 'MODEL_UNAVAILABLE']);
      const noEffort = await call('PUT', '/api/chat/settings', { model: 'opencode/glm-5.1', effort: 'max' });
      expect([noEffort.statusCode, errorOf(noEffort).code, errorOf(noEffort).fields?.[0]?.field]).toEqual([422, 'VALIDATION_FAILED', 'effort']);
      expect(json(await call('GET', '/api/chat/settings'))).toEqual({ model: null, effort: null, effortLevels: [] });

      // Definido: a leitura o devolve, a sessão que já existia o herda e o envio passa a ser aceito; a troca no composer não muda o padrão.
      const saved = await call('PUT', '/api/chat/settings', valid);
      expect([saved.statusCode, json(saved)]).toEqual([200, resolved]);
      expect(json(await call('GET', '/api/chat/settings'))).toEqual(resolved);
      expect(json<ConversationSnapshot>(await call('GET', `/api/chat/sessions/${fresh.id}/conversation`)).model).toEqual(resolved);
      expect((await call('POST', `/api/chat/sessions/${fresh.id}/messages`, { content: 'agora vai' })).statusCode).toBe(201);
      expect((await call('PATCH', `/api/chat/sessions/${fresh.id}/conversation`, { model: 'opencode/grok-4.7', effort: null })).statusCode).toBe(200);
      expect(json(await call('GET', '/api/chat/settings'))).toEqual(resolved);
    } finally {
      await api.pool.query('DELETE FROM general_chat_settings');
    }
  });
});

describe('versões da sessão pela borda (phase 4, T3)', () => {
  it('só a sessão tem as rotas (no bot, 404); corpos estritos e CSRF; versão de outra sessão é VERSION_NOT_FOUND; execução aberta é CONVERSATION_BUSY', async () => {
    const chat = await openSession();
    const done = async (runId: string) => waitFor(`execução ${runId} concluída`, async () => (await runStatus(runId)) === 'completed');
    const r1 = await send(chat.id, 'primeira');
    await done(r1);
    const r2 = await send(chat.id, 'segunda');
    await done(r2);
    const m1 = (await api.pool.query<{ id: string }>('SELECT trigger_message_id::text AS id FROM runs WHERE id = $1', [r1])).rows[0]!.id;
    const versions = (path: string, payload?: unknown, headers?: Record<string, string>) => call('POST', `/api/chat/sessions/${chat.id}/versions/${path}`, payload, headers);

    // O bot é linear (CONV-02): as rotas nem existem para ele.
    const bot = await createBot();
    for (const path of ['edit', 'regenerate', 'rewind', 'restore', 'choose']) {
      const refused = await call('POST', `/api/bots/${bot.id}/versions/${path}`, { runId: r1 });
      expect([path, refused.statusCode, errorOf(refused).code]).toEqual([path, 404, 'NOT_FOUND']);
    }

    // Corpos estritos (campo extra, os dois alvos juntos, id malformado, texto vazio) e CSRF nas alterações.
    for (const [path, payload] of [
      ['choose', { runId: r1, messageId: m1 }],
      ['choose', { runId: r1, extra: true }],
      ['regenerate', { runId: 'abc' }],
      ['rewind', {}],
      ['edit', { messageId: m1, content: '   ' }],
      ['edit', { messageId: m1, content: 'ok', attachmentIds: [], extra: 1 }],
    ] as const) {
      const refused = await versions(path, payload);
      expect([path, refused.statusCode, errorOf(refused).code]).toEqual([path, 422, 'VALIDATION_FAILED']);
    }
    const noCsrf = await versions('choose', { runId: r1 }, { 'x-csrf-token': '' });
    expect([noCsrf.statusCode, errorOf(noCsrf).code]).toEqual([403, 'CSRF_TOKEN_INVALID']);

    // Anti-IDOR: a execução e a mensagem de outra sessão não são versões desta.
    const other = await openSession();
    const foreign = await send(other.id, 'de outra sessão');
    await done(foreign);
    for (const [path, payload] of [
      ['choose', { runId: foreign }],
      ['regenerate', { runId: foreign }],
      ['rewind', { runId: foreign }],
    ] as const) {
      const refused = await versions(path, payload);
      expect([path, refused.statusCode, errorOf(refused).code]).toEqual([path, 404, 'VERSION_NOT_FOUND']);
    }

    // Os contratos: retroceder e restaurar devolvem o snapshot; gerar e editar, a execução criada (201).
    const rewound = await versions('rewind', { runId: r1 });
    expect([rewound.statusCode, json<ConversationSnapshot>(rewound).rewound]).toEqual([200, { runId: r1, rounds: 1 }]);
    const restored = await versions('restore');
    expect([restored.statusCode, json<ConversationSnapshot>(restored).rewound]).toEqual([200, null]);
    const regenerated = await versions('regenerate', { runId: r2 });
    expect(regenerated.statusCode).toBe(201);
    await done(json<RunView>(regenerated).id);
    const edited = await versions('edit', { messageId: m1, content: 'primeira editada', attachmentIds: [] });
    expect(edited.statusCode).toBe(201);
    await done(json<RunView>(edited).id);
    const chosen = await versions('choose', { messageId: m1 });
    expect(chosen.statusCode).toBe(200);
    expect(json<ConversationSnapshot>(chosen).rounds?.map((round) => round.messageVersions.length)).toEqual([2, 1]);

    // Execução aberta: tudo recusado até ela terminar.
    const busy = await send(chat.id, '[demorar]');
    await waitFor('rodando', async () => (await runStatus(busy)) === 'running');
    const refused = await versions('choose', { runId: r1 });
    expect([refused.statusCode, errorOf(refused).code]).toEqual([409, 'CONVERSATION_BUSY']);
    expect((await call('POST', `/api/chat/sessions/${chat.id}/runs/stop`)).statusCode).toBe(200);
    await waitFor('interrompida', async () => (await runStatus(busy)) === 'interrupted');
  });
});
