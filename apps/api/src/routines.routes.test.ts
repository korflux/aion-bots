// Prova das rotinas pela borda HTTP (T9; A4, A12; F12, F13): sessão, CSRF e allowlist em todas as rotas, o contrato dos códigos de erro
// (SCHEDULE_INVALID com o motivo, SCHEDULE_IN_PAST, BOT_ARCHIVED, ROUTINE_NOT_FOUND, ROUTINE_CHANGED), o fluxo do dono (criar, prévia, editar, pausar,
// retomar, executar agora, histórico, excluir) e o fluxo do bot de ponta a ponta: API real, motor e agendador reais no mesmo processo e
// o provedor falso. Desde a phase 10 a rotina e a alteração do bot valem na hora e o dono recusa (`POST /routines/cards/:id/refuse`) ou edita
// (`PUT /routines/:id` com `cardId`) pelo cartão; a proposta antiga pendente ainda se confirma. A regra de negócio e os atrasos estão provados em
// @aion/core; aqui fica o que só a borda prova (inclusive que o instantâneo de restauração nunca chega ao navegador).
import { RoutineScheduler, RunEngine, createOpenCodeGoClient } from '@aion/core';
import { startFakeUpstreams, type FakeUpstreams } from '@aion/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

const PROVIDER_KEY = 'valid-provider-key-ABCD';
const CLIENT_IP = '203.0.113.94';
const GHOST = '00000000-0000-4000-8000-000000000000';

let upstreams: FakeUpstreams;
let api: TestApi;
let engine: RunEngine;
let scheduler: RoutineScheduler;
let session: { cookie: string; csrfToken: string };

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  api = await createTestApi({ AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl, AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl });
  session = await api.login(CLIENT_IP);
  const provider = await api.app.inject({
    method: 'POST',
    url: '/api/credentials/provider',
    payload: { key: PROVIDER_KEY },
    headers: { origin: ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'user-agent': CHROME_UA },
    remoteAddress: CLIENT_IP,
  });
  if (provider.statusCode !== 200) throw new Error(`falha ao configurar o provedor falso: ${provider.statusCode}`);
  // O motor e o agendador rodam aqui no mesmo processo (em produção é o worker), sobre o mesmo banco e o provedor falso.
  engine = new RunEngine({
    pool: api.pool,
    credentials: api.credentials,
    provider: createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, chatTimeoutMs: 15_000 }),
    models: api.models,
    logger: api.logger,
    config: { pollMs: 20, heartbeatMs: 40, flushMs: 15 },
  });
  engine.start();
  scheduler = new RoutineScheduler({ pool: api.pool, logger: api.logger, config: { pollMs: 25 } });
  scheduler.start();
});

