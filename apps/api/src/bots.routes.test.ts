// Prova de A4 (F5) e A7 (F6) pela borda HTTP: autenticação e CSRF em todas as rotas, jornada completa de criar, validar,
// nome duplicado, editar, arquivar e desarquivar, as bordas (id inexistente, campos extras, limites, auditoria) e a exclusão
// definitiva (corpo estrito, cada recusa com o envelope padrão, 204 sem corpo, auditoria sem nome e o limite de 5 por minuto).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BODY_LIMIT_BYTES } from './app';
import { CHROME_UA, ORIGIN, createTestApi, type TestApi } from './testing/harness';

let api: TestApi;
let session: { cookie: string; csrfToken: string };

const CLIENT_IP = '203.0.113.77';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  api = await createTestApi();
  session = await api.login(CLIENT_IP);
});

afterAll(async () => {
  await api.cleanup();
});

/** Chamada autenticada por padrão (cookie, Origin e token CSRF); `auth: false` remove só a sessão. */
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  api.app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: {
      origin: ORIGIN,
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      'user-agent': CHROME_UA,
      ...headers,
    },
    remoteAddress: CLIENT_IP,
  });

interface ErrorBody {
  code: string;
  message: string;
  fields?: { field: string; reason: string }[];
}

const bodyOf = <T = Record<string, unknown>>(response: { json: () => unknown }) => response.json() as T;
const countOf = async (table: string): Promise<number> =>
  (await api.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ?? -1;

describe('autenticação e CSRF', () => {
  it('toda rota de bots exige sessão, e as que alteram estado exigem Origin e token CSRF', async () => {
    const routes: [('GET' | 'POST' | 'PATCH' | 'DELETE'), string, unknown?][] = [
      ['GET', '/api/bots'],
      ['GET', `/api/bots/${UNKNOWN_ID}`],
      ['POST', '/api/bots', { name: 'Sem sessão', color: '#60A5FA' }],
      ['PATCH', `/api/bots/${UNKNOWN_ID}`, { name: 'Sem sessão' }],
      ['POST', `/api/bots/${UNKNOWN_ID}/archive`],
      ['POST', `/api/bots/${UNKNOWN_ID}/unarchive`],
      ['DELETE', `/api/bots/${UNKNOWN_ID}`, { confirmName: 'Sem sessão' }],
    ];
    for (const [method, url, payload] of routes) {
      // Sem cookie: negação por padrão (as mutações falham já na sessão, antes de qualquer outra checagem).
      const anonymous = await api.app.inject({
        method,
        url,
        payload: payload as object | undefined,
        headers: { origin: ORIGIN },
        remoteAddress: CLIENT_IP,
      });
      expect([method, url, anonymous.statusCode, bodyOf<ErrorBody>(anonymous).code]).toEqual([method, url, 401, 'AUTH_SESSION_EXPIRED']);
    }
    for (const [method, url, payload] of routes.filter(([method]) => method !== 'GET')) {
      const noCsrf = await call(method, url, payload, { 'x-csrf-token': '' });
      expect([url, noCsrf.statusCode, bodyOf<ErrorBody>(noCsrf).code]).toEqual([url, 403, 'CSRF_TOKEN_INVALID']);
      const wrongOrigin = await call(method, url, payload, { origin: 'https://evil.example' });
      expect([url, wrongOrigin.statusCode, bodyOf<ErrorBody>(wrongOrigin).code]).toEqual([url, 403, 'CSRF_ORIGIN_INVALID']);
    }
    expect(await countOf('bots')).toBe(0); // nenhuma tentativa barrada criou coisa alguma
  });
});

describe('jornada do dono: criar, validar, nome duplicado, editar, arquivar e desarquivar', () => {
  it('percorre o ciclo completo pela API, com erro em cada passo de validação e efeitos no banco e na auditoria', async () => {
    // Lista inicial vazia.
    const empty = await call('GET', '/api/bots');
    expect(empty.statusCode).toBe(200);
    expect(bodyOf(empty)).toEqual({ bots: [] });
    expect(empty.headers['cache-control']).toBe('no-store');

    // Criar só com o obrigatório: padrões do F5 (etapas 50, T30; sem modelo e sem effort), cor normalizada.
    const created = await call('POST', '/api/bots', { name: '  Financeiro ', color: '#60a5fa' });
    expect(created.statusCode).toBe(201);
    const bot = bodyOf<Record<string, unknown>>(created);
    expect(bot).toMatchObject({
      name: 'Financeiro',
      color: '#60A5FA',
      instructions: '',
      model: null,
      effort: null,
      stepLimit: 50,
      archivedAt: null,
    });
    // Contrato fechado: nada de campos internos (chave de comparação do nome, conversa, memória) e sem personagem (removido na phase 5).
    expect(Object.keys(bot).sort()).toEqual([
      'archivedAt', 'color', 'contextWindowTokens', 'createdAt', 'effort', 'id', 'instructions', 'model', 'name', 'stepLimit', 'updatedAt',
    ]);
    const id = bot.id as string;
    expect((await api.pool.query('SELECT 1 FROM conversations WHERE bot_id = $1', [id])).rowCount).toBe(1);
    expect((await api.pool.query("SELECT 1 FROM bot_memories WHERE bot_id = $1 AND content = ''", [id])).rowCount).toBe(1);

    // Validação: vários campos ruins de uma vez devolvem campo e motivo de cada um, e nada é criado.
    const invalid = await call('POST', '/api/bots', { name: '', color: 'azul', stepLimit: 0, instructions: 'x'.repeat(8001) });
    expect(invalid.statusCode).toBe(422);
    const invalidBody = bodyOf<ErrorBody>(invalid);
    expect(invalidBody).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Dados inválidos.' });
    expect(invalidBody.fields).toEqual(
      expect.arrayContaining([
        { field: 'name', reason: 'Valor curto demais.' },
        { field: 'color', reason: 'Formato inválido.' },
        { field: 'stepLimit', reason: 'Valor curto demais.' },
        { field: 'instructions', reason: 'Valor longo demais.' },
      ]),
    );
    expect(await countOf('bots')).toBe(1);

    // Nome duplicado sem diferenciar maiúsculas: 409 com o código da spec e sem criar nada.
    const duplicate = await call('POST', '/api/bots', { name: 'FINANCEIRO', color: '#F87171' });
    expect(duplicate.statusCode).toBe(409);
    expect(bodyOf(duplicate)).toEqual({ code: 'BOT_NAME_TAKEN', message: 'Já existe um bot ativo com esse nome.' });
    expect(await countOf('bots')).toBe(1);

    // Ler, editar (parcial) e listar.
    const other = bodyOf<{ id: string }>(await call('POST', '/api/bots', { name: 'Vendas', color: '#4ADE80', instructions: 'Acompanhe pedidos.', stepLimit: 50 }));
    expect(bodyOf(await call('GET', `/api/bots/${id}`))).toMatchObject({ id, name: 'Financeiro' });
    const edited = await call('PATCH', `/api/bots/${id}`, { color: '#f472b6', instructions: 'Controle o caixa.', stepLimit: 10 });
    expect(edited.statusCode).toBe(200);
    expect(bodyOf(edited)).toMatchObject({ id, name: 'Financeiro', color: '#F472B6', instructions: 'Controle o caixa.', stepLimit: 10 });
    const clash = await call('PATCH', `/api/bots/${other.id}`, { name: 'financeiro' });
    expect(clash.statusCode).toBe(409);
    expect(bodyOf<ErrorBody>(clash).code).toBe('BOT_NAME_TAKEN');
    expect(bodyOf(await call('GET', `/api/bots/${other.id}`))).toMatchObject({ name: 'Vendas' });

    // Arquivar libera o nome; o novo bot entra; desarquivar o antigo conflita até renomear.
    const archived = await call('POST', `/api/bots/${id}/archive`);
    expect(archived.statusCode).toBe(200);
    expect(bodyOf<{ archivedAt: string | null }>(archived).archivedAt).toEqual(expect.any(String));
    const replacement = await call('POST', '/api/bots', { name: 'financeiro', color: '#22D3EE' });
    expect(replacement.statusCode).toBe(201);
    const list = bodyOf<{ bots: { id: string; name: string; archivedAt: string | null; runState: string; preview: string }[] }>(await call('GET', '/api/bots'));
    // Nome igual em caixas diferentes: o arquivado (criado antes) vem primeiro, o ativo logo depois.
    expect(list.bots.map((item) => [item.name, item.archivedAt === null])).toEqual([
      ['Financeiro', false],
      ['financeiro', true],
      ['Vendas', true],
    ]);
    expect(Object.keys(list.bots[0] ?? {}).sort()).toEqual(['archivedAt', 'color', 'id', 'name', 'preview', 'runState', 'unread']); // lista sem instruções, com o estado ao vivo e a prévia
    expect(list.bots.map((item) => item.preview)).toEqual(Array(3).fill('Nenhuma mensagem ainda')); // sem conversa com novidade: a prévia vazia
    expect(list.bots.map((item) => item.runState)).toEqual(['sleep', 'idle', 'idle']); // o arquivado dorme; os ativos, sem execução, estão livres
    const blocked = await call('POST', `/api/bots/${id}/unarchive`);
    expect([blocked.statusCode, bodyOf<ErrorBody>(blocked).code]).toEqual([409, 'BOT_NAME_TAKEN']);
    expect(await call('PATCH', `/api/bots/${id}`, { name: 'Financeiro antigo' })).toMatchObject({ statusCode: 200 });
    const restored = await call('POST', `/api/bots/${id}/unarchive`);
    expect([restored.statusCode, bodyOf<{ archivedAt: unknown }>(restored).archivedAt]).toEqual([200, null]);

    // Auditoria: quem, o quê e de onde (IP e navegador), sem o conteúdo das instruções.
    const audit = await api.pool.query<{ action: string; actor: string; ip: string; user_agent: string; target: string; details: unknown }>(
      "SELECT action, actor, ip, user_agent, target, details FROM audit_log WHERE action LIKE 'bot.%' AND target = $1 ORDER BY id",
      [id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['bot.create', 'bot.update', 'bot.archive', 'bot.update', 'bot.unarchive']);
    for (const row of audit.rows) expect(row).toMatchObject({ actor: 'owner', ip: CLIENT_IP, user_agent: CHROME_UA });
    expect(JSON.stringify(audit.rows)).not.toContain('Controle o caixa');
  });
});

describe('bordas', () => {
  it('id inexistente é BOT_NOT_FOUND (404) e id malformado é VALIDATION_FAILED (422), sem tocar em nada', async () => {
    const before = await countOf('audit_log');
    for (const [method, suffix, payload] of [
      ['GET', '', undefined],
      ['PATCH', '', { name: 'Fantasma' }],
      ['POST', '/archive', undefined],
      ['POST', '/unarchive', undefined],
    ] as const) {
      const missing = await call(method, `/api/bots/${UNKNOWN_ID}${suffix}`, payload);
      expect([method, suffix, missing.statusCode, bodyOf(missing)]).toEqual([
        method,
        suffix,
        404,
        { code: 'BOT_NOT_FOUND', message: 'Bot não encontrado.' },
      ]);
      for (const malformed of ['abc', '1%20OR%201=1', '12345']) {
        const refused = await call(method, `/api/bots/${malformed}${suffix}`, payload);
        expect([method, malformed, refused.statusCode, bodyOf<ErrorBody>(refused).code]).toEqual([method, malformed, 422, 'VALIDATION_FAILED']);
        expect(bodyOf<ErrorBody>(refused).fields).toEqual([{ field: 'id', reason: 'Formato inválido.' }]);
      }
    }
    expect(await countOf('audit_log')).toBe(before);
  });

  it('sem personagem (phase 5): criar e editar funcionam sem `mascot`, e `mascot` na criação ou na edição é recusado como campo desconhecido', async () => {
    const created = await call('POST', '/api/bots', { name: 'Sem personagem', color: '#2DD4BF' });
    expect(created.statusCode).toBe(201);
    const id = bodyOf<{ id: string }>(created).id;
    expect(Object.keys(bodyOf<Record<string, unknown>>(created))).not.toContain('mascot');

    const edited = await call('PATCH', `/api/bots/${id}`, { name: 'Sem personagem editado' });
    expect([edited.statusCode, Object.keys(bodyOf<Record<string, unknown>>(edited))]).toEqual([200, expect.not.arrayContaining(['mascot'])]);
    const listed = bodyOf<{ bots: Record<string, unknown>[] }>(await call('GET', '/api/bots'));
    expect(Object.keys(listed.bots.find((item) => item.id === id) ?? {})).not.toContain('mascot');

    // Qualquer valor, válido no contrato antigo ou não: o campo em si não existe mais, então a resposta é a de campo desconhecido, sem ecoar o nome dele.
    const before = await countOf('bots');
    for (const value of ['circle', 'hexagon', 'estrela', '', 7, null]) {
      const onCreate = await call('POST', '/api/bots', { name: 'Com personagem', color: '#2DD4BF', mascot: value });
      expect([String(value), onCreate.statusCode, bodyOf<ErrorBody>(onCreate).code, bodyOf<ErrorBody>(onCreate).fields]).toEqual([String(value), 422, 'VALIDATION_FAILED', [{ field: 'corpo', reason: 'Campo não permitido.' }]]);
      const onEdit = await call('PATCH', `/api/bots/${id}`, { mascot: value });
      expect([String(value), onEdit.statusCode, bodyOf<ErrorBody>(onEdit).code, bodyOf<ErrorBody>(onEdit).fields]).toEqual([String(value), 422, 'VALIDATION_FAILED', [{ field: 'corpo', reason: 'Campo não permitido.' }]]);
    }
    expect(await countOf('bots')).toBe(before);
    expect(bodyOf<{ name: string }>(await call('GET', `/api/bots/${id}`)).name).toBe('Sem personagem editado');
  });

  it('estado ao vivo (F10): só a lista traz o runState, calculado a cada leitura a partir das execuções, e as demais respostas de bot não o trazem', async () => {
    const created = await call('POST', '/api/bots', { name: 'Ao vivo', color: '#4ADE80' });
    const id = bodyOf<{ id: string }>(created).id;
    const stateOf = async (): Promise<string | undefined> =>
      bodyOf<{ bots: { id: string; runState: string }[] }>(await call('GET', '/api/bots')).bots.find((item) => item.id === id)?.runState;
    const seed = (status: string, finishedAt: string | null) =>
      api.pool.query(
        `INSERT INTO runs (conversation_id, bot_id, status, input, created_at, finished_at)
         SELECT c.id, c.bot_id, $2, 'semente', now(), $3 FROM conversations c WHERE c.bot_id = $1`,
        [id, status, finishedAt],
      );

    expect(await stateOf()).toBe('idle');
    await seed('running', null);
    expect(await stateOf()).toBe('working');
    await api.pool.query("UPDATE runs SET status = 'waiting_approval' WHERE bot_id = $1", [id]);
    expect(await stateOf()).toBe('waiting');
    await api.pool.query("UPDATE runs SET status = 'failed', finished_at = now() WHERE bot_id = $1", [id]);
    expect(await stateOf()).toBe('error');
    await api.pool.query("UPDATE runs SET status = 'completed' WHERE bot_id = $1", [id]);
    expect(await stateOf()).toBe('done'); // terminou agora: a janela de 60 s está aberta
    await api.pool.query("UPDATE runs SET finished_at = now() - interval '61 seconds' WHERE bot_id = $1", [id]);
    expect(await stateOf()).toBe('idle');

    // As respostas de bot (leitura, criação, edição e arquivamento) são o bot completo: sem o estado, que só existe na lista.
    expect(Object.keys(bodyOf(created))).not.toContain('runState');
    for (const response of [await call('GET', `/api/bots/${id}`), await call('PATCH', `/api/bots/${id}`, { instructions: 'x' }), await call('POST', `/api/bots/${id}/archive`)]) {
      expect(response.statusCode).toBe(200);
      expect(Object.keys(bodyOf(response))).not.toContain('runState');
    }
    expect(await stateOf()).toBe('sleep');
  });

  it('campos extras e internos são recusados na criação e na edição (mass assignment) sem alterar o bot', async () => {
    const target = bodyOf<{ id: string; createdAt: string }>(await call('POST', '/api/bots', { name: 'Blindado', color: '#A78BFA' }));
    const extras: Record<string, unknown>[] = [
      { id: UNKNOWN_ID },
      { archivedAt: '2026-01-01T00:00:00.000Z' },
      { createdAt: '2020-01-01T00:00:00.000Z' },
      { nameKey: 'outro' },
      { name_key: 'outro' },
      { conversationId: UNKNOWN_ID },
      { memory: 'invadida' },
    ];
    for (const extra of extras) {
      const onCreate = await call('POST', '/api/bots', { name: `Extra ${Object.keys(extra)[0]}`, color: '#A78BFA', ...extra });
      expect([Object.keys(extra)[0], onCreate.statusCode, bodyOf<ErrorBody>(onCreate).code]).toEqual([Object.keys(extra)[0], 422, 'VALIDATION_FAILED']);
      const onEdit = await call('PATCH', `/api/bots/${target.id}`, { name: 'Blindado', ...extra });
      expect([Object.keys(extra)[0], onEdit.statusCode]).toEqual([Object.keys(extra)[0], 422]);
      // A resposta não ecoa o nome do campo enviado: só o motivo genérico.
      expect(bodyOf<ErrorBody>(onEdit).fields).toEqual([{ field: 'corpo', reason: 'Campo não permitido.' }]);
    }
    const after = bodyOf<Record<string, unknown>>(await call('GET', `/api/bots/${target.id}`));
    expect(after).toMatchObject({ name: 'Blindado', archivedAt: null, createdAt: target.createdAt });
    expect((await api.pool.query("SELECT 1 FROM bots WHERE name LIKE 'Extra %'")).rowCount).toBe(0);
  });

  it('limites da spec F5 nas bordas: aceita no limite e recusa acima, com o campo certo', async () => {
    const create = (suffix: string, overrides: Record<string, unknown>) =>
      call('POST', '/api/bots', { name: `Limite ${suffix}`, color: '#2DD4BF', ...overrides });
    // Campos citados, sem repetição (um valor pode quebrar duas regras do mesmo campo, ex.: modelo vazio).
    const fieldOf = (response: { json: () => unknown }) => [...new Set(bodyOf<ErrorBody>(response).fields?.map((item) => item.field))];
    const before = await countOf('bots');

    // Aceitos (nome de 60 caracteres contados por pontos de código: 60 emojis; instruções de 8.000).
    const accepted: [string, Record<string, unknown>][] = [
      ['nome60', { name: 'n'.repeat(60) }],
      ['emoji60', { name: '🤖'.repeat(60) }],
      ['acento', { name: 'Ação e coração' }],
      ['instr8000', { instructions: 'i'.repeat(8000) }],
      ['instrEmoji', { instructions: '🤖'.repeat(8000) }],
      ['etapas1', { stepLimit: 1 }],
      ['etapas100', { stepLimit: 100 }],
      ['cor', { color: '#abcdef' }],
    ];
    for (const [label, overrides] of accepted) {
      const response = await create(label, overrides);
      expect([label, response.statusCode]).toEqual([label, 201]);
    }
    expect(bodyOf<{ color: string }>(await create('caixaAlta', { color: '#aBcDeF' })).color).toBe('#ABCDEF');

    // Recusados: status 422 e o campo certo. NUL no texto precisa virar 422, e nunca erro 500 do banco.
    const refused: [string, Record<string, unknown>, string][] = [
      ['nome61', { name: 'n'.repeat(61) }, 'name'],
      ['emoji61', { name: '🤖'.repeat(61) }, 'name'],
      ['nomeVazio', { name: '   ' }, 'name'],
      ['nomeNulo', { name: 'a\u0000b' }, 'name'],
      ['nomeQuebra', { name: 'a\nb' }, 'name'],
      ['nomeNumero', { name: 42 }, 'name'],
      ['instr8001', { instructions: 'i'.repeat(8001) }, 'instructions'],
      ['instrNulo', { instructions: 'a\u0000b' }, 'instructions'],
      ['etapas0', { stepLimit: 0 }, 'stepLimit'],
      ['etapas101', { stepLimit: 101 }, 'stepLimit'],
      ['etapasFracao', { stepLimit: 2.5 }, 'stepLimit'],
      ['etapasTexto', { stepLimit: '25' }, 'stepLimit'],
      ['etapasNulo', { stepLimit: null }, 'stepLimit'],
      ['corSemHash', { color: '60A5FA' }, 'color'],
      ['corCurta', { color: '#60A5F' }, 'color'],
      ['corNome', { color: 'azul' }, 'color'],
      ['modeloVazio', { model: '' }, 'model'],
      ['modeloQuebra', { model: 'a\nb' }, 'model'],
      ['modeloNumero', { model: 7 }, 'model'],
      ['effortSemModelo', { effort: 'high' }, 'effort'],
      ['effortDesconhecido', { effort: 'altissimo' }, 'effort'],
    ];
    for (const [label, overrides, field] of refused) {
      const response = await create(label, overrides);
      expect([label, response.statusCode, fieldOf(response)]).toEqual([label, 422, [field]]);
    }
    // Um modelo bem formado depende da lista do provedor (T5): sem provedor configurado a criação é recusada (409).
    const noProvider = await create('modeloSemProvedor', { model: 'qualquer' });
    expect([noProvider.statusCode, bodyOf<ErrorBody>(noProvider).code]).toEqual([409, 'PROVIDER_NOT_CONFIGURED']);
    // Nada do que foi recusado entrou no banco: só os aceitos (e o da cor em caixa mista) foram criados.
    expect((await countOf('bots')) - before).toBe(accepted.length + 1);
  });

  it('corpo acima do limite de 256 KB é recusado com o envelope padrão', async () => {
    const response = await call('POST', '/api/bots', { name: 'Gigante', color: '#60A5FA', instructions: 'x'.repeat(BODY_LIMIT_BYTES) });
    expect([response.statusCode, bodyOf<ErrorBody>(response).code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
  });

  it('edição vazia é aceita sem efeito, e a edição não troca modelo nem effort por valores soltos', async () => {
    const target = bodyOf<{ id: string; updatedAt: string }>(await call('POST', '/api/bots', { name: 'Estável', color: '#FB923C' }));
    const noop = await call('PATCH', `/api/bots/${target.id}`, {});
    expect([noop.statusCode, bodyOf<{ updatedAt: string }>(noop).updatedAt]).toEqual([200, target.updatedAt]);
    const noBody = await call('PATCH', `/api/bots/${target.id}`);
    expect(noBody.statusCode).toBe(422);
    const model = await call('PATCH', `/api/bots/${target.id}`, { model: 7 });
    expect([model.statusCode, bodyOf<ErrorBody>(model).fields?.[0]?.field]).toEqual([422, 'model']);
    const noProvider = await call('PATCH', `/api/bots/${target.id}`, { model: 'x' }); // bem formado, mas sem provedor para conferir
    expect([noProvider.statusCode, bodyOf<ErrorBody>(noProvider).code]).toEqual([409, 'PROVIDER_NOT_CONFIGURED']);
    expect(bodyOf(await call('PATCH', `/api/bots/${target.id}`, { model: null, effort: null }))).toMatchObject({ model: null, effort: null });
  });
});

// Exclusão definitiva (F6, A7, DATA-01) pela borda HTTP. Que o serviço apaga TUDO do bot, na ordem certa e com atomicidade, é provado no
// core (`bots.test.ts`, contra o catálogo do banco); aqui se prova o que é da borda: verbo e corpo estrito, sessão e CSRF, o envelope
// de cada recusa, o 204 sem corpo, a auditoria vista de fora e o limite de 5 por minuto da instância da API.
describe('exclusão definitiva (DELETE /api/bots/:id)', () => {
  // O limitador do serviço lê `new Date()`: com só o `Date` simulado, cada teste abre uma janela nova de um minuto sem esperar (como no TOTP).
  const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  afterEach(() => advance(61_000));

  const NAME = 'Ação Financeira';

  /** Cria um bot pela API e o arquiva (a única forma excluível); devolve o id. */
  const archivedBot = async (name: string): Promise<string> => {
    const created = await call('POST', '/api/bots', { name, color: '#60A5FA' });
    const id = bodyOf<{ id: string }>(created).id;
    await call('POST', `/api/bots/${id}/archive`);
    return id;
  };

  /** Linhas que a exclusão tem de apagar, nas tabelas que a rota enxerga de fora: bot, conversa, memória, mensagens, execuções e rotinas. */
  const rowsOf = async (id: string) => {
    const one = async (sql: string) => (await api.pool.query<{ n: number }>(sql, [id])).rows[0]?.n ?? -1;
    return {
      bots: await one('SELECT count(*)::int AS n FROM bots WHERE id = $1'),
      conversations: await one('SELECT count(*)::int AS n FROM conversations WHERE bot_id = $1'),
      memories: await one('SELECT count(*)::int AS n FROM bot_memories WHERE bot_id = $1'),
      messages: await one('SELECT count(*)::int AS n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE bot_id = $1)'),
      runs: await one('SELECT count(*)::int AS n FROM runs WHERE bot_id = $1'),
      routines: await one('SELECT count(*)::int AS n FROM routines WHERE bot_id = $1'),
    };
  };

  /** Uma execução do bot no estado dado, com a mensagem que a abriu (a referência execução -> mensagem existe de verdade). */
  const seedRun = async (id: string, status: string): Promise<void> => {
    const message = await api.pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, data, created_at)
       SELECT c.id, 'user', 'text', 'done', true, 'pergunta', '{}', now() FROM conversations c WHERE c.bot_id = $1 RETURNING id::text AS id`,
      [id],
    );
    await api.pool.query(
      `INSERT INTO runs (conversation_id, bot_id, status, input, trigger_message_id, created_at)
       SELECT c.id, c.bot_id, $2, 'pergunta', $3, now() FROM conversations c WHERE c.bot_id = $1`,
      [id, status, message.rows[0]!.id],
    );
    await api.pool.query(
      `INSERT INTO routines (bot_id, name, instruction, schedule, timezone, anchor_at, status, created_at, updated_at)
       VALUES ($1, 'Rotina', 'instrução', '{"type":"daily","times":["07:00"]}', 'America/Sao_Paulo', now(), 'paused', now(), now())`,
      [id],
    );
  };

  it('204 sem corpo: apaga o bot e seus dados, aceita o nome na forma digitada (trim e NFD) e a auditoria fica sem nome', async () => {
    const id = await archivedBot(NAME);
    await seedRun(id, 'completed');
    expect(await rowsOf(id)).toEqual({ bots: 1, conversations: 1, memories: 1, messages: 1, runs: 1, routines: 1 });

    // O dono digita com espaços nas pontas e o acento decomposto (NFD): o servidor aplica o mesmo trim e NFC do nome gravado.
    const typed = `  ${NAME.normalize('NFD')} `;
    expect(typed).not.toBe(NAME);
    const deleted = await call('DELETE', `/api/bots/${id}`, { confirmName: typed });
    expect([deleted.statusCode, deleted.body]).toEqual([204, '']);
    expect(await rowsOf(id)).toEqual({ bots: 0, conversations: 0, memories: 0, messages: 0, runs: 0, routines: 0 });
    expect((await call('GET', `/api/bots/${id}`)).statusCode).toBe(404);
    expect((await call('GET', '/api/bots')).json<{ bots: { id: string }[] }>().bots.map((bot) => bot.id)).not.toContain(id);

    // Auditoria: quem, o quê, quando e de onde, só com id e contagens; o registro de criação perdeu o nome; nada do bot na trilha.
    const audit = await api.pool.query<{ action: string; actor: string; ip: string; user_agent: string; details: Record<string, unknown> }>(
      'SELECT action, actor, ip, user_agent, details FROM audit_log WHERE target = $1 ORDER BY id',
      [id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['bot.create', 'bot.archive', 'bot.delete']);
    expect(audit.rows[0]?.details).toEqual({});
    expect(audit.rows[2]).toMatchObject({ actor: 'owner', ip: CLIENT_IP, user_agent: CHROME_UA });
    expect(audit.rows[2]?.details).toMatchObject({ messages: 1, runs: 1, routines: 1 });
    expect(Object.values(audit.rows[2]?.details ?? {}).every((value) => typeof value === 'number')).toBe(true);
    expect(JSON.stringify(audit.rows)).not.toContain('Financeira');
  });

  it('cada recusa tem o código e a mensagem do registro, e nenhuma apaga nada; excluir de novo é BOT_NOT_FOUND', async () => {
    const id = await archivedBot('Recusas na borda');
    await seedRun(id, 'queued');
    const intact = await rowsOf(id);
    const refuse = async (target: string, confirmName: string, expected: [number, string, string]) => {
      const response = await call('DELETE', `/api/bots/${target}`, { confirmName });
      expect([response.statusCode, bodyOf<ErrorBody>(response).code, bodyOf<ErrorBody>(response).message]).toEqual(expected);
      return response;
    };

    await refuse(UNKNOWN_ID, 'Recusas na borda', [404, 'BOT_NOT_FOUND', 'Bot não encontrado.']);
    await refuse(id, 'Recusas na borda', [409, 'BOT_HAS_OPEN_RUN', 'O bot tem execuções em andamento ou na fila. Aguarde terminarem ou pare-as e tente de novo.']);
    await api.pool.query("UPDATE runs SET status = 'completed' WHERE bot_id = $1", [id]);
    const mismatch = await refuse(id, 'recusas na borda', [422, 'VALIDATION_FAILED', 'Dados inválidos.']);
    expect(bodyOf<ErrorBody>(mismatch).fields).toEqual([{ field: 'confirmName', reason: 'O nome digitado não confere.' }]);
    expect(await rowsOf(id)).toEqual(intact);

    const active = bodyOf<{ id: string }>(await call('POST', '/api/bots', { name: 'Ainda ativo na borda', color: '#F87171' })).id;
    await refuse(active, 'Ainda ativo na borda', [409, 'BOT_NOT_ARCHIVED', 'Arquive o bot antes de excluir.']);
    expect((await rowsOf(active)).bots).toBe(1);

    expect((await call('DELETE', `/api/bots/${id}`, { confirmName: 'Recusas na borda' })).statusCode).toBe(204);
    advance(61_000); // as cinco tentativas anteriores esgotaram a janela do limite; a repetição precisa chegar ao serviço
    await refuse(id, 'Recusas na borda', [404, 'BOT_NOT_FOUND', 'Bot não encontrado.']); // repetida
  });

  it('o corpo é estrito (um único campo, 1 a 80 caracteres, texto sem controle) e o id é um UUID: tudo fora disso é 422 sem tocar no bot', async () => {
    const id = await archivedBot('Corpo estrito');
    const before = await rowsOf(id);
    const auditBefore = await countOf('audit_log');
    const fieldsOf = (response: { json: () => unknown }) => [...new Set(bodyOf<ErrorBody>(response).fields?.map((item) => item.field))];

    const refused: [string, unknown, string][] = [
      ['sem corpo', undefined, 'corpo'],
      ['objeto vazio', {}, 'confirmName'],
      ['campo extra', { confirmName: 'Corpo estrito', extra: 1 }, 'corpo'],
      ['campo interno', { confirmName: 'Corpo estrito', id: UNKNOWN_ID }, 'corpo'],
      ['nome vazio', { confirmName: '' }, 'confirmName'],
      ['só espaços', { confirmName: '    ' }, 'confirmName'],
      ['81 caracteres', { confirmName: 'n'.repeat(81) }, 'confirmName'],
      ['número', { confirmName: 42 }, 'confirmName'],
      ['nulo', { confirmName: null }, 'confirmName'],
      ['lista', { confirmName: ['Corpo estrito'] }, 'confirmName'],
      ['quebra de linha', { confirmName: 'Corpo\nestrito' }, 'confirmName'],
      ['caractere nulo', { confirmName: 'Corpo\u0000estrito' }, 'confirmName'],
      ['corpo em lista', ['Corpo estrito'], 'corpo'],
    ];
    for (const [label, payload, field] of refused) {
      const response = await call('DELETE', `/api/bots/${id}`, payload);
      expect([label, response.statusCode, bodyOf<ErrorBody>(response).code, fieldsOf(response)]).toEqual([label, 422, 'VALIDATION_FAILED', [field]]);
    }
    // 80 caracteres passam pela validação (o nome não confere, então o 422 é o do nome) e o id malformado nunca chega ao serviço.
    const atLimit = await call('DELETE', `/api/bots/${id}`, { confirmName: 'n'.repeat(80) });
    expect(bodyOf<ErrorBody>(atLimit).fields).toEqual([{ field: 'confirmName', reason: 'O nome digitado não confere.' }]);
    for (const malformed of ['abc', '1%20OR%201=1', '12345']) {
      const response = await call('DELETE', `/api/bots/${malformed}`, { confirmName: 'Corpo estrito' });
      expect([malformed, response.statusCode, bodyOf<ErrorBody>(response).fields]).toEqual([malformed, 422, [{ field: 'id', reason: 'Formato inválido.' }]]);
    }
    expect(await rowsOf(id)).toEqual(before);
    expect(await countOf('audit_log')).toBe(auditBefore);
  });

  it('5 exclusões por minuto: a sexta é 429 com Retry-After e não apaga nada; passada a janela volta a funcionar', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) ids.push(await archivedBot(`Limite ${index}`));
    for (const [index, id] of ids.slice(0, 5).entries()) {
      expect((await call('DELETE', `/api/bots/${id}`, { confirmName: `Limite ${index}` })).statusCode, `exclusão ${index + 1}`).toBe(204);
    }

    const limited = await call('DELETE', `/api/bots/${ids[5]}`, { confirmName: 'Limite 5' });
    expect([limited.statusCode, bodyOf<ErrorBody>(limited).code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await rowsOf(ids[5]!)).bots).toBe(1);
    // O limite é só da exclusão: o resto da API segue respondendo.
    expect((await call('GET', '/api/bots')).statusCode).toBe(200);

    advance(61_000);
    expect((await call('DELETE', `/api/bots/${ids[5]}`, { confirmName: 'Limite 5' })).statusCode).toBe(204);
    expect((await rowsOf(ids[5]!)).bots).toBe(0);
  });
});
// Phase 8: borda real do convite/desfazer, sem chamada ao modelo.
describe('objetivo do bot pela API', () => {
  it('protege convite/desfazer, sincroniza apresentação e replay conserva revisão', async () => {
    const created = bodyOf<{ id: string }>(await call('POST', '/api/bots', { name: 'Objetivo da borda', color: '#60A5FA' }));
    const invitation = `/api/bots/${created.id}/objective/invitation`;
    expect((await call('POST', invitation, {}, { 'x-csrf-token': '' })).statusCode).toBe(403);
    expect((await call('POST', invitation, {}, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await call('POST', invitation, { text: 'Não é mensagem' })).statusCode).toBe(422);
    const presented = await Promise.all([call('POST', invitation, {}), call('POST', invitation, {})]);
    expect(presented.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(presented.filter((response) => bodyOf<{ presentedNow: boolean }>(response).presentedNow)).toHaveLength(1);
    const conversationId = (await api.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id=$1', [created.id])).rows[0]!.id;
    expect((await api.pool.query('SELECT 1 FROM messages WHERE conversation_id=$1', [conversationId])).rowCount).toBe(0);
    await api.pool.query("UPDATE bot_objectives SET content='Direção de fixture',version=1,updated_at=now() WHERE bot_id=$1", [created.id]);
    await api.pool.query("INSERT INTO objective_versions(bot_id,version,content,source_message_ids,author,created_at) VALUES($1,1,'Direção de fixture','{}','bot',now())", [created.id]);
    const cardId = (await api.pool.query<{ id: string }>(`INSERT INTO messages(conversation_id,role,kind,status,data,created_at)
      VALUES($1,'system','card','done','{"type":"objective_updated","content":"Direção de fixture","version":1,"previousVersion":0,"status":"applied"}',now()) RETURNING id::text`, [conversationId])).rows[0]!.id;
    const undo = `/api/bots/${created.id}/objective/cards/${cardId}/undo`;
    expect((await call('POST', undo, { expectedVersion: '1' })).statusCode).toBe(422);
    expect((await call('POST', undo, { expectedVersion: 1, content: 'Texto arbitrário' })).statusCode).toBe(422);
    expect((await call('POST', undo, { expectedVersion: 0 })).statusCode).toBe(409);
    expect(bodyOf(await call('POST', undo, { expectedVersion: 1 }))).toMatchObject({ content: '', version: 2 });
    expect(bodyOf(await call('POST', undo, { expectedVersion: 1 }))).toMatchObject({ content: '', version: 2 });
    expect((await api.pool.query('SELECT version FROM objective_versions WHERE bot_id=$1 ORDER BY version', [created.id])).rows).toEqual([{ version: 1 }, { version: 2 }]);
    expect((await call('POST', `/api/bots/${created.id}/objective/cards/999999999999999999/undo`, { expectedVersion: 2 })).statusCode).toBe(404);
  });
});
