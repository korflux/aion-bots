// Prova do bloco `# Dados` gravado por execução e reenviado igual (phase 10, T1; PERF-01 substituída; A1 a A6, spec decisões 1 a 7). Mundo real: PostgreSQL embarcado, motor
// real e provedor falso, com um relógio de domínio que o teste move. Cada prova olha o que o provedor RECEBEU (os pedidos capturados) e o que ficou no banco:
// - A1 e A2: o pedido anterior é prefixo exato do seguinte entre etapas da mesma execução, na virada de rodada e no Chat geral; trocar o modelo e a hora no meio da execução
//   não muda o bloco gravado, e a rodada seguinte leva o modelo novo no bloco dela;
// - A3: depois de uma aprovação decidida e de uma posse retomada por outro worker (com a hora adiantada) o pedido segue idêntico, porque a hora nunca é lida de novo;
// - A4: "Tentar novamente" (bot) e "Gerar outra resposta" com troca de versão (Chat geral) gravam o bloco da execução nova, e o pedido usa o da execução em vigor; no bot, uma execução
//   mais nova que terminou sem gravar bloco (falha ou parada antes da primeira preparação) não tira da rodada o bloco da anterior;
// - A5: rodadas gravadas antes da migration entram sem bloco, nenhuma linha antiga muda e a execução em andamento no deploy recebe o bloco na próxima preparação;
// - A6: o bloco não aparece na tela, em `search_history`, em nenhuma linha de `messages` (de onde `read_activity` lê) nem na entrada do resumo da compactação;
// - a migration 0044 é aditiva e o rollback remove só a coluna.
// O bloco esperado é sempre montado por `currentDataBlock` (a função que o executor usa para gravá-lo) com o modelo e o instante da execução, então cada prova compara o TEXTO inteiro
// do bloco (formato, modelo, hora e fuso) e não trechos dele.
import { randomUUID } from 'node:crypto';
import type { Bot } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { SessionRef } from '../conversation/service';
import { MIGRATIONS } from '../db/migrations';
import { createPool } from '../db/pool';
import { GeneralChatService } from '../general-chat/service';
import type { ChatEvent, ChatRequest } from '../models/chat-protocols';
import { migrateTestDatabase } from '../testing/migrate';
import { createTestDatabase } from '../testing/postgres';
import { maskColdResults } from './cold-maintenance';
import { SUMMARY_SECTIONS } from './compaction';
import { currentDataBlock } from './context';
import { SUMMARY_MAX_OUTPUT_TOKENS } from './context-budget';
import { searchHistoryTool } from './search-history';
import { ORIGIN, createRunsWorld, waitFor, type RunsWorld } from './test-support';
import type { ToolContext, ToolHandler } from './tools';

/** Corpo (chat/completions) que o provedor falso recebeu: os turnos e as ferramentas oferecidas. */
interface ModelBody {
  messages: { role: string; content?: string }[];
  tools?: unknown[];
}

/** Relógio do domínio dos mundos deste arquivo: o instante-base e deslocamentos em minutos a partir dele (idioma e fuso padrão: pt-BR e America/Sao_Paulo). */
const BASE = new Date('2026-03-01T15:00:00Z');
const minutes = (count: number): number => count * 60_000;
/** O bloco `# Dados` que uma execução do modelo dado grava quando a primeira preparação dela acontece `offset` minutos depois do instante-base. */
const blockAt = (model: string, offset: number): string => currentDataBlock({ model, now: new Date(BASE.getTime() + minutes(offset)), language: 'pt-BR', timeZone: 'America/Sao_Paulo' });
const HEADER = /^# Dados\n[\s\S]*?\n\n# Mensagem\n/;

/** Corpos das chamadas ao modelo feitas depois do marco `since` (quantas já existiam), na ordem. */
const bodiesSince = (world: RunsWorld, since: number): ModelBody[] => world.conversationRequests().slice(since).map((request) => request.body as unknown as ModelBody);
/** Turnos do dono do pedido (sem o objetivo do bot nem o marcador de evidência), com o bloco `# Dados` quando há. */
const ownerTurns = (body: ModelBody): string[] =>
  body.messages.filter((turn) => turn.role === 'user' && !turn.content?.startsWith('# Objetivo do bot (')).map((turn) => (turn.content ?? '').replace(/\[Evidência do dono: messageId=\d+\]\n\n/g, ''));
