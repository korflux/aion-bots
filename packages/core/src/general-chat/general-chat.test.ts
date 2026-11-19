// Prova do chat geral temporário (F16, A15; T12) contra PostgreSQL real, o motor de execução real, o provedor falso e o Composio falso:
// a sessão é uma conversa sem bot que usa o MESMO motor da conversa do bot, com as três diferenças da spec (só a memória global no
// contexto e nenhuma ferramenta de bot, busca restrita à sessão, aprovação só pelo global e sem resposta permanente); o título nasce da
// primeira mensagem; salvar liga e desliga o vencimento; as filas são independentes entre sessões e bots; e as execuções da sessão
// aparecem em Atividades, onde a parada vale só para a execução certa. A retenção de 7 dias e o push "Chat geral" têm provas próprias
// (`retention.test.ts` e `push/push.test.ts`).
import { CHAT_SESSIONS_LIST_LIMIT, CHAT_SESSION_RETENTION_MS, CHAT_SESSION_TITLE_MAX, LANGUAGES, type ChatSession } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityService } from '../activities/service';
import { DomainError } from '../errors';
import { FORMATTING_RULES, GENERAL_CHAT_RULES, NEW_CHAT_MARKER } from '../runs/context';
import { ORIGIN, createRunsWorld, waitFor, type RunsWorld } from '../runs/test-support';
import { PushService } from '../push/service';
import { GeneralChatService } from './service';
import { titleFromMessage } from './title';
import { tableMarker } from '../testing/fake-upstreams';
import { seedLegacyChatApproval } from '../testing/legacy-chat-approval';

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `INESPERADO:${String(error)}`;
  }
};