afterAll(async () => {
  await scheduler.stop();
  await engine.stop();
  api.app.server.closeAllConnections();
  await api.cleanup();
  await upstreams.stop();
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Chamada autenticada por padrão (cookie, Origin e token CSRF). */
async function call(method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
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

async function createBot(): Promise<string> {
  const created = await call('POST', '/api/bots', {
    name: `Bot ${Math.random().toString(36).slice(2, 8)}`,
    color: '#60A5FA',
    instructions: '',
    model: 'opencode/glm-5.1',
    effort: null,
    stepLimit: 25,
  });
  expect(created.statusCode).toBe(201);
  return json<{ id: string }>(created).id;
}

const DAILY = { schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null };
const body = (botId: string, overrides: Record<string, unknown> = {}) => ({ name: 'Resumo', botId, instruction: 'Resuma o dia', ...DAILY, ...overrides });

interface RoutineBody {
  id: string;
  name: string;
  status: string;
  summary: string;
  nextRunAt: string | null;
  runCount: number;
  bot: { id: string; archived: boolean };
  schedule: { type: string };
}

describe('segurança e contrato', () => {
  it('toda rota exige sessão; as que alteram estado exigem Origin e token CSRF; ids, corpos e campos extras são recusados na borda', async () => {
    const botId = await createBot();
    const routineId = json<RoutineBody>(await call('POST', '/api/routines', body(botId))).id;
    const routes: [Method, string, unknown?][] = [
      ['GET', '/api/routines'],
      ['POST', '/api/routines/preview', DAILY],
      ['POST', '/api/routines', body(botId)],
      ['GET', `/api/routines/${routineId}`],
      ['PUT', `/api/routines/${routineId}`, body(botId)],
      ['DELETE', `/api/routines/${routineId}`],
      ['POST', `/api/routines/${routineId}/pause`],
      ['POST', `/api/routines/${routineId}/resume`],
      ['POST', `/api/routines/${routineId}/run`],
      ['GET', `/api/routines/${routineId}/history`],
      ['POST', '/api/routines/changes/1/confirm'],
      ['POST', '/api/routines/cards/1/refuse'],
    ];
    for (const [method, url, payload] of routes) {
      const anonymous = await api.app.inject({ method, url, payload: payload as object | undefined, headers: { origin: ORIGIN }, remoteAddress: CLIENT_IP });
      expect([method, url, anonymous.statusCode, errorOf(anonymous).code]).toEqual([method, url, 401, 'AUTH_SESSION_EXPIRED']);
    }
    for (const [method, url, payload] of routes.filter(([method]) => method !== 'GET')) {
      const noCsrf = await call(method, url, payload, { 'x-csrf-token': '' });
      expect([method, url, noCsrf.statusCode, errorOf(noCsrf).code]).toEqual([method, url, 403, 'CSRF_TOKEN_INVALID']);
      const wrongOrigin = await call(method, url, payload, { origin: 'https://evil.example' });
      expect([method, url, wrongOrigin.statusCode, errorOf(wrongOrigin).code]).toEqual([method, url, 403, 'CSRF_ORIGIN_INVALID']);
    }

    // Formato e allowlist: nada além do declarado (nem status, nem proximo horario, nem execuções), tipos e faixas certos.
    const bad: [Method, string, unknown][] = [
      ['POST', '/api/routines', { ...body(botId), nextRunAt: '2030-01-01T00:00:00Z' }],
      ['POST', '/api/routines', { ...body(botId), status: 'completed' }],
      ['POST', '/api/routines', body(botId, { name: '' })],
      ['POST', '/api/routines', body(botId, { name: 'x'.repeat(81) })],
      ['POST', '/api/routines', body(botId, { instruction: 'x'.repeat(4001) })],
      ['POST', '/api/routines', body('nao-e-uuid')],
      ['POST', '/api/routines', body(botId, { maxRuns: 0 })],
      ['POST', '/api/routines', body(botId, { maxRuns: 10_001 })],
      ['POST', '/api/routines', body(botId, { startsAt: '2026-02-31T10:00' })],
      ['POST', '/api/routines', body(botId, { timezone: '../../etc/passwd' })],
      ['POST', '/api/routines', body(botId, { schedule: { type: 'daily', times: ['25:00'] } })],
      ['POST', '/api/routines', body(botId, { schedule: { type: 'daily', times: ['07:00', '07:00'] } })],
      ['POST', '/api/routines', body(botId, { schedule: { type: 'weekly', days: ['XX'], times: ['07:00'] } })],
      ['POST', '/api/routines', body(botId, { schedule: { type: 'daily', times: ['07:00'], extra: true } })],
      ['POST', '/api/routines', body(botId, { schedule: { type: 'inventado' } })],
      ['POST', '/api/routines', body(botId, { proposalMessageId: 'abc' })],
      ['PUT', `/api/routines/${routineId}`, { ...body(botId), proposalMessageId: '1' }],
      ['PUT', '/api/routines/nao-e-uuid', body(botId)],
      ['POST', '/api/routines/preview', { ...DAILY, name: 'não é da prévia' }],
      ['GET', `/api/routines/${routineId}/history?cursor=abc`, undefined],
      ['GET', `/api/routines/${routineId}/history?cursor=1&extra=1`, undefined],
      ['POST', '/api/routines/changes/abc/confirm', undefined],
      ['POST', '/api/routines/cards/abc/refuse', undefined],
      ['POST', `/api/routines/cards/${GHOST}/refuse`, undefined],
      ['PUT', `/api/routines/${routineId}`, { ...body(botId), cardId: 'abc' }],
      ['POST', `/api/routines/changes/${GHOST}/confirm`, undefined],
    ];
    for (const [method, url, payload] of bad) {
      const response = await call(method, url, payload);
      expect([method, url, response.statusCode, errorOf(response).code]).toEqual([method, url, 422, 'VALIDATION_FAILED']);
    }

    // Recursos que não existem.
    for (const [method, url, payload] of [
      ['GET', `/api/routines/${GHOST}`],
      ['PUT', `/api/routines/${GHOST}`, body(botId)],
      ['DELETE', `/api/routines/${GHOST}`],
      ['POST', `/api/routines/${GHOST}/pause`],
      ['POST', `/api/routines/${GHOST}/resume`],
      ['POST', `/api/routines/${GHOST}/run`],
      ['GET', `/api/routines/${GHOST}/history`],
    ] as [Method, string, unknown?][]) {
      const response = await call(method, url, payload);
      expect([method, url, response.statusCode, errorOf(response).code]).toEqual([method, url, 404, 'ROUTINE_NOT_FOUND']);
    }
    expect(errorOf(await call('POST', '/api/routines', body(GHOST))).code).toBe('BOT_NOT_FOUND');
    // Nada disso alterou a rotina.
    expect(json<RoutineBody>(await call('GET', `/api/routines/${routineId}`))).toMatchObject({ name: 'Resumo', status: 'active', runCount: 0 });
  });
});

describe('o dono cria, vê a prévia, edita, pausa, retoma e exclui', () => {
  it('dia útil passa pela borda, preserva a agenda e usa a mesma prévia ao salvar', async () => {
    const settings = { ...DAILY, schedule: { type: 'monthly_business_day', position: 20, time: '09:00' }, timezone: 'America/New_York' };
    const preview = await call('POST', '/api/routines/preview', settings);
    expect(preview.statusCode).toBe(200);
    const result = json<{ valid: boolean; occurrences: string[]; description: string }>(preview);
    expect(result.valid).toBe(true);
    expect(result.occurrences).toHaveLength(5);
    expect(result.description).toContain('incluindo feriados');
    const created = await call('POST', '/api/routines', body(await createBot(), settings));
    expect(created.statusCode).toBe(201);
    expect(json<RoutineBody>(created)).toMatchObject({ schedule: settings.schedule, timezone: settings.timezone, nextRunAt: result.occurrences[0] });
    for (const position of [0, 21]) {
      const rejected = await call('POST', '/api/routines/preview', { ...settings, schedule: { ...settings.schedule, position } });
      expect([rejected.statusCode, errorOf(rejected).code]).toEqual([422, 'VALIDATION_FAILED']);
    }
    const extra = await call('POST', '/api/routines/preview', { ...settings, schedule: { ...settings.schedule, holidays: [] } });
    expect([extra.statusCode, errorOf(extra).code]).toEqual([422, 'VALIDATION_FAILED']);
  });
  it('a prévia mostra as 5 próximas datas ou o motivo; salvar valida com o mesmo motor; a data única no passado é código próprio', async () => {
    const preview = await call('POST', '/api/routines/preview', { schedule: { type: 'monthly_position', position: 'last', weekday: 'FR', time: '09:00' }, timezone: 'America/New_York', startsAt: null, endsAt: null, maxRuns: null });
    expect(preview.statusCode).toBe(200);
    const valid = json<{ valid: boolean; reason: string | null; description: string; occurrences: string[] }>(preview);
    expect(valid).toMatchObject({ valid: true, reason: null, description: 'Na última sexta-feira do mês às 09:00' });
    expect(valid.occurrences).toHaveLength(5);
    expect(valid.occurrences.every((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value))).toBe(true);

    const invalidPreview = await call('POST', '/api/routines/preview', { ...DAILY, schedule: { type: 'cron', expression: '99 7 * * *' } });
    expect(invalidPreview.statusCode).toBe(200);
    expect(json<{ valid: boolean; reason: string }>(invalidPreview)).toMatchObject({ valid: false });
    expect(json<{ reason: string }>(invalidPreview).reason).toMatch(/cron inválida/);

    const botId = await createBot();
    const tooFast = await call('POST', '/api/routines', body(botId, { schedule: { type: 'interval', every: 4, unit: 'minutes', window: null } }));
    expect([tooFast.statusCode, errorOf(tooFast).code]).toEqual([422, 'SCHEDULE_INVALID']);
    expect(errorOf(tooFast).fields).toEqual([{ field: 'schedule', reason: 'O intervalo mínimo é de 5 minutos.' }]);
    const past = await call('POST', '/api/routines', body(botId, { schedule: { type: 'once', at: '2020-01-01T10:00' } }));
    expect([past.statusCode, errorOf(past).code]).toEqual([422, 'SCHEDULE_IN_PAST']);
  });

  it('o ciclo de vida de uma rotina pela API', async () => {
    const botId = await createBot();
    const created = await call('POST', '/api/routines', body(botId));
    expect(created.statusCode).toBe(201);
    const routine = json<RoutineBody>(created);
    expect(routine).toMatchObject({ name: 'Resumo', status: 'active', summary: 'Todos os dias às 07:00', runCount: 0, bot: { id: botId, archived: false } });
    expect(routine.nextRunAt).toMatch(/T10:00:00\.000Z$/);
    expect(json<{ routines: RoutineBody[] }>(await call('GET', '/api/routines')).routines.map((item) => item.id)).toContain(routine.id);

    const edited = await call('PUT', `/api/routines/${routine.id}`, body(botId, { name: 'Resumo da manhã', schedule: { type: 'weekly', days: ['MO', 'WE'], times: ['08:30'] } }));
    expect(json<RoutineBody>(edited)).toMatchObject({ name: 'Resumo da manhã', summary: 'Segundas e quartas às 08:30', status: 'active' });

    expect(json<RoutineBody>(await call('POST', `/api/routines/${routine.id}/pause`))).toMatchObject({ status: 'paused', nextRunAt: null });
    expect(json<RoutineBody>(await call('POST', `/api/routines/${routine.id}/pause`)).status).toBe('paused'); // idempotente
    const resumed = json<RoutineBody>(await call('POST', `/api/routines/${routine.id}/resume`));
    expect(resumed.status).toBe('active');
    expect(resumed.nextRunAt).not.toBeNull();

    const deleted = await call('DELETE', `/api/routines/${routine.id}`);
    expect(deleted.statusCode).toBe(204);
    expect(errorOf(await call('GET', `/api/routines/${routine.id}`)).code).toBe('ROUTINE_NOT_FOUND');
    // A auditoria registrou as alterações, sem o texto da instrução.
    const audit = await api.pool.query<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'routine.%' AND target = $1 ORDER BY id", [routine.id]);
    expect(audit.rows.map((row) => row.action)).toEqual(['routine.create', 'routine.update', 'routine.pause', 'routine.resume', 'routine.delete']);
  });

  it('arquivar o bot pausa a rotina e a retomada é recusada com BOT_ARCHIVED', async () => {
    const botId = await createBot();
    const routine = json<RoutineBody>(await call('POST', '/api/routines', body(botId)));
    expect((await call('POST', `/api/bots/${botId}/archive`)).statusCode).toBe(200);
    expect(json<RoutineBody>(await call('GET', `/api/routines/${routine.id}`))).toMatchObject({ status: 'paused', nextRunAt: null, bot: { archived: true } });
    expect(errorOf(await call('POST', `/api/routines/${routine.id}/resume`)).code).toBe('BOT_ARCHIVED');
    expect(errorOf(await call('POST', `/api/routines/${routine.id}/run`)).code).toBe('BOT_ARCHIVED');
    expect(errorOf(await call('POST', '/api/routines', body(botId))).code).toBe('BOT_ARCHIVED');
  });
});

describe('executar agora e o resultado na conversa (de ponta a ponta)', () => {
  it('"Executar agora" responde 202, o worker executa na fila do bot e a conversa mostra o cartão da rotina; o histórico leva a ele', async () => {
    const botId = await createBot();
    const routine = json<RoutineBody>(await call('POST', '/api/routines', body(botId, { instruction: 'Resuma as novidades' })));
    const queued = await call('POST', `/api/routines/${routine.id}/run`);
    expect(queued.statusCode).toBe(202);
    expect(json<{ status: string; routineName: string }>(queued)).toMatchObject({ status: 'queued', routineName: 'Resumo' });

    const card = await waitFor('o cartão da rotina concluído na conversa', async () => {
      const snapshot = json<{ items: { kind: string; card?: { type: string; state: string; routineName: string; manual: boolean } }[] }>(await call('GET', `/api/bots/${botId}/conversation`));
      return snapshot.items.find((item) => item.kind === 'card' && item.card?.type === 'routine_run' && item.card.state === 'completed')?.card ?? null;
    });
    expect(card).toMatchObject({ routineName: 'Resumo', manual: true });
    expect(card).not.toHaveProperty('result'); // o resultado é a mensagem do bot abaixo do cartão, não uma cópia dentro dele (T20)

    const history = json<{ items: { state: string; manual: boolean; messageId: string | null }[]; nextCursor: string | null }>(await call('GET', `/api/routines/${routine.id}/history`));
    expect(history.items).toMatchObject([{ state: 'completed', manual: true }]);
    expect(history.items[0]?.messageId).not.toBeNull();
    expect(history.nextCursor).toBeNull();
    expect(json<RoutineBody>(await call('GET', `/api/routines/${routine.id}`)).runCount).toBe(0); // manual não consome o limite
  });

  it('o agendador dispara no horário previsto, com o app "fechado" (sem nenhuma requisição do dono)', async () => {
    const botId = await createBot();
    const routine = json<RoutineBody>(await call('POST', '/api/routines', body(botId)));
    // Adianta o horário previsto: o agendador (que roda sozinho, como no worker) encontra a rotina vencida.
    await api.pool.query("UPDATE routines SET next_run_at = now() - interval '5 seconds' WHERE id = $1", [routine.id]);
    const run = await waitFor('a execução agendada concluir', async () => {
      const found = await api.pool.query<{ status: string }>("SELECT status FROM runs WHERE routine_id = $1 AND status = 'completed'", [routine.id]);
      return found.rows[0] ?? null;
    });
    expect(run.status).toBe('completed');
    expect(json<RoutineBody>(await call('GET', `/api/routines/${routine.id}`))).toMatchObject({ runCount: 1 });
    const history = json<{ items: { state: string; manual: boolean }[] }>(await call('GET', `/api/routines/${routine.id}/history`));
    expect(history.items).toMatchObject([{ state: 'completed', manual: false }]);
  });
});

/** Um cartão da conversa do bot como a tela o recebe (só o que o contrato `@aion/shared` declara chega ao navegador). */
interface CardItem {
  id: string;
  kind: string;
  content?: string;
  card?: { type: string; status?: string; routineId?: string | null; routineName?: string; action?: string; change?: { action: string } } & Record<string, unknown>;
}

/** Espera o cartão `type` da conversa do bot que passa em `accept` (por padrão o mais recente) e o devolve. */
async function conversationCard(botId: string, type: string, accept: (item: CardItem) => boolean = () => true): Promise<CardItem> {
  return waitFor(`o cartão ${type} na conversa`, async () => {
    const snapshot = json<{ items: CardItem[] }>(await call('GET', `/api/bots/${botId}/conversation`));
    return snapshot.items.filter((item) => item.kind === 'card' && item.card?.type === type && accept(item)).at(-1) ?? null;
  });
}

/** Insere uma proposta ANTIGA pendente (criada antes da phase 10) na conversa do bot: a ferramenta já não a grava, mas o dono ainda a confirma. */
async function insertLegacyCard(botId: string, card: Record<string, unknown>): Promise<string> {
  const conversation = (await api.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [botId])).rows[0] as { id: string };
  const inserted = await api.pool.query<{ id: string }>(
    "INSERT INTO messages (conversation_id, role, kind, status, content, data, created_at) VALUES ($1, 'system', 'card', 'done', '', $2, now()) RETURNING id::text AS id",
    [conversation.id, JSON.stringify(card)],
  );
  return (inserted.rows[0] as { id: string }).id;
}

describe('rotina criada pelo bot (phase 10): vale na hora, o dono recusa ou edita pelo cartão', () => {
  it('o bot cria a rotina ativa, o dono a recusa pelo cartão (idempotente) e o bot é avisado; recusar um id que não é cartão de rotina é 404', async () => {
    const botId = await createBot();
    expect((await call('POST', `/api/bots/${botId}/messages`, { content: '[rotina:Resumo diário|07:30]' })).statusCode).toBe(201);
    const card = await conversationCard(botId, 'routine_proposal');
    expect(card.card).toMatchObject({ status: 'applied', proposal: { name: 'Resumo diário', timezone: 'America/Sao_Paulo' } });
    // A rotina já existe e está ativa, sem nenhum clique do dono.
    const routine = json<{ routines: RoutineBody[] }>(await call('GET', '/api/routines')).routines.find((item) => item.name === 'Resumo diário' && item.bot.id === botId)!;
    expect(routine).toMatchObject({ status: 'active' });
    expect(card.card?.routineId).toBe(routine.id);

    const refused = await call('POST', `/api/routines/cards/${card.id}/refuse`);
    expect(refused.statusCode).toBe(200);
    expect(json(refused)).toEqual({ routine: null });
    expect(errorOf(await call('GET', `/api/routines/${routine.id}`)).code).toBe('ROUTINE_NOT_FOUND');
    expect(json(await call('POST', `/api/routines/cards/${card.id}/refuse`))).toEqual({ routine: null }); // idempotente
    expect((await conversationCard(botId, 'routine_proposal')).card).toMatchObject({ status: 'refused', routineId: null });
    // O aviso ao bot entra no fim da conversa: uma linha para a tela, com o que foi recusado.
    const notice = await conversationCard(botId, 'routine_refused');
    expect(notice.card).toEqual({ type: 'routine_refused', routineId: null, routineName: 'Resumo diário', action: 'create' });
    expect(notice.content).toContain('O dono recusou a rotina que você criou');

    // Só cartões de rotina aplicada pelo bot: uma mensagem qualquer e um id inexistente dão 404.
    const text = await waitFor('a resposta do bot', async () => {
      const snapshot = json<{ items: { id: string; kind: string; role?: string }[] }>(await call('GET', `/api/bots/${botId}/conversation`));
      return snapshot.items.find((item) => item.kind === 'text' && item.role === 'assistant') ?? null;
    });
    for (const id of [text.id, '999999999']) {
      const response = await call('POST', `/api/routines/cards/${id}/refuse`);
      expect([id, response.statusCode, errorOf(response).code]).toEqual([id, 404, 'NOT_FOUND']);
    }
  });

  it('editar pelo cartão: o editor manda o cardId com a rotina inteira, o cartão vira "editada", o bot é avisado e a segunda edição ou a recusa dão 409 ROUTINE_CHANGED', async () => {
    const botId = await createBot();
    expect((await call('POST', `/api/bots/${botId}/messages`, { content: '[rotina:Lembrete|08:00]' })).statusCode).toBe(201);
    const card = await conversationCard(botId, 'routine_proposal');
    const routine = json<{ routines: RoutineBody[] }>(await call('GET', '/api/routines')).routines.find((item) => item.name === 'Lembrete' && item.bot.id === botId)!;

    // O campo extra continua proibido, e um cardId que não é número é recusado na borda.
    for (const payload of [{ ...body(botId, { name: 'Lembrete' }), cardId: 'abc' }, { ...body(botId, { name: 'Lembrete' }), cardId: card.id, extra: true }]) {
      const response = await call('PUT', `/api/routines/${routine.id}`, payload);
      expect([response.statusCode, errorOf(response).code]).toEqual([422, 'VALIDATION_FAILED']);
    }
    // Um cartão que não existe (ou não é desta rotina) é 404 e a rotina não muda.
    const ghostCard = await call('PUT', `/api/routines/${routine.id}`, { ...body(botId, { name: 'Outro nome' }), cardId: '999999999' });
    expect([ghostCard.statusCode, errorOf(ghostCard).code]).toEqual([404, 'NOT_FOUND']);
    expect(json<RoutineBody>(await call('GET', `/api/routines/${routine.id}`)).name).toBe('Lembrete');

    const edited = await call('PUT', `/api/routines/${routine.id}`, { ...body(botId, { name: 'Lembrete do dono', instruction: 'Instrução do dono.', schedule: { type: 'daily', times: ['09:15'] } }), cardId: card.id });
    expect(edited.statusCode).toBe(200);
    expect(json<RoutineBody>(edited)).toMatchObject({ id: routine.id, name: 'Lembrete do dono', summary: 'Todos os dias às 09:15' });
    expect((await conversationCard(botId, 'routine_proposal')).card).toMatchObject({ status: 'edited', routineId: routine.id });
    const notice = await conversationCard(botId, 'routine_edited');
    expect(notice.card).toEqual({ type: 'routine_edited', routineId: routine.id, routineName: 'Lembrete do dono' });
    expect(notice.content).toContain('Instrução:\nInstrução do dono.');

    const again = await call('PUT', `/api/routines/${routine.id}`, { ...body(botId, { name: 'Lembrete do dono' }), cardId: card.id });
    expect([again.statusCode, errorOf(again).code]).toEqual([409, 'ROUTINE_CHANGED']);
    const refuse = await call('POST', `/api/routines/cards/${card.id}/refuse`);
    expect([refuse.statusCode, errorOf(refuse).code]).toEqual([409, 'ROUTINE_CHANGED']);
    expect(json<RoutineBody>(await call('GET', `/api/routines/${routine.id}`))).toMatchObject({ name: 'Lembrete do dono' });
  });

  it('a proposta ANTIGA pendente continua confirmável: criar com o cartão não duplica, o cartão de outro bot não vale e o cartão aplicado não é confirmável', async () => {
    const botId = await createBot();
    const otherBot = await createBot();
    const proposal = { name: 'Resumo antigo', instruction: 'Executar Resumo antigo', ...DAILY };
    const cardId = await insertLegacyCard(botId, { type: 'routine_proposal', proposal, summary: 'Todos os dias às 07:00', nextRuns: [], status: 'pending', routineId: null });

    const stranger = await call('POST', '/api/routines', { ...proposal, botId: otherBot, proposalMessageId: cardId });
    expect([stranger.statusCode, errorOf(stranger).code]).toEqual([404, 'NOT_FOUND']);
    const confirmed = await call('POST', '/api/routines', { ...proposal, botId, proposalMessageId: cardId });
    expect(confirmed.statusCode).toBe(201);
    const again = await call('POST', '/api/routines', { ...proposal, botId, proposalMessageId: cardId });
    expect(json<RoutineBody>(again).id).toBe(json<RoutineBody>(confirmed).id);
    expect((await conversationCard(botId, 'routine_proposal')).card).toMatchObject({ status: 'confirmed', routineId: json<RoutineBody>(confirmed).id });
    // Recusar e editar pelo cartão só existem para o que o bot aplicou.
    expect(errorOf(await call('POST', `/api/routines/cards/${cardId}/refuse`)).code).toBe('NOT_FOUND');

    // Um cartão que o bot aplicou já vale: usá-lo como proposta não cria outra rotina.
    expect((await call('POST', `/api/bots/${botId}/messages`, { content: '[rotina:Resumo novo|07:30]' })).statusCode).toBe(201);
    const applied = await conversationCard(botId, 'routine_proposal', (item) => item.card?.status === 'applied');
    const reuse = await call('POST', '/api/routines', { ...proposal, name: 'Resumo novo', botId, proposalMessageId: applied.id });
    expect([reuse.statusCode, errorOf(reuse).code]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('alteração aplicada pelo bot (T21, phase 10): vale na hora e o dono recusa pelo cartão', () => {
  it('pausar e mudar valem na hora, a recusa desfaz, uma rotina que o dono mudou depois devolve 409 e o cartão aparece como "mudou depois"', async () => {
    const botId = await createBot();
    const routine = json<RoutineBody>(await call('POST', '/api/routines', body(botId, { name: 'Alvo da API', instruction: 'Instrução original.' })));

    // O bot pausa: a rotina JÁ está pausada e o cartão aparece aplicado.
    expect((await call('POST', `/api/bots/${botId}/messages`, { content: '[rotina-pausar:Alvo da API]' })).statusCode).toBe(201);
    const pause = await conversationCard(botId, 'routine_change', (item) => item.card?.change?.action === 'pause');
    expect(pause.card).toMatchObject({ status: 'applied', routineId: routine.id, change: { action: 'pause' } });
    expect(json<RoutineBody>(await call('GET', `/api/routines/${routine.id}`))).toMatchObject({ status: 'paused', nextRunAt: null });

    // Recusar: 200 com a rotina como ficou (ativa de novo); de novo, o mesmo resultado; o cartão aparece recusado.
    const refused = await call('POST', `/api/routines/cards/${pause.id}/refuse`);
    expect(refused.statusCode).toBe(200);
    expect(json<{ routine: RoutineBody }>(refused).routine).toMatchObject({ id: routine.id, status: 'active' });
    expect(json(await call('POST', `/api/routines/cards/${pause.id}/refuse`))).toEqual(json(refused));
    expect(json<RoutineBody>(await call('GET', `/api/routines/${routine.id}`)).status).toBe('active');
    expect((await conversationCard(botId, 'routine_change', (item) => item.card?.change?.action === 'pause')).card?.status).toBe('refused');
    // Editar pelo cartão que o dono já recusou: 409 ROUTINE_CHANGED (código estável) com a mensagem única do A15, que diz que a rotina mudou OU que o cartão já foi resolvido
    // (recusado ou editado) e não pede nova proposta ao bot, já que no fluxo novo o bot já aplicou; nada é gravado.
    const editRefused = await call('PUT', `/api/routines/${routine.id}`, { ...body(botId, { name: 'Alvo da API', instruction: 'Não deve ser gravada.' }), cardId: pause.id });
    expect([editRefused.statusCode, errorOf(editRefused).code]).toEqual([409, 'ROUTINE_CHANGED']);
    expect(errorOf(editRefused).message).toMatch(/resolvido/);
    expect(errorOf(editRefused).message).toMatch(/mudou/);
    expect(errorOf(editRefused).message).not.toMatch(/propor de novo/);
    expect(json<RoutineBody & { instruction: string }>(await call('GET', `/api/routines/${routine.id}`))).toMatchObject({ instruction: 'Instrução original.', status: 'active' });
    // Confirmar não existe para o que já vale.
    expect(errorOf(await call('POST', `/api/routines/changes/${pause.id}/confirm`)).code).toBe('NOT_FOUND');

    // O bot muda a agenda; o dono edita a MESMA rotina por fora: o cartão do bot passa a "mudou depois" e recusar é 409, sem desfazer nada.
    expect((await call('POST', `/api/bots/${botId}/messages`, { content: '[rotina-mudar:Alvo da API|08:15]' })).statusCode).toBe(201);
    const update = await conversationCard(botId, 'routine_change', (item) => item.card?.change?.action === 'update');
    expect(update.card).toMatchObject({ status: 'applied', change: { action: 'update' } });
    expect(json<RoutineBody>(await call('GET', `/api/routines/${routine.id}`)).summary).toBe('Todos os dias às 08:15');
    const edited = await call('PUT', `/api/routines/${routine.id}`, body(botId, { name: 'Alvo da API', instruction: 'Instrução do dono.' }));
    expect(edited.statusCode).toBe(200);
    const stale = await call('POST', `/api/routines/cards/${update.id}/refuse`);
    expect([stale.statusCode, errorOf(stale).code]).toEqual([409, 'ROUTINE_CHANGED']);
    expect((await conversationCard(botId, 'routine_change', (item) => item.card?.change?.action === 'update')).card?.status).toBe('superseded');
    expect(json<RoutineBody & { instruction: string }>(await call('GET', `/api/routines/${routine.id}`))).toMatchObject({ instruction: 'Instrução do dono.' });
  });

  it('excluir vale na hora, a recusa traz a rotina de volta com o mesmo id e o instantâneo de restauração nunca chega ao navegador', async () => {
    const botId = await createBot();
    const routine = json<RoutineBody>(await call('POST', '/api/routines', body(botId, { name: 'Descartável da API' })));
    expect((await call('POST', `/api/bots/${botId}/messages`, { content: '[rotina-excluir:Descartável da API]' })).statusCode).toBe(201);
    const deletion = await conversationCard(botId, 'routine_change', (item) => item.card?.change?.action === 'delete');
    expect(deletion.card).toMatchObject({ status: 'applied', routineId: null });
    expect(errorOf(await call('GET', `/api/routines/${routine.id}`)).code).toBe('ROUTINE_NOT_FOUND');
    // O instantâneo está na linha do banco, mas o contrato do cartão não o declara: a resposta da API não o traz (nem a instrução da rotina excluída).
    const stored = (await api.pool.query<{ data: Record<string, unknown> }>('SELECT data FROM messages WHERE id = $1', [deletion.id])).rows[0]!.data;
    expect(stored).toHaveProperty('restore');
    expect(deletion.card).not.toHaveProperty('restore');
    const page = (await call('GET', `/api/bots/${botId}/conversation`)).body;
    expect(page).not.toContain('"restore"');
    expect(page).not.toContain('Resuma o dia'); // nem a instrução da rotina excluída (ela está no instantâneo)

    const refused = await call('POST', `/api/routines/cards/${deletion.id}/refuse`);
    expect(refused.statusCode).toBe(200);
    expect(json<{ routine: RoutineBody }>(refused).routine).toMatchObject({ id: routine.id, name: 'Descartável da API', status: 'active' });
    expect(json<RoutineBody>(await call('GET', `/api/routines/${routine.id}`)).id).toBe(routine.id);
    expect((await conversationCard(botId, 'routine_change', (item) => item.card?.change?.action === 'delete')).card).toMatchObject({ status: 'refused', routineId: routine.id });
  });

  it('a proposta de alteração ANTIGA pendente continua confirmável: aplica uma vez e uma proposta desatualizada vira 409', async () => {
    const botId = await createBot();
    const routine = json<RoutineBody>(await call('POST', '/api/routines', body(botId, { name: 'Antiga da API', instruction: 'Instrução original.' })));
    const pending = (change: Record<string, unknown>) => insertLegacyCard(botId, { type: 'routine_change', routineId: routine.id, routineName: 'Antiga da API', change, status: 'pending' });

    const pauseId = await pending({ action: 'pause' });
    expect(json<RoutineBody>(await call('GET', `/api/routines/${routine.id}`)).status).toBe('active'); // a proposta antiga só vale depois do Confirmar
    const confirmed = await call('POST', `/api/routines/changes/${pauseId}/confirm`);
    expect(confirmed.statusCode).toBe(200);
    expect(json<{ routine: RoutineBody }>(confirmed).routine).toMatchObject({ id: routine.id, status: 'paused', nextRunAt: null });
    expect(json(await call('POST', `/api/routines/changes/${pauseId}/confirm`))).toEqual(json(confirmed)); // idempotente

    // Proposta de alterar a instrução; o dono muda a MESMA instrução antes: 409 ROUTINE_CHANGED e nada é aplicado.
    const before = { name: 'Antiga da API', instruction: 'Instrução original.', schedule: routine.schedule, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null, summary: routine.summary };
    const updateId = await pending({ action: 'update', before, after: { ...before, instruction: 'Instrução do bot.' }, changed: ['instruction'], nextRuns: [] });
    expect((await call('PUT', `/api/routines/${routine.id}`, body(botId, { name: 'Antiga da API', instruction: 'Instrução do dono.' }))).statusCode).toBe(200);
    const stale = await call('POST', `/api/routines/changes/${updateId}/confirm`);
    expect([stale.statusCode, errorOf(stale).code]).toEqual([409, 'ROUTINE_CHANGED']);
    expect(json<RoutineBody & { instruction: string }>(await call('GET', `/api/routines/${routine.id}`))).toMatchObject({ instruction: 'Instrução do dono.', status: 'paused' });
    expect((await conversationCard(botId, 'routine_change', (item) => item.id === updateId)).card?.status).toBe('stale');
  });

  it('só um cartão de rotina é confirmável ou recusável: uma mensagem qualquer e um id inexistente dão 404, e o bot não alcança a rotina de outro bot', async () => {
    const botId = await createBot();
    const otherBot = await createBot();
    const foreign = json<RoutineBody>(await call('POST', '/api/routines', body(otherBot, { name: 'Rotina de outro bot' })));
    expect((await call('POST', `/api/bots/${botId}/messages`, { content: 'oi' })).statusCode).toBe(201);
    const text = await waitFor('a resposta do bot', async () => {
      const snapshot = json<{ items: { id: string; kind: string; role?: string }[] }>(await call('GET', `/api/bots/${botId}/conversation`));
      return snapshot.items.find((item) => item.kind === 'text' && item.role === 'assistant') ?? null;
    });
    for (const id of [text.id, '999999999']) {
      for (const url of [`/api/routines/changes/${id}/confirm`, `/api/routines/cards/${id}/refuse`]) {
        const refused = await call('POST', url);
        expect([url, refused.statusCode, errorOf(refused).code]).toEqual([url, 404, 'NOT_FOUND']);
      }
    }
    // O modelo falso procura a rotina de outro bot pelo nome: ela não está na lista do bot, então ele só responde texto e nenhum cartão nasce.
    expect((await call('POST', `/api/bots/${botId}/messages`, { content: '[rotina-excluir:Rotina de outro bot]' })).statusCode).toBe(201);
    await waitFor('a execução terminar', async () => {
      const found = await api.pool.query<{ total: string }>("SELECT count(*) AS total FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE c.bot_id = $1 AND r.status IN ('queued', 'running')", [botId]);
      return Number(found.rows[0]?.total) === 0;
    });
    const cards = await api.pool.query<{ total: string }>("SELECT count(*) AS total FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1 AND m.data->>'type' = 'routine_change'", [botId]);
    expect(Number(cards.rows[0]?.total)).toBe(0);
    expect(json<RoutineBody>(await call('GET', `/api/routines/${foreign.id}`)).status).toBe('active');
  });
});