/** O bloco que cada turno de abertura do pedido leva, na ordem (turnos sem bloco não entram). */
const blocksOf = (body: ModelBody): string[] => ownerTurns(body).flatMap((text) => HEADER.exec(text)?.[0] ?? []);
/** O turno de abertura do pedido que termina na mensagem dada. */
const openingOf = (body: ModelBody, message: string): string => ownerTurns(body).find((text) => text.endsWith(`# Mensagem\n${message}`)) ?? '';
/** O pedido anterior é prefixo exato do seguinte (mensagens e ferramentas): o que o cache de prefixo do provedor exige. */
function expectPrefix(previous: ModelBody, next: ModelBody): void {
  expect(next.messages.length).toBeGreaterThan(previous.messages.length);
  expect(next.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
  expect(next.tools).toEqual(previous.tools);
}
/** O bloco gravado numa execução (nulo se ela nunca o gravou). */
const storedBlock = async (world: RunsWorld, runId: string): Promise<string | null> => (await world.pool.query<{ request_data: string | null }>('SELECT request_data FROM runs WHERE id = $1', [runId])).rows[0]!.request_data;

/** Envia uma mensagem e espera a execução concluir; devolve o id dela. Aceita bot ou sessão do Chat geral. */
async function say(world: RunsWorld, target: Bot | SessionRef, text: string): Promise<string> {
  const id = 'sessionId' in target ? (await world.conversations.send(target, text)).id : await world.send(target, text);
  await world.waitForStatus(id, 'completed');
  return id;
}

/** Sessão nova do Chat geral com modelo escolhido (a sessão não tem padrão de bot). */
async function openSession(world: RunsWorld): Promise<SessionRef> {
  const session = await new GeneralChatService({ pool: world.pool }).create();
  await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
  return { sessionId: session.id };
}

describe('bloco de dados por execução, no relógio do domínio (A1, A3, A4, A5, A6)', () => {
  let world: RunsWorld;
  let clock = BASE;
  /** Põe o relógio `offset` minutos depois do instante-base (cada teste começa de uma hora conhecida e distante dos outros) e o adianta pelo tempo dito. */
  const startAt = (offset: number): void => { clock = new Date(BASE.getTime() + minutes(offset)); };
  const advance = (count: number): void => { clock = new Date(clock.getTime() + minutes(count)); };

  beforeAll(async () => {
    world = await createRunsWorld({ now: () => clock, engine: { approvalSweepMs: 40 } });
    await world.connectComposio();
    world.engine.start();
  });
  afterAll(async () => {
    await world.cleanup();
  });

  it('A1 (bot): o pedido anterior é prefixo exato do seguinte entre as etapas e na virada de rodada, e cada rodada mantém o bloco que levou', async () => {
    startAt(0);
    const bot = await world.createBot();
    const since = world.conversationRequests().length;
    const first = await say(world, bot, '[pesquisar:zzz] procure'); // duas etapas (a ferramenta e a resposta)
    advance(7);
    const second = await say(world, bot, 'e agora?');
    advance(90);
    const third = await say(world, bot, '[pesquisar:aaa] de novo'); // duas etapas
    const requests = bodiesSince(world, since);
    expect(requests).toHaveLength(5);
    for (let index = 1; index < requests.length; index += 1) expectPrefix(requests[index - 1]!, requests[index]!);

    // Cada abertura leva o bloco da execução dela, e o das rodadas anteriores segue com a hora em que a execução dele o gravou.
    const [b1, b2, b3] = [blockAt('glm-5.1', 0), blockAt('glm-5.1', 7), blockAt('glm-5.1', 97)];
    expect(blocksOf(requests[0]!)).toEqual([b1]);
    expect(blocksOf(requests[1]!)).toEqual([b1]);
    expect(blocksOf(requests[2]!)).toEqual([b1, b2]);
    expect(blocksOf(requests[3]!)).toEqual([b1, b2, b3]);
    expect(blocksOf(requests[4]!)).toEqual([b1, b2, b3]);
    // O texto que vai ao modelo é exatamente o gravado: nenhum turno de abertura é remontado.
    expect([await storedBlock(world, first), await storedBlock(world, second), await storedBlock(world, third)]).toEqual([b1, b2, b3]);
    expect(ownerTurns(requests[4]!).map((text) => text.replace(HEADER, ''))).toEqual(['[pesquisar:zzz] procure', 'e agora?', '[pesquisar:aaa] de novo']);
  });

  it('A1 (Chat geral): o mesmo vale numa sessão, com o marcador "Novo chat aberto" no começo enquanto ela tem menos de cinco rodadas', async () => {
    startAt(300);
    const ref = await openSession(world);
    const since = world.conversationRequests().length;
    await say(world, ref, '[pesquisar:zzz] procure');
    advance(20);
    await say(world, ref, 'e agora?');
    advance(5);
    await say(world, ref, 'obrigado');
    const requests = bodiesSince(world, since);
    expect(requests).toHaveLength(4);
    for (let index = 1; index < requests.length; index += 1) expectPrefix(requests[index - 1]!, requests[index]!);
    expect(ownerTurns(requests[3]!)[0]).toBe('[Sistema] Novo chat aberto.');
    expect(blocksOf(requests[3]!)).toEqual([blockAt('glm-5.1', 300), blockAt('glm-5.1', 320), blockAt('glm-5.1', 325)]);
  });

  it('A3 (aprovação decidida): o primeiro pedido depois da decisão tem o anterior como prefixo exato, com o mesmo bloco, mesmo três horas depois', async () => {
    startAt(600);
    const bot = await world.createBot();
    const since = world.conversationRequests().length;
    await world.releaseConnectorAccounts(bot);
    const runId = await world.send(bot, '[gmail] envie o relatório');
    const approval = await waitFor('pedido de aprovação pendente', async () => {
      const found = await world.approvalOf(runId);
      return found?.status === 'pending' ? found : null;
    });
    advance(180); // o dono decide três horas depois
    await world.approvals.respond(approval.id, 'allow_once', ORIGIN);
    await world.waitForStatus(runId, 'completed');
    const [paused, resumed] = bodiesSince(world, since);
    expectPrefix(paused!, resumed!);
    expect(blocksOf(paused!)).toEqual([blockAt('glm-5.1', 600)]);
    expect(blocksOf(resumed!)).toEqual([blockAt('glm-5.1', 600)]); // a hora da decisão não entra: a execução inteira enxerga a mesma
    expect(await storedBlock(world, runId)).toBe(blockAt('glm-5.1', 600));
  });

  it('A4 (bot): "Tentar novamente" grava o bloco da execução nova, com a hora e o modelo dela, e a rodada seguinte leva o da execução mais recente', async () => {
    startAt(900);
    const bot = await world.createBot();
    const failed = await world.send(bot, '[falha] provedor fora do ar');
    await world.waitForStatus(failed, 'failed');
    expect(await storedBlock(world, failed)).toBe(blockAt('glm-5.1', 900));

    advance(45);
    await world.conversations.setPreference(bot.id, 'opencode/deepseek-v4.1-flash', null);
    const retry = await world.conversations.retry(bot.id, failed);
    await world.waitForStatus(retry.id, 'completed'); // com o cartão da falha no histórico o modelo falso responde: a repetição conclui
    expect(await storedBlock(world, retry.id)).toBe(blockAt('deepseek-v4.1-flash', 945));
    expect(await storedBlock(world, failed)).toBe(blockAt('glm-5.1', 900)); // a execução original não é reescrita

    advance(10);
    await world.conversations.setPreference(bot.id, 'opencode/glm-5.1', null);
    const since = world.conversationRequests().length;
    await say(world, bot, 'oi de novo');
    const [request] = bodiesSince(world, since);
    // A rodada que falhou entra com o bloco da repetição (a execução mais recente dela), nunca o da primeira tentativa; a nova leva o dela.
    expect(openingOf(request!, '[falha] provedor fora do ar')).toBe(`${blockAt('deepseek-v4.1-flash', 945)}[falha] provedor fora do ar`);
    expect(openingOf(request!, 'oi de novo')).toBe(`${blockAt('glm-5.1', 955)}oi de novo`);
  });

  it('A4 (bot): uma execução mais nova que termina sem primeira preparação (falha ou parada) não tira da rodada o bloco que a anterior gravou, e o prefixo do pedido seguinte é exato', async () => {
    startAt(1050);
    const { pool } = world;
    const bot = await world.createBot();
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    const first = await say(world, bot, 'primeira');
    advance(10);
    const since = world.conversationRequests().length;
    await say(world, bot, 'segunda');
    const [previous] = bodiesSince(world, since);
    expect(openingOf(previous!, 'primeira')).toBe(`${blockAt('glm-5.1', 1050)}primeira`); // o pedido de referência: a rodada leva o bloco da execução dela

    // Duas execuções MAIS NOVAS (maior id) sobre a mesma mensagem que terminaram antes da primeira preparação, então não gravaram bloco: uma falhou e outra foi parada.
    const trigger = (await pool.query<{ id: string }>('SELECT trigger_message_id::text AS id FROM runs WHERE id = $1', [first])).rows[0]!.id;
    const withoutBlock: string[] = [];
    for (const [status, failureCode] of [['failed', 'PROVIDER_NOT_CONFIGURED'], ['interrupted', null]] as const) {
      withoutBlock.push((await pool.query<{ id: string }>(
        `INSERT INTO runs (conversation_id, bot_id, status, input, trigger_message_id, failure_code, stop_requested_at, created_at, finished_at)
         VALUES ($1, $2, $3, 'primeira', $4, $5, CASE WHEN $3 = 'interrupted' THEN now() END, now(), now()) RETURNING id::text`,
        [conversationId, bot.id, status, trigger, failureCode],
      )).rows[0]!.id);
    }
    for (const id of withoutBlock) expect(await storedBlock(world, id)).toBeNull();
    expect(await storedBlock(world, first)).toBe(blockAt('glm-5.1', 1050));

    advance(10);
    const sinceNext = world.conversationRequests().length;
    await say(world, bot, 'terceira');
    const [next] = bodiesSince(world, sinceNext);
    // A rodada continua com o bloco da execução que o gravou (não perde o bloco nem vira o de uma execução sem ele) e o pedido anterior segue prefixo exato do novo.
    expect(openingOf(next!, 'primeira')).toBe(`${blockAt('glm-5.1', 1050)}primeira`);
    expect(openingOf(next!, 'terceira')).toBe(`${blockAt('glm-5.1', 1070)}terceira`);
    expectPrefix(previous!, next!);
  });

  it('A4 (Chat geral): "Gerar outra resposta" e a troca de versão levam o bloco da execução em vigor no caminho ativo', async () => {
    startAt(1200);
    const ref = await openSession(world);
    const r1 = await say(world, ref, 'm1');
    advance(60);
    const regenerated = await world.conversations.regenerate(ref, r1);
    await world.waitForStatus(regenerated.id, 'completed');
    const [block1, block1b] = [blockAt('glm-5.1', 1200), blockAt('glm-5.1', 1260)];
    expect([await storedBlock(world, r1), await storedBlock(world, regenerated.id)]).toEqual([block1, block1b]);
    /** O último pedido ao provedor (cada envio abaixo faz uma única chamada). */
    const lastRequest = (): ModelBody => bodiesSince(world, world.conversationRequests().length - 1)[0]!;

    // A resposta em vigor é a gerada agora: m2 pende dela, e o pedido leva o bloco dela na rodada de m1.
    advance(5);
    await say(world, ref, 'm2');
    expect(openingOf(lastRequest(), 'm1')).toBe(`${block1b}m1`);

    // Voltar à primeira resposta (m2 sai do caminho): a rodada de m1 volta a levar o bloco da primeira execução.
    await world.conversations.chooseVersion(ref, { runId: r1 });
    advance(5);
    await say(world, ref, 'm3');
    expect(openingOf(lastRequest(), 'm1')).toBe(`${block1}m1`);
    expect(openingOf(lastRequest(), 'm2')).toBe('');

    // E de volta à gerada: o caminho com m2 reaparece e m1 leva de novo o bloco da execução gerada.
    await world.conversations.chooseVersion(ref, { runId: regenerated.id });
    advance(5);
    await say(world, ref, 'm4');
    expect(openingOf(lastRequest(), 'm1')).toBe(`${block1b}m1`);
    expect(blocksOf(lastRequest())).toHaveLength(3); // m1, m2 e m4 (m3 está noutro ramo)
    expect(openingOf(lastRequest(), 'm3')).toBe('');
  });

  it('A5: rodadas gravadas antes da migration entram sem bloco, nenhuma linha antiga muda e a execução em andamento no deploy recebe o bloco na próxima preparação', async () => {
    startAt(1500);
    const { pool } = world;
    const bot = await world.createBot();
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    // Duas rodadas como o banco as tinha antes da 0044: execução concluída sem bloco e a pergunta e a resposta gravadas.
    for (const text of ['pergunta antiga 1', 'pergunta antiga 2']) {
      const run = (await pool.query<{ id: string }>("INSERT INTO runs (conversation_id, bot_id, status, input, created_at, started_at, finished_at) VALUES ($1, $2, 'completed', $3, now(), now(), now()) RETURNING id::text", [conversationId, bot.id, text])).rows[0]!.id;
      const asked = (await pool.query<{ id: string }>("INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, created_at) VALUES ($1, $2, 'user', 'text', 'done', true, $3, now()) RETURNING id::text", [conversationId, run, text])).rows[0]!.id;
      await pool.query('UPDATE runs SET trigger_message_id = $2 WHERE id = $1', [run, asked]);
      await pool.query("INSERT INTO messages (conversation_id, run_id, role, kind, status, step, content, evidence_provenance, created_at) VALUES ($1, $2, 'assistant', 'text', 'done', 1, $3, '{\"attachments\":[],\"tables\":[]}'::jsonb, now())", [conversationId, run, `resposta de ${text}`]);
    }
    const snapshot = async () => ({
      messages: (await pool.query('SELECT to_jsonb(m) AS row FROM messages m WHERE conversation_id = $1 ORDER BY id', [conversationId])).rows,
      runs: (await pool.query('SELECT to_jsonb(r) AS row FROM runs r WHERE conversation_id = $1 ORDER BY id', [conversationId])).rows,
    });
    const before = await snapshot();
    expect((await pool.query('SELECT request_data FROM runs WHERE conversation_id = $1', [conversationId])).rows).toEqual([{ request_data: null }, { request_data: null }]);

    const since = world.conversationRequests().length;
    const runId = await say(world, bot, 'pergunta nova');
    const [request] = bodiesSince(world, since);
    const turns = ownerTurns(request!);
    expect(turns.slice(0, 2)).toEqual(['pergunta antiga 1', 'pergunta antiga 2']); // sem bloco, como antes
    expect(turns[2]).toBe(`${blockAt('glm-5.1', 1500)}pergunta nova`);
    // Nenhuma linha antiga mudou (mensagens e execuções), e só a execução nova tem bloco.
    const after = await snapshot();
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(after.runs.slice(0, before.runs.length)).toEqual(before.runs);
    expect(after.runs).toHaveLength(before.runs.length + 1);
    expect(await storedBlock(world, runId)).toBe(blockAt('glm-5.1', 1500));

    // Execução abandonada por um worker que caiu no deploy (sem bloco): a próxima preparação o grava, na hora do domínio. A posse só vence depois de tudo montado.
    advance(30);
    const open = await world.createBot();
    const openConversation = await world.conversations.conversationIdOf(open.id);
    const abandoned = (await pool.query<{ id: string }>("INSERT INTO runs (conversation_id, bot_id, status, input, tool_calls, active_ms, lease_until, created_at, started_at) VALUES ($1, $2, 'running', 'retome isto', 0, 1000, now() + interval '1 hour', now(), now()) RETURNING id::text", [openConversation, open.id])).rows[0]!.id;
    const opening = (await pool.query<{ id: string }>("INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, created_at) VALUES ($1, $2, 'user', 'text', 'done', true, 'retome isto', now()) RETURNING id::text", [openConversation, abandoned])).rows[0]!.id;
    await pool.query('UPDATE runs SET trigger_message_id = $2 WHERE id = $1', [abandoned, opening]);
    expect(await storedBlock(world, abandoned)).toBeNull();
    const resumedSince = world.conversationRequests().length;
    await pool.query("UPDATE runs SET lease_until = now() - interval '1 minute' WHERE id = $1", [abandoned]);
    await world.waitForStatus(abandoned, 'completed');
    expect(await storedBlock(world, abandoned)).toBe(blockAt('glm-5.1', 1530));
    expect(ownerTurns(bodiesSince(world, resumedSince)[0]!)).toEqual([`${blockAt('glm-5.1', 1530)}retome isto`]);
  });

  it('A6: o bloco não está em nenhuma linha da conversa, na tela nem na busca no histórico', async () => {
    startAt(1800);
    const bot = await world.createBot();
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    const firstRun = await say(world, bot, 'Um texto qualquer para a busca');
    advance(3);
    await say(world, bot, 'outro texto');
    expect(await storedBlock(world, firstRun)).toBe(blockAt('glm-5.1', 1800));

    // Tela: o snapshot da conversa (o que a web desenha) não tem o bloco.
    const screen = JSON.stringify(await world.conversations.snapshot(bot.id));
    expect(screen).not.toMatch(/Modelo desta resposta|# Dados|# Mensagem|- Agora:/);
    // Banco: nenhuma linha de `messages` (conteúdo e dados) traz o bloco, e é de `messages` que `search_history` e `read_activity` leem.
    const leaked = await world.pool.query("SELECT count(*)::int AS total FROM messages WHERE content ~ 'Modelo desta resposta|# Dados|# Mensagem' OR data::text ~ 'Modelo desta resposta|# Dados'");
    expect(leaked.rows[0]!.total).toBe(0);
    // Busca: os termos do bloco não acham nada, e o texto da conversa continua achável.
    const search = async (query: string) => {
      const context: ToolContext = { pool: world.pool, conversationId, botId: bot.id, runId: '0', signal: new AbortController().signal, now: () => new Date() };
      const outcome = await searchHistoryTool.prepare(JSON.stringify({ query })).execute(context);
      return outcome.detail?.type === 'history_search' ? outcome.detail.hits : [];
    };
    expect(await search('Modelo desta resposta glm')).toEqual([]);
    expect(await search('Fuso America Sao Paulo Mensagem')).toEqual([]);
    expect((await search('Um texto qualquer para a busca')).length).toBeGreaterThan(0);
  });
});

describe('A2: modelo e hora mudam no meio da execução e o bloco gravado continua o mesmo', () => {
  it('a etapa seguinte reenvia o pedido anterior como prefixo exato com o modelo e a hora da primeira etapa; o modelo novo aparece no bloco da próxima rodada', async () => {
    let clock = BASE;
    const holder: { world?: RunsWorld; botId?: string } = {};
    // A ferramenta troca o modelo da conversa e adianta o relógio entre a primeira etapa (que a pede) e a segunda (a resposta final).
    const switching: ToolHandler = {
      definition: { name: 'search_history', description: 'troca o modelo e adianta a hora no meio da execução', parameters: { type: 'object' } },
      external: false,
      prepare: () => ({
        label: 'Troca de modelo',
        execute: async () => {
          clock = new Date(clock.getTime() + minutes(30));
          await holder.world!.conversations.setPreference(holder.botId!, 'opencode/deepseek-v4.1-flash', null);
          return { result: 'ok' };
        },
      }),
    };
    const world = await createRunsWorld({ now: () => clock, tools: [switching] });
    holder.world = world;
    try {
      world.engine.start();
      const bot = await world.createBot({ model: 'opencode/glm-5.1' });
      holder.botId = bot.id;
      const since = world.conversationRequests().length;
      const runId = await say(world, bot, '[pesquisar:x] troque no meio');
      const [one, two] = bodiesSince(world, since);
      expect(world.conversationRequests().map((request) => request.model)).toEqual(['glm-5.1', 'deepseek-v4.1-flash']); // o modelo mudou de fato
      expectPrefix(one!, two!);
      expect(blocksOf(two!)).toEqual([blockAt('glm-5.1', 0)]); // 30 minutos e outro modelo depois, o bloco segue o da primeira preparação
      expect(await storedBlock(world, runId)).toBe(blockAt('glm-5.1', 0));

      // A rodada seguinte já é do modelo novo: o bloco dela diz isso, e o da rodada anterior segue com o modelo e a hora de antes.
      const next = world.conversationRequests().length;
      await say(world, bot, 'e agora?');
      const [third] = bodiesSince(world, next);
      expect(blocksOf(third!)).toEqual([blockAt('glm-5.1', 0), blockAt('deepseek-v4.1-flash', 30)]);
      expect(third!.messages.slice(0, two!.messages.length)).toEqual(two!.messages);
    } finally {
      await world.cleanup();
    }
  });
});

describe('A3: posse retomada por outro worker', () => {
  it('o pedido depois do reinício é igual ao do trecho que caiu e o bloco continua o da primeira preparação, mesmo duas horas depois', async () => {
    let clock = BASE;
    const world = await createRunsWorld({ now: () => clock });
    try {
      const bot = await world.createBot();
      const runId = await world.send(bot, '[lento] retomar depois do reinício');
      world.engine.start();
      await waitFor('texto parcial', async () => (await world.timeline(bot)).find((entry) => entry.status === 'streaming' && entry.content !== ''));
      const stored = await storedBlock(world, runId);
      expect(stored).toBe(blockAt('glm-5.1', 0));
      await world.engine.stop(); // worker A encerra no meio do streaming

      clock = new Date(clock.getTime() + minutes(120));
      const engineB = world.createEngine();
      engineB.start();
      try {
        await world.waitForStatus(runId, 'completed');
      } finally {
        await engineB.stop();
      }
      const [aborted, resumed] = bodiesSince(world, 0);
      expect(world.conversationRequests()).toHaveLength(2);
      expect(resumed!.messages).toEqual(aborted!.messages); // a etapa é refeita do zero com exatamente o mesmo pedido
      expect(resumed!.tools).toEqual(aborted!.tools);
      expect(blocksOf(resumed!)).toEqual([blockAt('glm-5.1', 0)]);
      expect(await storedBlock(world, runId)).toBe(stored);
    } finally {
      await world.cleanup();
    }
  });
});

describe('A6: entrada do resumo da compactação', () => {
  it('o histórico coberto vai ao resumo sem o bloco, e o pedido seguinte leva o bloco só das aberturas que continuam íntegras', async () => {
    const world = await createRunsWorld();
    try {
      await world.models.test('opencode/glm-5.1');
      const bot = await world.createBot();
      const summaries: ChatRequest[] = [];
      const mains: ChatRequest[] = [];
      const checkpoint = SUMMARY_SECTIONS.map((title, index) => `## ${title}\n${index === 0 ? 'Checkpoint do histórico antigo.' : 'Nada.'}`).join('\n\n');
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        const summary = request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS;
        (summary ? summaries : mains).push(request);
        yield { type: 'text', text: summary ? checkpoint : 'Ok.' };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      await say(world, bot, 'Pedido anterior'); // a execução grava o bloco desta rodada
      // Histórico antigo grande depois dela: o trecho final fica com o que vem por último e o lote cobre a rodada que tem bloco.
      for (let index = 0; index < 5; index += 1) await world.pool.query("INSERT INTO messages(conversation_id, role, kind, status, opens_round, content, created_at) VALUES($1, 'user', 'text', 'done', true, $2, now())", [conversationId, `Histórico ${index}: ${'a'.repeat(4000)}`]);
      await say(world, bot, 'Pedido atual');
      expect((await world.pool.query<{ total: number }>('SELECT count(*)::int AS total FROM runs WHERE request_data IS NOT NULL AND conversation_id = $1', [conversationId])).rows[0]!.total).toBe(2);

      const state = await world.conversations.contextState(bot.id);
      const requestId = randomUUID();
      await world.conversations.maintainContext(bot.id, { requestId, mode: 'summarize', expectedRevision: state.revision }, randomUUID());
      const maintenance = (await world.pool.query<{ id: string }>('SELECT id::text FROM runs WHERE context_operation_id = $1', [requestId])).rows[0]!.id;
      await world.waitForStatus(maintenance, 'completed');
      expect(summaries.length).toBeGreaterThanOrEqual(1);
      const input = JSON.stringify(summaries.map((request) => request.turns));
      expect(input).toContain('Pedido anterior'); // a rodada que tinha bloco foi para o resumo...
      expect(input).not.toMatch(/Modelo desta resposta|# Dados|# Mensagem|- Agora:|Fuso:/); // ...sem ele

      // Depois do checkpoint, o pedido seguinte leva o bloco das aberturas que seguem íntegras (a atual e a nova), e o da rodada coberta saiu junto com ela.
      await say(world, bot, 'Pedido depois');
      const users = mains.at(-1)!.turns.filter((turn) => turn.role === 'user').map((turn) => turn.text);
      expect(users.some((text) => text.includes('# Resumo derivado'))).toBe(true);
      expect(users.some((text) => text.includes('Pedido anterior'))).toBe(false);
      expect(users.filter((text) => text.startsWith('# Dados')).map((text) => text.replace(HEADER, '').replace(/^\[Evidência do dono: messageId=\d+\]\n\n/, ''))).toEqual(['Pedido atual', 'Pedido depois']);
    } finally {
      vi.restoreAllMocks();
      await world.cleanup();
    }
  }, 60_000);
});

describe('migration 0044', () => {
  it('é aditiva (execuções antigas ficam intactas e nulas), o CHECK limita o tamanho e o rollback remove só a coluna e é repetível', async () => {
    const database = await createTestDatabase(inject('adminDatabaseUrl'));
    const pool = createPool(database.url, { applicationName: 'request-data-migration', max: 2 });
    try {
      const migration = MIGRATIONS.find((candidate) => candidate.id === '0044_run_request_data')!;
      const upTo = MIGRATIONS.filter((candidate) => candidate.id <= migration.id);
      await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
      const hasColumn = async () => ((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'request_data'")).rowCount ?? 0) > 0;
      // Banco de produção antes da 0044: uma sessão com uma execução concluída.
      const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
      await pool.query("INSERT INTO runs (conversation_id, status, input, created_at) VALUES ($1, 'completed', 'antiga', now())", [conversation]);
      const before = (await pool.query('SELECT to_jsonb(r) AS row FROM runs r')).rows;
      expect(await hasColumn()).toBe(false);

      // Aditiva: a coluna nasce nula e nada do que já existia muda; subir de novo não faz nada, e o SQL em si também é repetível.
      expect(await migrateTestDatabase(pool, { migrations: upTo })).toEqual([migration.id]);
      expect(await hasColumn()).toBe(true);
      expect((await pool.query("SELECT to_jsonb(r) - 'request_data' AS row, request_data FROM runs r")).rows).toEqual(before.map((entry) => ({ ...entry, request_data: null })));
      expect(await migrateTestDatabase(pool, { migrations: upTo })).toEqual([]);
      await pool.query(migration.up);

      // O CHECK aceita nulo e de 1 a 2.000 caracteres e recusa vazio e 2.001.
      for (const accepted of ['# Dados\n- Modelo desta resposta: glm-5.1\n\n# Mensagem\n', 'a'.repeat(2000), null]) await pool.query('UPDATE runs SET request_data = $1', [accepted]);
      for (const refused of ['', 'a'.repeat(2001)]) await expect(pool.query('UPDATE runs SET request_data = $1', [refused])).rejects.toThrow(/request_data/);

      // Rollback: remove só a coluna (idempotente); a execução segue como estava e subir de novo a recria nula.
      await pool.query("UPDATE runs SET request_data = 'bloco'");
      await pool.query(migration.rollback);
      await pool.query(migration.rollback);
      await pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
      expect(await hasColumn()).toBe(false);
      expect((await pool.query('SELECT to_jsonb(r) AS row FROM runs r')).rows).toEqual(before);
      expect(await migrateTestDatabase(pool, { migrations: upTo })).toEqual([migration.id]);
      expect((await pool.query('SELECT request_data FROM runs')).rows).toEqual([{ request_data: null }]);
    } finally {
      await pool.end();
      await database.drop();
    }
  });
});

describe('limpeza fria e bloco de dados (phase 11, T7; PERF-01)', () => {
  it('a limpeza fria troca só o resultado antigo: cada rodada mantém o bloco que levou, a rodada nova leva o da hora dela e o pedido anterior segue prefixo do seguinte', async () => {
    let clock = BASE;
    // `search_history` de teste: a consulta "g1" devolve um resultado grande (acima do limiar de 1.000 caracteres do mascaramento).
    const bigTool: ToolHandler = {
      definition: { name: 'search_history', description: 'resultado grande sintético', parameters: { type: 'object' } },
      external: false,
      prepare: () => ({ label: 'Buscar', execute: async () => ({ result: `g1: ${'linha de dado gravada. '.repeat(90)}` }) }),
    };
    const world = await createRunsWorld({ now: () => clock, tools: [bigTool] });
    try {
      world.engine.start();
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const since = world.conversationRequests().length;
      await say(world, bot, '[pesquisar:g1] procure'); // duas etapas: a ferramenta e a resposta
      clock = new Date(clock.getTime() + minutes(1));
      await say(world, bot, 'e agora?');
      clock = new Date(clock.getTime() + minutes(1));
      await say(world, bot, 'obrigado');
      const before = bodiesSince(world, since);
      const prior = before.at(-1)!;
      expect(blocksOf(prior)).toEqual([blockAt('glm-5.1', 0), blockAt('glm-5.1', 1), blockAt('glm-5.1', 2)]);

      // A conversa esfria (mais de 40 minutos sem chamada): só o resultado grande da rodada 1, fora das 2 rodadas recentes, é mascarado.
      clock = new Date(BASE.getTime() + minutes(100));
      expect(await maskColdResults(world.pool, { conversationId, now: clock, origin: 'sweep', logger: world.logger })).toBe(1);
      const next = world.conversationRequests().length;
      await say(world, bot, 'mais uma');
      const [request] = bodiesSince(world, next) as [ModelBody];
      // Os turnos do dono (cada um com o bloco que a execução dele gravou, na hora dele) são byte a byte os do pedido anterior; a rodada nova leva o bloco da hora em que abriu.
      expect(ownerTurns(request).slice(0, ownerTurns(prior).length)).toEqual(ownerTurns(prior));
      expect(blocksOf(request)).toEqual([blockAt('glm-5.1', 0), blockAt('glm-5.1', 1), blockAt('glm-5.1', 2), blockAt('glm-5.1', 100)]);
      // Só o turno de resultado da ferramenta mudou (virou o marcador); mensagens do dono e respostas do bot são as mesmas, na mesma ordem.
      const changed = request.messages.slice(0, prior.messages.length).filter((turn, index) => JSON.stringify(turn) !== JSON.stringify(prior.messages[index]));
      expect(changed.map((turn) => turn.role)).toEqual(['tool']);
      expect(changed[0]!.content).toMatch(/^\[resultado de search_history, [\d.]+ caracteres, #\d+; releia com read_activity\]$/);
    } finally {
      await world.cleanup();
    }
  });
});