describe('Novo chat: o rascunho vazio (T16)', () => {
  it('abrir o chat várias vezes devolve o MESMO rascunho vazio, que fica fora da lista e não acumula sessões; só depois da primeira mensagem nasce outro', async () => {
    const world = await createRunsWorld();
    try {
      let clock = new Date('2026-10-01T12:00:00Z');
      const chat = new GeneralChatService({ pool: world.pool, now: () => clock });
      const total = async () => Number((await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM conversations WHERE bot_id IS NULL')).rows[0]?.total);

      const first = await chat.openDraft();
      expect(first).toMatchObject({ title: null, saved: false });
      expect(await total()).toBe(1);

      // Quem chama de novo (outra aba, o clique em "Novo chat", o efeito repetido do React) cai na mesma sessão; nada novo é gravado.
      clock = new Date(clock.getTime() + 60_000);
      const again = await chat.openDraft();
      expect(again.id).toBe(first.id);
      expect(await total()).toBe(1);
      // O rascunho não é uma sessão para o dono: não aparece na lista (mas abre por id, para a conversa carregar).
      expect((await chat.list()).items).toEqual([]);
      expect((await chat.get(first.id)).id).toBe(first.id);
      // Reaproveitar renova a data: um rascunho esquecido não vence logo depois de o dono voltar a escrever nele.
      expect(again.createdAt).toBe(clock.toISOString());

      // Aberturas simultâneas terminam na mesma sessão (a trava serializa o "procura, senão cria").
      const parallel = await Promise.all([chat.openDraft(), chat.openDraft(), chat.openDraft(), chat.openDraft()]);
      expect(new Set(parallel.map((session) => session.id))).toEqual(new Set([first.id]));
      expect(await total()).toBe(1);

      // Uma execução na fila já basta para a sessão deixar de ser rascunho (a mensagem só entra na linha do tempo quando o worker a inicia).
      await world.pool.query("INSERT INTO runs (conversation_id, status, input, created_at) VALUES ($1, 'queued', 'oi', now())", [first.id]);
      const next = await chat.openDraft();
      expect(next.id).not.toBe(first.id);
      expect((await chat.list()).items.map((item) => item.id)).toEqual([first.id]);
      expect(await total()).toBe(2);

      // Uma sessão vazia SALVA é uma escolha do dono: aparece na lista e deixa de ser reaproveitada.
      await chat.setSaved(next.id, true);
      expect((await chat.list()).items.map((item) => item.id).sort()).toEqual([first.id, next.id].sort());
      const third = await chat.openDraft();
      expect(third.id).not.toBe(next.id);
    } finally {
      await world.cleanup();
    }
  });
});

describe('vista "Salvos" da lista (phase 5, T10)', () => {
  it('lista só as salvas e o filtro vale ANTES do teto da lista: uma salva antiga aparece mesmo fora das mais recentes', async () => {
    const world = await createRunsWorld();
    try {
      let clock = new Date('2026-01-01T12:00:00Z');
      const chat = new GeneralChatService({ pool: world.pool, now: () => clock });

      // Uma sessão salva antiga (sem mensagens: o salvar a tira do rascunho) e uma não salva com mensagem, só para provar que o filtro separa as duas.
      const oldSaved = await chat.create();
      await chat.setSaved(oldSaved.id, true);
      const temporary = await chat.create();
      await world.pool.query("INSERT INTO messages (conversation_id, role, kind, status, content, created_at) VALUES ($1, 'user', 'text', 'done', 'temporária', $2)", [temporary.id, clock]);
      expect((await chat.list()).items.map((item) => item.id).sort()).toEqual([oldSaved.id, temporary.id].sort());
      expect((await chat.list({ saved: true })).items.map((item) => item.id)).toEqual([oldSaved.id]);
      expect((await chat.list({ saved: false })).items).toHaveLength(2); // sem o filtro, a lista segue igual

      // O teto: sessões não salvas (tantas quanto o limite da lista) mais recentes empurram a salva antiga para fora da lista completa, mas NÃO da vista Salvos.
      clock = new Date('2026-02-01T12:00:00Z');
      await world.pool.query(
        `WITH created AS (INSERT INTO conversations (created_at) SELECT $2::timestamptz + g * interval '1 second' FROM generate_series(1, $1::int) g RETURNING id)
         INSERT INTO messages (conversation_id, role, kind, status, content, created_at) SELECT id, 'user', 'text', 'done', 'recente', $2::timestamptz + interval '1 hour' FROM created`,
        [CHAT_SESSIONS_LIST_LIMIT, clock],
      );
      const all = (await chat.list()).items;
      expect(all).toHaveLength(CHAT_SESSIONS_LIST_LIMIT);
      expect(all.map((item) => item.id)).not.toContain(oldSaved.id);
      const saved = (await chat.list({ saved: true })).items;
      expect(saved.map((item) => item.id)).toEqual([oldSaved.id]);
      expect(saved[0]).toMatchObject({ saved: true, expiresAt: null });

      // Desligar o salvar tira a sessão da vista (e ela volta a contar 7 dias, como sempre).
      await chat.setSaved(oldSaved.id, false);
      expect((await chat.list({ saved: true })).items).toEqual([]);
    } finally {
      await world.cleanup();
    }
  });
});

describe('modelo padrão do Chat geral (T23)', () => {
  it('é obrigatório: sem ele a sessão não tem modelo (nem o primeiro favorito vale); definido, vale para toda sessão sem preferência, e a preferência da conversa o supera', async () => {
    const world = await createRunsWorld();
    try {
      const chat = new GeneralChatService({ pool: world.pool });
      const choiceOf = async (session: ChatSession) => (await world.conversations.snapshot({ sessionId: session.id })).model;

      // Com um favorito e sem padrão do chat: o bot usaria o favorito, a sessão não (o chat só conversa com o padrão que o dono escolheu).
      await world.models.setFavorite('opencode/glm-5.1', true);
      const bot = await world.createBot({ model: null });
      expect((await world.conversations.snapshot(bot.id)).model).toEqual({ model: 'opencode/glm-5.1', effort: null, effortLevels: [] });
      const before = await chat.create();
      expect(await world.conversations.sessionDefault()).toEqual({ model: null, effort: null, effortLevels: [] });
      expect(await choiceOf(before)).toEqual({ model: null, effort: null, effortLevels: [] });
      expect(await codeOf(world.conversations.send({ sessionId: before.id }, 'oi'))).toBe('MODEL_UNAVAILABLE');

      // Definir confere com o provedor: modelo fora da lista e effort que o modelo não aceita (sem teste, não há nível) são recusados.
      expect(await codeOf(world.conversations.setSessionDefault('nao-existe', null, ORIGIN))).toBe('MODEL_UNAVAILABLE');
      expect(await codeOf(world.conversations.setSessionDefault('opencode/glm-5.1', 'high', ORIGIN))).toBe('VALIDATION_FAILED');
      expect(await world.conversations.sessionDefault()).toEqual({ model: null, effort: null, effortLevels: [] });

      // Depois do teste do modelo o effort aceito passa; o padrão vale para a sessão que já existia e para as novas.
      await world.models.test('opencode/glm-5.1');
      expect(await world.conversations.setSessionDefault('opencode/glm-5.1', 'low', ORIGIN)).toEqual({ model: 'opencode/glm-5.1', effort: 'low', effortLevels: ['low', 'medium', 'high'] });
      expect(await choiceOf(before)).toEqual({ model: 'opencode/glm-5.1', effort: 'low', effortLevels: ['low', 'medium', 'high'] });
      expect(await choiceOf(await chat.create())).toEqual({ model: 'opencode/glm-5.1', effort: 'low', effortLevels: ['low', 'medium', 'high'] });
      expect(await world.conversations.send({ sessionId: before.id }, 'agora vai')).toMatchObject({ kind: 'run', status: 'queued' }); // com o padrão definido o envio é aceito

      // Trocar o padrão é um upsert (uma linha só) e a troca no composer de UMA conversa vale só para ela e não muda o padrão.
      await world.models.test('opencode/kimi-k2.7-code');
      await world.conversations.setSessionDefault('opencode/kimi-k2.7-code', null, ORIGIN);
      expect(Number((await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM general_chat_settings')).rows[0]?.total)).toBe(1);
      const own = await chat.create();
      await world.conversations.setPreference({ sessionId: own.id }, 'opencode/glm-5.1', null);
      expect(await choiceOf(own)).toEqual({ model: 'opencode/glm-5.1', effort: null, effortLevels: ['low', 'medium', 'high'] });
      expect(await world.conversations.sessionDefault()).toEqual({ model: 'opencode/kimi-k2.7-code', effort: null, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] });

      // O padrão do chat não vaza para os bots: o bot sem modelo continua no primeiro favorito.
      expect((await world.conversations.snapshot(bot.id)).model).toEqual({ model: 'opencode/glm-5.1', effort: null, effortLevels: ['low', 'medium', 'high'] });
      // A auditoria diz quem mudou e para qual modelo (e nada além).
      const audit = await world.pool.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'chat.default_model_set' ORDER BY id");
      expect(audit.rows.map((row) => row.details)).toEqual([
        { model: 'opencode/glm-5.1', effort: 'low' },
        { model: 'opencode/kimi-k2.7-code', effort: null },
      ]);
    } finally {
      await world.cleanup();
    }
  });
});

describe('modelo oculto no Chat geral (phase 17, A9)', () => {
  it('a sessão cujo modelo padrão foi ocultado em Conexões segue conversando com ele, e o servidor continua aceitando-o como padrão', async () => {
    const world = await createRunsWorld();
    try {
      await world.models.test('opencode/glm-5.3-flash');
      await world.conversations.setSessionDefault('opencode/glm-5.3-flash', null, ORIGIN);
      await world.models.setHidden('opencode/glm-5.3-flash', true);
      expect((await world.conversations.sessionDefault()).model).toBe('opencode/glm-5.3-flash');
      await expect(world.conversations.setSessionDefault('opencode/glm-5.3-flash', null, ORIGIN)).resolves.toMatchObject({ model: 'opencode/glm-5.3-flash' });
      const session = await new GeneralChatService({ pool: world.pool }).create();
      world.engine.start();
      const run = (await world.conversations.send({ sessionId: session.id }, 'oi, modelo oculto')).id;
      await world.waitForStatus(run, 'completed');
      expect((await world.pool.query('SELECT last_model FROM runs WHERE id = $1', [run])).rows[0]).toEqual({ last_model: 'opencode/glm-5.3-flash' });
    } finally {
      await world.cleanup();
    }
  });
});

describe('saldo da Anthropic esgotado no Chat geral (phase 17, A20)', () => {
  it('a sessão cujo modelo padrão é anthropic/ sem saldo falha com PROVIDER_CREDITS_EXHAUSTED, com o cartão "Créditos da Anthropic esgotados", o aviso push do Chat geral e uma só chamada', async () => {
    const world = await createRunsWorld();
    try {
      await world.connectAnthropic();
      await world.models.test('anthropic/claude-haiku-5-5');
      await world.conversations.setSessionDefault('anthropic/claude-haiku-5-5', null, ORIGIN);
      await new PushService({ pool: world.pool, config: { enabled: false } }).registerDevice('device-chat-saldo', ORIGIN); // sem aparelho o aviso nem é enfileirado
      const session = await new GeneralChatService({ pool: world.pool }).create();
      world.engine.start();
      const since = world.upstreams.requests.length;
      const run = (await world.conversations.send({ sessionId: session.id }, '[sem-saldo] oi')).id;
      await world.waitForStatus(run, 'failed');

      expect(await world.runRow(run)).toMatchObject({ status: 'failed', failure_code: 'PROVIDER_CREDITS_EXHAUSTED' });
      expect(world.upstreams.requests.slice(since).filter((request) => request.service === 'anthropic' && request.method === 'POST' && Array.isArray(request.body?.system))).toHaveLength(1);
      const cards = await world.pool.query<{ data: { type: string; code: string }; content: string }>("SELECT data, content FROM messages WHERE run_id = $1 AND kind = 'card'", [run]);
      expect(cards.rows.map((row) => [row.data.type, row.data.code, row.content])).toEqual([['run_failed', 'PROVIDER_CREDITS_EXHAUSTED', 'Créditos da Anthropic esgotados.']]);
      expect((await world.pool.query('SELECT kind FROM push_events WHERE run_id = $1', [run])).rows).toEqual([{ kind: 'run_failed' }]);
    } finally {
      await world.cleanup();
    }
  });
});

describe('título automático', () => {
  it('reduz a primeira mensagem a uma linha de até 80 caracteres, sem partir um caractere no corte', () => {
    expect(titleFromMessage('  Preciso   de um\n\n resumo\tda semana  ')).toBe('Preciso de um resumo da semana');
    expect(titleFromMessage('a'.repeat(CHAT_SESSION_TITLE_MAX))).toBe('a'.repeat(CHAT_SESSION_TITLE_MAX));

    const long = titleFromMessage(`${'palavra '.repeat(20)}fim`);
    expect(Array.from(long)).toHaveLength(CHAT_SESSION_TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/\s…$/);

    // O emoji vale um caractere (como no `char_length` do banco): o corte nunca deixa meio emoji.
    const emojis = titleFromMessage('🙂'.repeat(100));
    expect(Array.from(emojis)).toHaveLength(CHAT_SESSION_TITLE_MAX);
    expect(emojis).toBe(`${'🙂'.repeat(CHAT_SESSION_TITLE_MAX - 1)}…`);
  });
});

describe('sessões do chat geral', () => {
  let world: RunsWorld;
  let chat: GeneralChatService;
  let activities: ActivityService;

  beforeAll(async () => {
    world = await createRunsWorld({ engine: { approvalSweepMs: 40 } });
    await world.connectComposio();
    chat = new GeneralChatService({ pool: world.pool });
    activities = new ActivityService({ pool: world.pool });
    world.engine.start();
  });
  afterAll(async () => {
    await world.cleanup();
  });

  /** Sessão nova já com o modelo escolhido (uma sessão não tem padrão de bot e o mundo não tem favoritos). */
  async function openSession(): Promise<ChatSession> {
    const session = await chat.create();
    await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
    return session;
  }

  const sendTo = async (session: ChatSession, text: string): Promise<string> => (await world.conversations.send({ sessionId: session.id }, text)).id;

  const timelineOf = async (session: ChatSession) =>
    (
      await world.pool.query<{ role: string; kind: string; content: string }>(
        'SELECT role, kind, content FROM messages WHERE conversation_id = $1 AND status = $2 ORDER BY id',
        [session.id, 'done'],
      )
    ).rows;

  /** A chamada de chat que o motor fez por último (o corpo que o provedor falso recebeu). */
  const lastRequestBody = () => world.conversationRequests().at(-1)?.body as { messages: { role: string; content: string }[]; tools?: { function: { name: string; description?: string } }[] };

  it('nasce vazia e sem título, ganha o título na primeira mensagem e conversa pelo mesmo motor do bot', async () => {
    const created = await chat.create();
    expect(created).toMatchObject({ title: null, saved: false });
    expect(Date.parse(created.expiresAt!) - Date.parse(created.lastActivityAt)).toBe(CHAT_SESSION_RETENTION_MS);
    expect(created.lastActivityAt).toBe(created.createdAt);

    // Sem padrão de bot nem favorito, não há modelo: o envio é recusado até o dono escolher um no composer.
    expect((await world.conversations.snapshot({ sessionId: created.id })).model).toEqual({ model: null, effort: null, effortLevels: [] });
    expect(await codeOf(sendTo(created, 'oi'))).toBe('MODEL_UNAVAILABLE');
    await world.conversations.setPreference({ sessionId: created.id }, 'opencode/glm-5.1', null);
    expect((await world.conversations.snapshot({ sessionId: created.id })).model).toEqual({ model: 'opencode/glm-5.1', effort: null, effortLevels: [] });

    const first = await sendTo(created, '  Preciso   de um\n resumo da semana  ');
    await world.waitForStatus(first, 'completed');
    expect((await chat.get(created.id)).title).toBe('Preciso de um resumo da semana');
    expect(await timelineOf(created)).toEqual([
      { role: 'user', kind: 'text', content: '  Preciso   de um\n resumo da semana  ' },
      { role: 'assistant', kind: 'text', content: expect.stringContaining('Resposta: ') },
    ]);

    // O título não muda com as mensagens seguintes, e a atividade (de onde contam os 7 dias) acompanha a última linha da conversa.
    const second = await sendTo(created, 'e agora outro assunto');
    await world.waitForStatus(second, 'completed');
    const listed = (await chat.list()).items.find((item) => item.id === created.id)!;
    expect(listed.title).toBe('Preciso de um resumo da semana');
    expect(Date.parse(listed.lastActivityAt)).toBeGreaterThan(Date.parse(created.createdAt));
    expect(Date.parse(listed.expiresAt!) - Date.parse(listed.lastActivityAt)).toBe(CHAT_SESSION_RETENTION_MS);
  });

  it('a lista traz as sessões da mais recentemente ativa para a mais antiga e nunca a conversa de um bot', async () => {
    const bot = await world.createBot();
    const older = await openSession();
    const newer = await openSession();
    await world.waitForStatus(await sendTo(older, 'primeira'), 'completed');
    await world.waitForStatus(await sendTo(newer, 'segunda'), 'completed');
    await world.waitForStatus(await sendTo(older, 'terceira'), 'completed');

    const ids = (await chat.list()).items.map((item) => item.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
    const botConversation = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
    expect(ids).not.toContain(botConversation);
    // O id da conversa de um bot não abre uma "sessão", por nenhum caminho.
    expect(await codeOf(chat.get(botConversation))).toBe('SESSION_NOT_FOUND');
    expect(await codeOf(world.conversations.snapshot({ sessionId: botConversation }))).toBe('SESSION_NOT_FOUND');
    expect(await codeOf(world.conversations.send({ sessionId: botConversation }, 'oi'))).toBe('SESSION_NOT_FOUND');
    expect(await codeOf(chat.setSaved(botConversation, true))).toBe('SESSION_NOT_FOUND');
  });

  it('salvar tira a data de expiração e desligar a devolve, contada a partir da última mensagem; é idempotente', async () => {
    const session = await openSession();
    await world.waitForStatus(await sendTo(session, 'guardar esta'), 'completed');
    const before = await chat.get(session.id);

    const saved = await chat.setSaved(session.id, true);
    expect(saved).toMatchObject({ saved: true, expiresAt: null, lastActivityAt: before.lastActivityAt });
    expect(await chat.setSaved(session.id, true)).toEqual(saved);

    const unsaved = await chat.setSaved(session.id, false);
    expect(unsaved.saved).toBe(false);
    expect(Date.parse(unsaved.expiresAt!) - Date.parse(unsaved.lastActivityAt)).toBe(CHAT_SESSION_RETENTION_MS);
    expect(await codeOf(chat.setSaved('00000000-0000-4000-8000-000000000000', true))).toBe('SESSION_NOT_FOUND');
  });

  it('o contexto leva só a memória global e as ferramentas de bot não existem: oferecidas ao modelo, nem aceitas se ele as chamar', async () => {
    const global = await world.memory.read({ scope: 'global' });
    await world.memory.save({ scope: 'global' }, 'O dono mora em Curitiba.', global.version, ORIGIN);

    // Um bot com instruções e memória próprias existe no mesmo banco: nada dele pode chegar a uma sessão do Chat geral (A35).
    const owned = await world.createBot({ name: 'Vazamento-ZQ', instructions: 'ZQ-INSTRUCOES-DE-BOT' });
    await world.pool.query('UPDATE bot_memories SET content = $2 WHERE bot_id = $1', [owned.id, 'ZQ-MEMORIA-DE-BOT']);

    const session = await openSession();
    await world.waitForStatus(await sendTo(session, 'olá'), 'completed');
    const body = lastRequestBody();
    const system = body.messages[0]!.content;
    // Variante do chat geral (F7; A35, provada pelo efeito e não pela frase): o texto-base do chat, as Regras Globais sob um rótulo, o idioma e a formatação, nessa ordem, cada um uma vez, e nada
    // de agente (nome, instruções, memória); a abertura é a rodada derivada (CTX-01).
    const globalRule = 'O dono mora em Curitiba.';
    const language = LANGUAGES['pt-BR'].instruction;
    expect(system.startsWith(GENERAL_CHAT_RULES)).toBe(true);
    const positions = [GENERAL_CHAT_RULES, globalRule, language, FORMATTING_RULES].map((part) => system.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const part of [globalRule, language, FORMATTING_RULES]) expect(system.split(part)).toHaveLength(2);
    const above = system.slice(0, system.indexOf(globalRule)).split('\n').filter((line) => line.trim() !== '').at(-1); // a linha logo acima das Regras Globais
    expect(above).toMatch(/^#{1,3} /); // as Regras Globais chegam sob um rótulo
    for (const agentOnly of ['Vazamento-ZQ', 'ZQ-INSTRUCOES-DE-BOT', 'ZQ-MEMORIA-DE-BOT']) expect(system).not.toContain(agentOnly);
    expect(body.messages[1]).toEqual({ role: 'user', content: NEW_CHAT_MARKER });
    // Catálogo inicial enxuto; a descoberta seleciona os serviços disponíveis sem publicar ferramentas de bot.
    const offered = body.tools?.map((tool) => tool.function.name) ?? [];
    expect(offered).toEqual(['discover_tools','read_activity']);
    expect(offered).not.toContain('edit_memory');
    for (const botOnly of ['propose_routine', 'list_routines', 'get_routine', 'propose_routine_change']) expect(offered).not.toContain(botOnly);
    await world.waitForStatus(await sendTo(session,tableMarker('discover_tools',{names:['search_history']})),'completed');
    const selected=lastRequestBody().tools?.map((tool)=>tool.function.name)??[];
    expect(selected).toEqual(expect.arrayContaining(['search_history']));
    for(const botOnly of ['edit_memory','propose_routine','list_routines','get_routine','propose_routine_change'])expect(selected).not.toContain(botOnly);

    // O modelo falso insiste em `edit_memory` (como um modelo que alucina a ferramenta): a chamada falha, e nenhuma memória muda.
    const versionBefore = (await world.memory.read({ scope: 'global' })).version;
    const insisting = await sendTo(session, '[memoria:vazar para a memória]');
    await world.waitForStatus(insisting, 'completed');
    // Outra mensagem da MESMA sessão conserva a base e a seleção da conversa (sem nova descoberta paga); botOnly segue fora.
    expect(lastRequestBody().messages[0]!.content).toBe(system);
    expect(lastRequestBody().tools?.map((tool) => tool.function.name)).toEqual(['discover_tools','read_activity','search_history']);
    const activity = (await world.pool.query<{ status: string; content: string }>("SELECT status, content FROM messages WHERE run_id = $1 AND kind = 'activity'", [insisting])).rows[0];
    expect(activity).toMatchObject({ status: 'failed', content: expect.stringContaining('"code":"TOOL_NOT_FOUND"') });
    expect(JSON.parse(activity!.content)).toEqual({ code: 'TOOL_NOT_FOUND', message: expect.stringMatching(/^Ferramenta desconhecida: edit_memory\..*discover_tools/u) });
    expect((await world.memory.read({ scope: 'global' })).version).toBe(versionBefore);
    expect((await world.pool.query("SELECT 1 FROM messages WHERE run_id = $1 AND data->>'type' = 'memory_updated'", [insisting])).rowCount).toBe(0);

    // Controle: a conversa de um bot continua alcançando as ferramentas de bot (pela árvore de grupos: a lista fixa tem só as portas, e o grupo aberto devolve o esquema) e recebendo o nome, as instruções e a memória dele.
    const groups=[['ferramentas/memoria','edit_memory'],['ferramentas/rotinas','propose_routine'],['ferramentas/rotinas','get_routine']] as const;
    for(const [index,[path,name]] of groups.entries()){
      // Janela de 64k: o assunto aqui é o catálogo oferecido, não a pressão de contexto (o sistema ganhou o guia de uso do Aion).
      const bot=await world.createBot({name:`Controle ${index}`,instructions:'Instrução do controle.',contextWindowTokens:65536});
      await world.waitForStatus(await world.send(bot,tableMarker('abrir_grupo',{path})),'completed');
      const botBody=lastRequestBody();
      expect(botBody.tools?.map((tool)=>tool.function.name)).toEqual(['abrir_grupo','use_tool','read_activity']);
      // O esquema da ferramenta do bot chegou no fim do histórico, em resultado próprio (o Chat geral não alcança nenhuma delas).
      expect(botBody.messages.some((message)=>message.role==='tool'&&message.content.includes(`"name":"${name}"`))).toBe(true);
      // O bot recebe o próprio nome, as instruções dele (depois do nome) e as Regras Globais do dono (A35).
      const botSystem = botBody.messages[0]!.content;
      // A ferramenta do bot está no índice da árvore do SISTEMA dele (phase 15, passo 12), e a descrição de abrir_grupo não repete o índice.
      expect(botSystem).toContain(`${path}:`);
      expect(botSystem).toContain(name);
      expect(botBody.tools?.find((tool)=>tool.function.name==='abrir_grupo')?.function.description).not.toContain(name);
      expect(botSystem).toContain('O dono mora em Curitiba.');
      expect(botSystem.indexOf(`Controle ${index}`)).toBeGreaterThanOrEqual(0);
      expect(botSystem.indexOf('Instrução do controle.')).toBeGreaterThan(botSystem.indexOf(`Controle ${index}`));
      expect(botBody.messages.map((message)=>message.content)).not.toContain(NEW_CHAT_MARKER);
    }
  });

  // A29 e E2 (phase 15, passo 9): o alvo da `use_tool` sai SEMPRE do mapa filtrado da execução. No Chat geral ele não tem as ferramentas `botOnly` (tabelas, docs, memória, rotinas), então apontar a porta
  // para uma delas responde como um nome inventado (nem a existência é revelada), e nada é lido, criado ou gravado.
  it('A29 e E2: use_tool apontada para ferramenta botOnly no Chat geral é recusada como nome desconhecido, e nenhuma tabela, doc ou memória é lida ou gravada', async () => {
    const session = await openSession();
    const count = async (table: 'data_tables' | 'docs') => Number((await world.pool.query<{ total: string }>(`SELECT count(*) AS total FROM ${table}`)).rows[0]!.total);
    const [tablesBefore, docsBefore, memoryBefore] = [await count('data_tables'), await count('docs'), (await world.memory.read({ scope: 'global' })).version];
    const attempts: [string, unknown][] = [
      ['table_list', {}],
      ['table_query', { tableId: '00000000-0000-4000-8000-000000000001' }],
      ['doc_create', { title: 'Invasão', content: 'x', operationId: '00000000-0000-4000-8000-000000000002' }],
      ['edit_memory', { scope: 'agent', operation: 'append', text: 'vazar' }],
      ['ferramenta_inventada', {}],
    ];
    const messages: string[] = [];
    for (const [name, args] of attempts) {
      const run = await sendTo(session, tableMarker('use_tool', { name, arguments: args }));
      await world.waitForStatus(run, 'completed');
      const activity = (await world.pool.query<{ status: string; content: string; data: { tool: string; via?: string } }>("SELECT status, content, data FROM messages WHERE run_id = $1 AND kind = 'activity'", [run])).rows[0]!;
      expect(activity).toMatchObject({ status: 'failed', data: { tool: name, via: 'use_tool' } });
      const failure = JSON.parse(activity.content) as { code: string; message: string };
      expect(failure.code).toBe('TOOL_NOT_FOUND');
      messages.push(failure.message.replace(name, '<nome>'));
    }
    // A recusa é a mesma do nome inventado: a resposta não distingue "não existe" de "existe só para bot".
    expect(new Set(messages).size).toBe(1);
    expect([await count('data_tables'), await count('docs'), (await world.memory.read({ scope: 'global' })).version]).toEqual([tablesBefore, docsBefore, memoryBefore]);
    // Controle: uma ferramenta que o Chat geral tem executa pela porta, com o alvo no mapa dele.
    const found = await sendTo(session, tableMarker('use_tool', { name: 'search_history', arguments: { query: 'inventada' } }));
    await world.waitForStatus(found, 'completed');
    expect((await world.pool.query<{ status: string; data: { tool: string; via?: string } }>("SELECT status, data FROM messages WHERE run_id = $1 AND kind = 'activity'", [found])).rows[0]).toMatchObject({ status: 'completed', data: { tool: 'search_history', via: 'use_tool' } });
  });

  it('a busca no histórico vale só para a própria sessão, nunca para outra sessão nem para um bot', async () => {
    const bot = await world.createBot();
    await world.waitForStatus(await world.send(bot, 'o bot guardou o código azulejo-bot'), 'completed');
    const other = await openSession();
    await world.waitForStatus(await sendTo(other, 'a outra sessão guardou o código azulejo-outra'), 'completed');
    const mine = await openSession();
    await world.waitForStatus(await sendTo(mine, 'esta sessão guardou o código azulejo-propria'), 'completed');
    // Seis rodadas de assunto neutro empurram a mensagem acima da janela de 5 rodadas: só a busca a alcança.
    for (let index = 0; index < 6; index += 1) await world.waitForStatus(await sendTo(mine, `conversa neutra ${index}`), 'completed');

    const run = await sendTo(mine, '[pesquisar:azulejo]');
    await world.waitForStatus(run, 'completed');
    const found = (await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE run_id = $1 AND kind = 'activity'", [run])).rows[0]!.content;
    expect(found).toContain('azulejo-propria');
    expect(found).not.toContain('azulejo-bot');
    expect(found).not.toContain('azulejo-outra');
  });

  it('"Novo chat aberto" sai na 5ª mensagem, cobertura contínua preserva a 6ª; nunca gravado, fora da busca e sem duplicar na retomada', async () => {
    const session = await openSession();
    /** Turnos de usuário do último pedido, sem o bloco `# Dados` que cada abertura de rodada leva (PERF-01, phase 10). */
    const userTurns = () => lastRequestBody().messages.filter((message) => message.role === 'user').map((message) => message.content.replace(/^# Dados\n[\s\S]*?\n\n# Mensagem\n/, ''));
    const markers = () => lastRequestBody().messages.filter((message) => message.content === NEW_CHAT_MARKER).length;
    /** Só as mensagens do dono e o marcador (os cartões de desfecho, como o da falha, também entram como "[Sistema] ..."). */
    const ownerTurns = () => userTurns().filter((text) => !text.startsWith('[Sistema] ') || text === NEW_CHAT_MARKER);

    // 1ª mensagem: falha do provedor e "Tentar novamente" reaproveita a mesma rodada; o marcador continua um só, logo depois do sistema.
    const failed = await sendTo(session, '[falha] primeira');
    await world.waitForStatus(failed, 'failed');
    const retry = await world.conversations.retry({ sessionId: session.id }, failed);
    // Na sessão o "Tentar novamente" é uma versão nova da resposta (phase 4, F2): o cartão da falha é da outra versão e sai do contexto, então o
    // provedor falso, que falha sempre com `[falha]`, falha de novo. O que este teste prova é a rodada e o marcador, iguais nos dois desfechos.
    await world.waitForStatus(retry.id, 'failed');
    expect(lastRequestBody().messages[1]).toEqual({ role: 'user', content: NEW_CHAT_MARKER });
    expect(markers()).toBe(1);
    expect(ownerTurns()).toEqual([NEW_CHAT_MARKER, '[falha] primeira']);

    for (const text of ['segunda', 'terceira', 'quarta']) await world.waitForStatus(await sendTo(session, text), 'completed');
    // 4ª mensagem: marcador e as quatro rodadas da sessão (o marcador conta como a quinta).
    expect(markers()).toBe(1);
    expect(ownerTurns()).toEqual([NEW_CHAT_MARKER, '[falha] primeira', 'segunda', 'terceira', 'quarta']);

    // O marcador mantém a abertura derivada legada; cobertura inicializada passa a conservar todas as rodadas novas.
    await world.waitForStatus(await sendTo(session, 'quinta'), 'completed');
    expect(markers()).toBe(0);
    expect(ownerTurns()).toEqual(['[falha] primeira', 'segunda', 'terceira', 'quarta', 'quinta']);
    await world.waitForStatus(await sendTo(session, 'sexta'), 'completed');
    expect(markers()).toBe(0);
    expect(ownerTurns()).toEqual(['[falha] primeira','segunda', 'terceira', 'quarta', 'quinta', 'sexta']);

    // Nunca gravado: nem como mensagem, nem achado pela busca no histórico da sessão.
    const search = await sendTo(session, '[pesquisar:Novo chat aberto]');
    await world.waitForStatus(search, 'completed');
    const found = (await world.pool.query<{ data: { detail: { hits: unknown[] } } }>("SELECT data FROM messages WHERE run_id = $1 AND kind = 'activity'", [search])).rows[0]!;
    expect(JSON.stringify(found.data.detail.hits)).not.toContain('[Sistema]');
    expect((await world.pool.query('SELECT 1 FROM messages WHERE content = $1', [NEW_CHAT_MARKER])).rowCount).toBe(0);
  });

  it('com o Composio configurado e contas ativas, o Chat geral não recebe o conector: nenhuma etapa o oferece, a descoberta o recusa e a chamada insistente é desconhecida e não executa (A6)', async () => {
    // Precondição: chave do Composio válida e o Gmail conectado, no mesmo mundo em que a sessão roda.
    const connected = await world.credentials.listConnectorAccounts();
    expect(connected.filter((account) => account.status === 'active').map((account) => account.toolkitSlug)).toContain('gmail');
    const executionsBefore = world.composioExecutions().length;
    const connector = ['composio_search_actions', 'composio_execute_action'];
    const offeredNow = () => (lastRequestBody().tools ?? []).map((tool) => tool.function.name);

    const session = await openSession();
    await world.waitForStatus(await sendTo(session, 'olá'), 'completed');
    for (const name of connector) expect(offeredNow()).not.toContain(name);

    // A descoberta não conhece o conector: a seleção falha inteira, sem publicar nada dele, e o catálogo seguinte continua sem as duas portas.
    const selecting = await sendTo(session, tableMarker('discover_tools', { names: ['search_history', ...connector] }));
    await world.waitForStatus(selecting, 'completed');
    const selection = (await world.pool.query<{ status: string; content: string }>("SELECT status, content FROM messages WHERE run_id = $1 AND data->>'tool' = 'discover_tools'", [selecting])).rows[0];
    expect(selection).toMatchObject({ status: 'failed', content: expect.stringContaining('não disponível neste catálogo') });
    await world.waitForStatus(await sendTo(session, 'outra mensagem'), 'completed');
    for (const name of connector) expect(offeredNow()).not.toContain(name);

    // Um modelo que insiste em chamar a porta mesmo assim recebe "desconhecida": nenhuma ação chega ao Composio e nenhuma pausa pede aprovação.
    const insisting = await sendTo(session, '[gmail] envie o relatório');
    await world.waitForStatus(insisting, 'completed');
    const activity = (await world.pool.query<{ status: string; content: string }>("SELECT status, content FROM messages WHERE run_id = $1 AND kind = 'activity'", [insisting])).rows[0];
    expect(activity).toMatchObject({ status: 'failed', content: expect.stringContaining('"code":"TOOL_NOT_FOUND"') });
    expect(JSON.parse(activity!.content).message).toContain('composio_execute_action');
    expect(await world.approvalOf(insisting)).toBeNull();
    expect(world.composioExecutions()).toHaveLength(executionsBefore);
  });

  it('modelo sem ferramentas no Chat geral não gera o aviso das ações do Composio: não há conector para ele deixar de usar (A6)', async () => {
    await world.models.test('opencode/glm-5.3-flash'); // passa em texto e falha na ferramenta: selo "Sem ferramentas"
    const session = await chat.create();
    await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.3-flash', null);
    await world.waitForStatus(await sendTo(session, 'oi'), 'completed');
    // Com o Composio conectado o aviso aparece no bot (ver o teste de F8 em approvals.test.ts); a sessão não tem ação do conector a perder, então nenhum cartão nasce.
    expect((await world.pool.query("SELECT 1 FROM messages WHERE conversation_id = $1 AND kind = 'card' AND data->>'type' = 'model_without_tools'", [session.id])).rowCount).toBe(0);
  });

  it('aprovação de ação do conector pendente desde antes da phase 13: a resposta permanente é recusada e "permitir uma vez" recusa a chamada, auditada, sem executar no Composio (A7)', async () => {
    const session = await openSession();
    // A pendência de uma ação do conector na sessão, como a phase 12 a deixava no banco: o conector saiu do Chat geral na phase 13 e nada mais a cria, então a prova a semeia (sem proveniência da atividade,
    // porque a recusa de A7 é uma das saídas que o modelo lê mesmo assim).
    const { runId: run, approvalId } = await seedLegacyChatApproval({ pool: world.pool, approvals: world.approvals, sessionId: session.id });
    const executionsBefore = world.composioExecutions().length;

    // O pedido é da sessão (sem bot) e aparece em Atividades como pendência dela, sem marcador de bot.
    const approval = (await world.pool.query<{ id: string; bot_id: string | null; conversation_id: string }>('SELECT id::text AS id, bot_id, conversation_id FROM approvals WHERE run_id = $1', [run])).rows[0]!;
    expect(approval).toMatchObject({ id: approvalId, bot_id: null, conversation_id: session.id });
    const pending = (await activities.list(undefined)).pending.find((item) => item.approvalId === approval.id);
    expect(pending).toMatchObject({ bot: null, sessionId: session.id, runId: run });

    // "Sempre" não tem bot onde gravar a regra: recusado no servidor, sem efeito algum, e o pedido segue respondível.
    const rulesBefore = (await world.pool.query('SELECT 1 FROM bot_approval_rules')).rowCount;
    for (const decision of ['allow_always', 'deny_always'] as const) {
      expect(await codeOf(world.approvals.respond(approval.id, decision, ORIGIN))).toBe('VALIDATION_FAILED');
    }
    expect((await world.approvalOf(run))?.status).toBe('pending');
    expect((await world.pool.query('SELECT 1 FROM bot_approval_rules')).rowCount).toBe(rulesBefore);

    // Permitir uma vez não executa: o Chat geral não tem mais conector. A chamada fecha como falha com a recusa, que o modelo lê como resultado da ferramenta, e a execução segue até o fim.
    await world.approvals.respond(approval.id, 'allow_once', ORIGIN);
    await world.waitForStatus(run, 'completed');
    expect(world.composioExecutions()).toHaveLength(executionsBefore);
    const refusal = 'Ação recusada: o Chat geral não usa conectores. Ela não foi executada.';
    expect((await world.pool.query<{ status: string; content: string }>("SELECT status, content FROM messages WHERE run_id = $1 AND kind = 'activity'", [run])).rows).toEqual([{ status: 'failed', content: refusal }]);
    expect(lastRequestBody().messages.filter((message) => message.role === 'tool').map((message) => message.content)).toEqual([refusal]);
    // Auditada: a tentativa de executar não entra (a ação não começou), só a recusa, sem a chave do Composio.
    const audits = (await world.pool.query<{ action: string; outcome: string; target: string; details: Record<string, unknown> }>("SELECT action, outcome, target, details FROM audit_log WHERE action IN ('composio.action_started', 'composio.action') AND details->>'run' = $1 ORDER BY id", [run])).rows;
    expect(audits).toEqual([{ action: 'composio.action', outcome: 'denied', target: 'GMAIL_SEND_EMAIL', details: { bot: null, run, basis: 'general_chat' } }]);
    expect(JSON.stringify(audits)).not.toContain('valid-key-2222');
  });

  it('cada sessão tem a própria fila: duas sessões e um bot rodam em paralelo, e a mensagem seguinte da mesma sessão espera a vez', async () => {
    const bot = await world.createBot();
    const a = await openSession();
    const b = await openSession();
    const botRun = await world.send(bot, '[demorar]');
    const aRun = await sendTo(a, '[demorar]');
    // Na fila atrás da primeira sem depender do instante em que o motor a reivindica (depois disso, o envio viraria complemento: CONV-03).
    const aNext = await world.enqueue({ sessionId: a.id }, 'só depois');
    await world.waitForStatus(botRun, 'running');
    await world.waitForStatus(aRun, 'running');
    const bRun = await sendTo(b, 'rápida');
    await world.waitForStatus(bRun, 'completed'); // outra sessão não espera a primeira

    // Na sessão A a segunda mensagem continua na fila enquanto a primeira trabalha (FIFO por conversa).
    expect((await world.runRow(aNext)).status).toBe('queued');
    expect((await world.conversations.snapshot({ sessionId: a.id })).runs.map((run) => [run.id, run.status])).toEqual([
      [aRun, 'running'],
      [aNext, 'queued'],
    ]);

    // O banco recusa uma segunda execução ativa na mesma sessão (índice único por sessão), como faz com o bot.
    await expect(
      world.pool.query("INSERT INTO runs (conversation_id, status, input, created_at) VALUES ($1, 'running', 'x', now())", [a.id]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'runs_one_active_per_session' });

    // Atividades lista as execuções da sessão sem bot e com o id dela; parar vale só para a execução certa daquela sessão.
    const items = (await activities.list(undefined)).items;
    expect(items.find((item) => item.runId === aRun)).toMatchObject({ bot: null, sessionId: a.id, status: 'running' });
    expect(items.find((item) => item.runId === botRun)).toMatchObject({ sessionId: null, bot: { id: bot.id } });
    expect(await codeOf(world.conversations.stop({ sessionId: b.id }, aRun))).toBe('RUN_NOT_ACTIVE');
    expect((await world.conversations.stop({ sessionId: a.id }, aRun)).id).toBe(aRun);
    await world.waitForStatus(aRun, 'interrupted');
    await world.waitForStatus(aNext, 'completed'); // a fila da sessão andou
    expect((await world.runRow(botRun)).status).toBe('running'); // a parada da sessão não tocou no bot
    await world.conversations.stop(bot.id);
    await world.waitForStatus(botRun, 'interrupted');
  });

  it('o teto de 20 mensagens na fila vale por sessão', async () => {
    const full = await openSession();
    const other = await openSession();
    await sendTo(full, '[demorar]');
    await waitFor('primeira execução rodando', async () => (await world.conversations.snapshot({ sessionId: full.id })).runs.some((run) => run.status === 'running'));
    // A fila atrás da ativa vem da mesma `queueRun` do envio; com a sessão ocupada, o envio do dono vira complemento (CONV-03) e não esbarra nela.
    for (let index = 0; index < 20; index += 1) await world.enqueue({ sessionId: full.id }, `fila ${index}`);
    expect(await codeOf(world.enqueue({ sessionId: full.id }, 'a 21ª'))).toBe('QUEUE_FULL');
    expect(await world.conversations.send({ sessionId: full.id }, 'complemento com a fila cheia')).toMatchObject({ kind: 'complement' });
    // Outra sessão não é afetada pela fila cheia desta.
    await world.waitForStatus(await sendTo(other, 'ainda funciona'), 'completed');
    await world.conversations.stop({ sessionId: full.id });
  });
});
