// Prova do motor de execução (A5, A6, A7; F6 e F7) contra PostgreSQL real e o provedor falso: uma mensagem vira execução, o
// texto chega aos poucos e fica persistido, a fila do bot é FIFO e bots diferentes rodam em paralelo, a parada e os limites
// encerram com cartão, uma execução abandonada é retomada do ponto em que parou e as falhas do provedor viram cartão com
// "tentar novamente". O provedor falso roteia cada resposta por marcadores no texto da mensagem (ver fake-upstreams.ts).
import { hasModelProvider, type CardView } from '@aion/shared';
import { getEventListeners } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../db/pool';
import { DomainError } from '../errors';
import { LeaseLostError, holdLease } from './lease';
import { TextWriter } from './text-writer';
import { ToolFailure, type ToolHandler } from './tools';
import type { ProviderClient } from '../credentials/opencode-go';
import { RunEngine } from './engine';
import { MIGRATIONS } from '../db/migrations';
import { FAST_ENGINE, ORIGIN, createRunsWorld, waitFor, type RunsWorld, type RunsWorldOptions } from './test-support';
import { randomUUID } from 'node:crypto';
import { SUMMARY_SECTIONS } from './compaction';
import { SUMMARY_MAX_OUTPUT_TOKENS } from './context-budget';
import { contextFingerprint, loadManagedContext } from './context-checkpoint';
import type { ChatRequest } from '../models/chat-protocols';
import { modelCallReasoningMigration } from '../db/migrations/0045_model_call_reasoning';
import { PushService } from '../push/service';
import { RECENT_MODELS_SCAN_RUNS } from '../models/service';

/** Mundo de teste de um bloco: sobe no `beforeAll` e cai no `afterAll`. */
function useWorld(options: RunsWorldOptions = {}): () => RunsWorld {
  let world: RunsWorld;
  beforeAll(async () => {
    world = await createRunsWorld(options);
  });
  afterAll(async () => {
    await world.cleanup();
  });
  return () => world;
}

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `INESPERADO:${String(error)}`;
  }
};

/** Linhas da conversa reduzidas a "tipo:papel:estado:conteúdo" (legível nas afirmações). */
const shape = (entries: { kind: string; role: string; status: string; content: string }[]) =>
  entries.map((entry) => `${entry.kind}:${entry.role}:${entry.status}:${entry.content}`);

describe('uma mensagem vira execução com streaming persistido', () => {
  const w = useWorld();

  it('a mensagem espera na fila fora da linha do tempo, o texto chega por pedaços gravados e o log de eventos o reproduz', async () => {
    const { conversations, engine, pool } = w();
    const bot = await w().createBot();
    const runId = await w().send(bot, '[lento] conte até oito');

    // Antes de começar: a execução está na fila com o texto, e a linha do tempo ainda não tem a mensagem.
    const queued = await conversations.snapshot(bot.id);
    expect(queued.items).toEqual([]);
    expect(queued.runs).toMatchObject([{ id: runId, status: 'queued', input: '[lento] conte até oito', toolCalls: 0 }]);
    expect(queued).toMatchObject({ providerConfigured: true, model: { model: 'opencode/glm-5.1', effort: null }, hasMore: false });

    engine.start();
    // Streaming: num instante a resposta existe só pela metade, já gravada e marcada `streaming`.
    const partial = await waitFor('texto parcial gravado', async () =>
      (await w().timeline(bot)).find((entry) => entry.role === 'assistant' && entry.status === 'streaming' && entry.content !== ''),
    );
    expect(partial.content).toMatch(/^parte1 /);
    expect(partial.content).not.toContain('parte8');
    await w().waitForStatus(runId, 'completed');

    expect(shape(await w().timeline(bot))).toEqual([
      'text:user:done:[lento] conte até oito',
      'text:assistant:done:parte1 parte2 parte3 parte4 parte5 parte6 parte7 parte8 ',
    ]);
    // A mensagem do dono entrou na linha do tempo ao começar a execução, abrindo a rodada e ligada a ela.
    const opener = await pool.query<{ opens_round: boolean; run_id: string }>("SELECT opens_round, run_id::text FROM messages WHERE role = 'user'");
    expect(opener.rows).toEqual([{ opens_round: true, run_id: runId }]);

    const done = await conversations.snapshot(bot.id);
    expect(done.runs).toEqual([]);
    expect(done.items.map((item) => item.kind)).toEqual(['text', 'text']);

    // O log de eventos é de invalidação: uma atualização por linha, sempre com o estado ATUAL, e muitos eventos no texto.
    const conversationId = await conversations.conversationIdOf(bot.id);
    const { updates, cursor } = await conversations.updatesSince(conversationId, '0');
    const assistant = updates.find((update) => update.event === 'message' && 'role' in update.data && update.data.role === 'assistant');
    expect(assistant?.data).toMatchObject({ kind: 'text', status: 'done', content: expect.stringContaining('parte8') });
    expect(updates.find((update) => update.event === 'run')?.data).toMatchObject({ id: runId, status: 'completed', input: null });
    expect(updates).toHaveLength(4); // dono, resposta, execução e medição/usage, cada entidade uma vez
    expect(updates.filter((update)=>update.event==='context')).toHaveLength(1);
    const bursts = await pool.query<{ total: string }>("SELECT count(*) AS total FROM conversation_events WHERE kind = 'message' AND ref = $1", [assistant?.event === 'message' ? assistant.data.id : undefined]);
    expect(Number(bursts.rows[0]?.total)).toBeGreaterThan(3);

    // Retomar do cursor: nada novo; uma nova mensagem traz só o que mudou depois dele.
    expect((await conversations.updatesSince(conversationId, cursor)).updates).toEqual([]);
    await w().send(bot, 'depois');
    await waitFor('segunda resposta', async () => (await w().timeline(bot)).length === 4 && (await w().timeline(bot)).every((entry) => entry.status === 'done'));
    const after = await conversations.updatesSince(conversationId, cursor);
    expect(after.updates.map((update) => update.event).sort()).toEqual(['context','message', 'message', 'run']);
  });
});

describe('cache de prompt e log de uso por etapa', () => {
  const w = useWorld();

  it('fixa o sistema mesmo após edit_memory, persiste a memória e registra só números dos três protocolos', async () => {
    const world = w();
    const log = vi.spyOn(world.logger, 'info');
    world.engine.start();
    for (const [model, protocol] of [['opencode/glm-5.1', 'chat_completions'], ['opencode/kimi-k2.7-code', 'messages'], ['opencode/grok-4.7', 'responses']]) {
      const bot = await world.createBot({ model });
      const since = world.upstreams.requests.length;
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const runId = await world.send(bot, '[memoria:conteudo-privado-cache] anote');
      await world.waitForStatus(runId, 'completed');
      const requests = world.upstreams.requests.slice(since).filter((request) => request.sessionId === conversationId);
      expect(requests).toHaveLength(2);
      // No messages o `system` é lista de blocos com `cache_control` (phase 12, A9): o texto é o dos blocos juntos.
      const system = (body: Record<string, unknown> | undefined) => protocol === 'chat_completions' ? (body?.messages as { content: string }[])[0]?.content : protocol === 'messages' ? (body?.system as { text: string }[]).map((block) => block.text).join('') : body?.instructions;
      expect(system(requests[1]?.body)).toBe(system(requests[0]?.body));
      expect(system(requests[0]?.body)).not.toContain('conteudo-privado-cache');
      expect(requests[1]?.body && JSON.stringify(requests[1].body)).toContain('Memória atualizada');
      expect((await world.pool.query('SELECT content FROM bot_memories WHERE bot_id = $1', [bot.id])).rows[0]?.content).toContain('conteudo-privado-cache');
      const entries = log.mock.calls.filter((call) => call[1] === 'uso de tokens do modelo' && (call[0] as { runId?: string }).runId === runId);
      expect(entries).toHaveLength(2);
      expect(entries.map((call) => call[0])).toEqual([1, 2].map((step) => ({ runId, step, model, protocol, inputTokens: 100, cachedTokens: 80, outputTokens: 2, cachedFraction: 0.8 })));
      expect(JSON.stringify(entries)).not.toContain('conteudo-privado-cache');
    }
    log.mockRestore();
  });

  it('sem usage a etapa conclui e o log omite os números', async () => {
    const world = w();
    const bot = await world.createBot();
    const original = world.provider.streamChat.bind(world.provider);
    // Provedor que entrega texto/ferramentas normalmente, mas omite apenas a telemetria opcional.
    const stream = vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (...args) {
      for await (const event of original(...args)) if (event.type !== 'usage') yield event;
    });
    const log = vi.spyOn(world.logger, 'info');
    try {
      const runId = await world.send(bot, 'texto-privado-sem-usage');
      await world.waitForStatus(runId, 'completed');
      const entries = log.mock.calls.filter((call) => call[1] === 'uso de tokens do modelo' && (call[0] as { runId?: string }).runId === runId);
      expect(entries.map((call) => call[0])).toEqual([{ runId, step: 1, model: 'opencode/glm-5.1', protocol: 'chat_completions' }]);
      expect(JSON.stringify(entries)).not.toContain('texto-privado-sem-usage');
    } finally { stream.mockRestore(); log.mockRestore(); }
  });
});

describe('fila do bot e paralelismo', () => {
  const w = useWorld();

  it('mensagens do mesmo bot rodam uma de cada vez, em ordem, e bots diferentes rodam ao mesmo tempo', async () => {
    const { engine, conversations } = w();
    const a = await w().createBot();
    const b = await w().createBot();
    const a1 = await w().send(a, '[lento] a1');
    const a2 = await w().send(a, 'a2');
    const a3 = await w().send(a, 'a3');
    const b1 = await w().send(b, '[lento] b1');
    expect((await conversations.snapshot(a.id)).runs.map((run) => run.status)).toEqual(['queued', 'queued', 'queued']);

    engine.start();
    // Paralelo: as duas execuções lentas (de bots diferentes) estão `running` ao mesmo tempo.
    await waitFor('a1 e b1 rodando juntas', async () => (await w().runRow(a1)).status === 'running' && (await w().runRow(b1)).status === 'running');
    // FIFO: enquanto a1 roda, a2 e a3 seguem na fila e só uma execução do bot A está ativa.
    expect(await Promise.all([a2, a3].map(async (id) => (await w().runRow(id)).status))).toEqual(['queued', 'queued']);
    const visible = await conversations.snapshot(a.id);
    expect(visible.runs.map((run) => run.status)).toEqual(['running', 'queued', 'queued']);

    await w().waitForStatus(a3, 'completed');
    await w().waitForStatus(b1, 'completed');
    // Sem intercalar: cada resposta vem logo depois da sua pergunta, na ordem de envio.
    expect((await w().timeline(a)).map((entry) => `${entry.role}:${entry.content.slice(0, 13)}`)).toEqual([
      'user:[lento] a1',
      'assistant:parte1 parte2',
      'user:a2',
      'assistant:Resposta: a2',
      'user:a3',
      'assistant:Resposta: a3',
    ]);
    expect((await conversations.snapshot(a.id)).runs).toEqual([]);
  });

  it('o índice do banco impede duas execuções ativas do mesmo bot, mesmo fora do motor', async () => {
    const { pool } = w();
    const bot = await w().createBot();
    const conversation = await pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id]);
    const insert = () =>
      pool.query("INSERT INTO runs (conversation_id, bot_id, status, input, created_at) VALUES ($1, $2, 'running', 'x', now())", [conversation.rows[0]?.id, bot.id]);
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505', constraint: 'runs_one_active_per_bot' });
  });
});

describe('teto da fila do bot', () => {
  const w = useWorld();

  it('recusa a 21ª mensagem da fila do bot com QUEUE_FULL, sem afetar outros bots', async () => {
    const bot = await w().createBot();
    for (let index = 1; index <= 20; index += 1) await w().send(bot, `mensagem ${index}`);
    expect(await codeOf(w().send(bot, 'mensagem 21'))).toBe('QUEUE_FULL');
    const other = await w().createBot();
    expect(await codeOf(w().send(other, 'outro bot não é afetado'))).toBe('OK');
    expect((await w().conversations.snapshot(bot.id)).runs).toHaveLength(20);
  });
});

describe('limite de 60 mensagens por minuto', () => {
  let clock = new Date('2026-03-01T12:00:00Z');
  const w = useWorld({ now: () => clock });

  it('recusa a 61ª mensagem do minuto com RATE_LIMITED e volta a aceitar depois da janela', async () => {
    // Quatro bots com 15 mensagens cada: 60 aceitas sem esbarrar no teto de 20 por fila.
    const bots = await Promise.all([1, 2, 3, 4].map(() => w().createBot()));
    for (const bot of bots) for (let index = 0; index < 15; index += 1) await w().send(bot, `rajada ${index}`);

    const error = await w().conversations.send(bots[0]!.id, 'passou do limite').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: expect.any(Number) });

    clock = new Date(clock.getTime() + 61_000);
    expect(await codeOf(w().send(bots[0]!, 'janela liberada'))).toBe('OK');
  });
});

describe('parada, limites e ferramentas externas', () => {
  const w = useWorld();

  it('parar interrompe o streaming, guarda o texto parcial, grava o cartão e deixa a próxima da fila começar', async () => {
    const { engine, conversations } = w();
    const bot = await w().createBot();
    const first = await w().send(bot, '[demorar] não termino sozinho');
    const second = await w().send(bot, 'depois da parada');
    expect(await codeOf(conversations.stop(bot.id))).toBe('RUN_NOT_ACTIVE'); // só há fila: nada ativo para parar

    engine.start();
    await waitFor('texto em streaming', async () => (await w().timeline(bot)).find((entry) => entry.role === 'assistant' && entry.content.includes('passo 2')));
    const requested = await conversations.stop(bot.id);
    expect(requested).toMatchObject({ id: first, status: 'running' }); // a parada é assíncrona: o worker a lê no batimento

    await w().waitForStatus(first, 'interrupted');
    await w().waitForStatus(second, 'completed');
    const timeline = await w().timeline(bot);
    // Texto parcial concluído (não fica "streaming" para sempre), cartão de interrupção e só então a próxima mensagem.
    expect(timeline.map((entry) => `${entry.kind}:${entry.status}`)).toEqual([
      'text:done', // pergunta 1
      'text:done', // resposta parcial
      'card:done',
      'text:done', // pergunta 2
      'text:done', // resposta 2
    ]);
    expect(timeline[1]?.content).toMatch(/^passo 1 passo 2/);
    expect(timeline[2]).toMatchObject({ runId: first, data: { type: 'run_interrupted', steps: [], maybeCompleted: [] } });
    expect(timeline[4]?.content).toBe('Resposta: depois da parada');
    expect(await codeOf(conversations.stop(bot.id))).toBe('RUN_NOT_ACTIVE'); // já terminou
  });

  it('parar interrompe mesmo quando abortar a chamada ao modelo não encerra o stream: o executor para de esperar a leitura', async () => {
    const world = w();
    // Provedor que descarta o sinal de aborto, como um `fetch` cujo aborto não chega ao corpo que já está sendo lido (visto na pilha de E2E:
    // o texto seguia chegando até o fim natural do stream). O stream falso de [demorar] só acaba em 60 s, então só o executor pode encerrar.
    const ignoresAbort: ProviderClient = { ...world.provider, streamChat: (apiKey, protocol, request) => world.provider.streamChat(apiKey, protocol, request) };
    const engine = new RunEngine({ pool: world.pool, credentials: world.credentials, provider: ignoresAbort, models: world.models, logger: world.logger, config: FAST_ENGINE });
    const bot = await world.createBot();
    const run = await world.send(bot, '[demorar] não termino sozinho');
    engine.start();
    try {
      await waitFor('texto em streaming', async () => (await world.timeline(bot)).find((entry) => entry.role === 'assistant' && entry.content.includes('passo 2')));
      const requestedAt = Date.now();
      await world.conversations.stop(bot.id);
      await world.waitForStatus(run, 'interrupted', 5_000);
      expect(Date.now() - requestedAt).toBeLessThan(5_000);
      const timeline = await world.timeline(bot);
      expect(timeline.at(-1)).toMatchObject({ runId: run, kind: 'card', data: { type: 'run_interrupted' } });
      expect(timeline.find((entry) => entry.role === 'assistant')?.status).toBe('done'); // o texto parcial não fica "streaming" para sempre
    } finally {
      await engine.stop();
    }
  });

  it('o limite de chamadas de ferramenta encerra com o relatório do que foi concluído e não executa a chamada que passaria dele', async () => {
    const bot = await w().createBot({ stepLimit: 2 });
    const runId = await w().send(bot, '[loop] sem parar');
    w().engine.start();
    await w().waitForStatus(runId, 'limit_reached');

    const timeline = await w().timeline(bot);
    const activities = timeline.filter((entry) => entry.kind === 'activity');
    expect(activities.map((entry) => entry.status)).toEqual(['completed', 'completed']);
    const card = timeline.at(-1) as unknown as { kind: string; content: string; data: CardView['card'] };
    expect(card.data).toEqual({ type: 'run_limit', limit: 'steps', steps: ['Pesquisou no histórico: loop', 'Pesquisou no histórico: loop'] });
    expect(card.content).toContain('Limite de chamadas de ferramenta atingido');
    expect(await w().runRow(runId)).toMatchObject({ status: 'limit_reached', tool_calls: 2 });
  });

  it('uma ferramenta externa não é esperada nem desfeita na parada: o cartão avisa que pode ter sido concluída', async () => {
    // Ferramenta que nunca responde, com o nome que o modelo falso chama; externa como as do Composio, ou seja, com a `action` que a
    // liga ao portão de aprovação (uma externa sem `action` nem executa, ver o teste do R4 em approvals.test.ts).
    const execute = vi.fn(() => new Promise<never>(() => undefined));
    const hanging: ToolHandler = {
      definition: { name: 'search_history', description: 'externa de teste', parameters: { type: 'object' } },
      external: true,
      action: { slug: 'search_history', label: 'Enviar e-mail · Gmail', appSlug: 'gmail', appName: 'Gmail' },
      prepare: () => ({ label: 'Enviar e-mail · Gmail', execute }),
    };
    const world = await createRunsWorld({ tools: [hanging] });
    try {
      // Regra global permitir: a chamada passa pelo portão sem pausar para aprovação e fica pendurada na ferramenta.
      await world.pool.query(
        `INSERT INTO approval_actions (slug, app_slug, app_name, label, global_rule, first_seen_at, last_seen_at)
         VALUES ('search_history', 'gmail', 'Gmail', 'Enviar e-mail · Gmail', 'allow', now(), now())`,
      );
      const bot = await world.createBot();
      const runId = await world.send(bot, '[pesquisar:x] dispare');
      world.engine.start();
      // A atividade fica `running` antes da auditoria obrigatória e do disparo. Só a entrada na ferramenta prova que a parada
      // interrompe uma ação já enviada, cujo efeito externo pode ter ocorrido.
      await waitFor('ferramenta externa disparada', async () => execute.mock.calls.length > 0);
      await world.conversations.stop(bot.id);
      await world.waitForStatus(runId, 'interrupted');

      const timeline = await world.timeline(bot);
      expect(timeline.find((entry) => entry.kind === 'activity')).toMatchObject({ status: 'failed', content: 'Interrompida pelo dono. A ação pode ter sido concluída.' });
      expect(timeline.at(-1)?.data).toEqual({ type: 'run_interrupted', steps: [], maybeCompleted: ['Enviar e-mail · Gmail'] });
      expect(timeline.at(-1)?.content).toContain('Podem ter sido concluídas: Enviar e-mail · Gmail');
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await world.cleanup();
    }
  });

  it('o limite de 15 minutos de tempo ativo (encurtado aqui) encerra como limite atingido e guarda o texto parcial', async () => {
    const world = await createRunsWorld({ engine: { maxActiveMs: 700 } });
    const originalSetTimeout = globalThis.setTimeout;
    const realNow = Date.now.bind(Date);
    const startedAt = realNow();
    let expire: (() => void) | undefined;
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    // Só o prazo da execução é controlado: HTTP, flush, batimentos e polling continuam reais. O tempo ativo anda após o texto persistir,
    // garantindo que esta prova de PRESERVAÇÃO do parcial não dependa da máquina entregar a primeira resposta em menos de 700 ms.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 700 && expire === undefined) {
        expire = () => callback(...args);
        deadlineHandle = originalSetTimeout(() => undefined, 60_000);
        return deadlineHandle;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    try {
      const bot = await world.createBot();
      const runId = await world.send(bot, '[demorar] sem fim');
      world.engine.start();
      await waitFor('texto parcial antes da expiração controlada', async () => (await world.timeline(bot)).find((entry) => entry.role === 'assistant' && entry.content.includes('passo 2')));
      expect(expire).toBeTypeOf('function');
      clock.mockReturnValue(startedAt + 700);
      expire!();
      await world.waitForStatus(runId, 'limit_reached');
      const timeline = await world.timeline(bot);
      expect(timeline.map((entry) => `${entry.kind}:${entry.status}`)).toEqual(['text:done', 'text:done', 'card:done']);
      expect(timeline.at(-1)?.data).toEqual({ type: 'run_limit', limit: 'time', steps: [] });
      expect(timeline.at(-1)?.content).toContain('tempo ativo');
      expect((await world.runRow(runId)).active_ms).toBeGreaterThanOrEqual(700);
    } finally {
      timer.mockRestore();
      clock.mockRestore();
      clearTimeout(deadlineHandle);
      await world.cleanup();
    }
  });

  it('cada ação externa remove seu listener ao terminar, inclusive quando a ação falha', async () => {
    const listeners: number[] = [];
    let signal: AbortSignal | undefined;
    const external: ToolHandler = {
      definition: { name: 'search_history', description: 'ação externa de teste', parameters: { type: 'object' } },
      external: true,
      action: { slug: 'search_history', label: 'Ação de teste', appSlug: 'test', appName: 'Teste' },
      prepare: () => ({ label: 'Ação de teste', execute: async (context) => {
        signal = context.signal;
        listeners.push(getEventListeners(signal, 'abort').length);
        if (listeners.length === 2) throw new ToolFailure('Falha esperada de teste.');
        return { result: 'ok' };
      } }),
    };
    const world = await createRunsWorld({ tools: [external] });
    try {
      await world.pool.query("INSERT INTO approval_actions (slug, app_slug, app_name, label, global_rule, first_seen_at, last_seen_at) VALUES ('search_history', 'test', 'Teste', 'Ação de teste', 'allow', now(), now())");
      const bot = await world.createBot();
      const terms = Array.from({ length: 15 }, (_, index) => `termo${index}`).join('|');
      const run = await world.send(bot, `[pesquisar:${terms}] execute`);
      world.engine.start();
      await world.waitForStatus(run, 'completed');
      expect(listeners).toHaveLength(15);
      expect(listeners.every((count) => count === 1)).toBe(true);
      expect(getEventListeners(signal!, 'abort')).toHaveLength(0);
      const activities = (await world.timeline(bot)).filter((entry) => entry.kind === 'activity');
      expect(activities.filter((entry) => entry.status === 'completed')).toHaveLength(14);
      expect(activities.filter((entry) => entry.status === 'failed')).toHaveLength(1);
    } finally {
      await world.cleanup();
    }
  });
});

describe('ferramentas do bot', () => {
  const w = useWorld();

  it('o bot recebe o erro de uma ferramenta desconhecida ou de argumentos inválidos e decide seguir; várias chamadas da mesma etapa ficam juntas', async () => {
    const { engine } = w();
    const bot = await w().createBot();
    const unknown = await w().send(bot, '[desconhecida] chame algo que não existe');
    const invalid = await w().send(bot, '[invalida] chame com argumentos quebrados');
    const several = await w().send(bot, '[pesquisar:alpha|beta|gama] procure três coisas');
    engine.start();
    await w().waitForStatus(several, 'completed');
    await w().waitForStatus(unknown, 'completed');
    await w().waitForStatus(invalid, 'completed');

    const activities = (await w().timeline(bot)).filter((entry) => entry.kind === 'activity');
    // A falha de ferramenta chega sempre no envelope único {code, message} (A21): aqui se lê o código; o texto de cada uma é provado nos testes do executor.
    const shown = (entry: { status: string; content: string }): string => (entry.status === 'failed' ? (JSON.parse(entry.content) as { code: string }).code : entry.content.slice(0, 40));
    expect(activities.map((entry) => `${entry.status}:${(entry.data as { label: string }).label}:${shown(entry)}`)).toEqual([
      'failed:nao_existe:TOOL_NOT_FOUND',
      'failed:search_history:VALIDATION_FAILED',
      'completed:Pesquisou no histórico: alpha:Nenhum trecho encontrado para "alpha".',
      'completed:Pesquisou no histórico: beta:Nenhum trecho encontrado para "beta".',
      'completed:Pesquisou no histórico: gama:Nenhum trecho encontrado para "gama".',
    ]);
    // As três da mesma etapa compartilham o número da etapa (a tela as agrupa em "3 ações executadas").
    const steps = await w().pool.query<{ step: number }>("SELECT step FROM messages WHERE kind = 'activity' AND run_id = $1 ORDER BY id", [several]);
    expect(new Set(steps.rows.map((row) => row.step))).toEqual(new Set([1]));
    expect(await w().runRow(several)).toMatchObject({ tool_calls: 3 });
  });
});

describe('retomada do ponto em que parou', () => {
  const w = useWorld();

  it('encerrar o worker no meio da resposta devolve a posse; outro worker descarta o texto parcial e refaz a etapa', async () => {
    const { engine, conversations } = w();
    const bot = await w().createBot();
    const runId = await w().send(bot, '[lento] retomar depois do reinício');
    engine.start();
    await waitFor('texto parcial', async () => (await w().timeline(bot)).find((entry) => entry.status === 'streaming' && entry.content !== ''));
    await engine.stop(); // worker A encerra no meio do streaming

    const stopped = await w().runRow(runId);
    expect(stopped.status).toBe('running'); // nada terminal foi gravado
    expect(stopped.lease_until!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000); // posse devolvida, não à espera do vencimento
    expect((await w().timeline(bot)).some((entry) => entry.status === 'streaming')).toBe(true);

    const engineB = w().createEngine();
    engineB.start();
    try {
      await w().waitForStatus(runId, 'completed');
    } finally {
      await engineB.stop();
    }

    const timeline = await w().timeline(bot);
    expect(timeline.map((entry) => `${entry.role}:${entry.status}`)).toEqual(['user:done', 'assistant:discarded', 'assistant:done']);
    expect(timeline[2]?.content).toBe('parte1 parte2 parte3 parte4 parte5 parte6 parte7 parte8 ');
    // A etapa foi refeita do zero: o texto parcial descartado não volta ao modelo.
    const resumedRequest = w().conversationRequests().at(-1)?.body?.messages as { role: string; content?: string }[];
    expect(resumedRequest.filter((turn) => !turn.content?.startsWith('# Objetivo do bot (')).map((turn) => turn.role)).toEqual(['system', 'user']);
    // O dono vê o descarte pelo mesmo caminho de tudo (evento com o estado atual da linha) e o snapshot o esconde.
    const conversationId = await conversations.conversationIdOf(bot.id);
    const { updates } = await conversations.updatesSince(conversationId, '0');
    expect(updates.some((update) => update.event === 'message' && 'kind' in update.data && update.data.kind === 'text' && update.data.status === 'discarded')).toBe(true);
    expect((await conversations.snapshot(bot.id)).items.map((item) => item.kind === 'text' && item.status)).toEqual(['done', 'done']);
    expect((await w().runRow(runId)).active_ms).toBeGreaterThan(0);
  });

  it('um worker que só travou perde a posse para quem a assumiu: para sozinho, sem registrar desfecho nem escrever mais, e o novo dono retoma', async () => {
    const { pool, conversations } = w();
    const engineA = w().createEngine();
    const bot = await w().createBot();
    const runId = await w().send(bot, '[demorar] trava e volta');
    engineA.start();
    await waitFor('texto de A', async () => (await w().timeline(bot)).find((entry) => entry.status === 'streaming' && entry.content !== ''));

    // Outro worker assumiu a execução (o dono da posse mudou) sem que A saiba: no próximo batimento A percebe e encerra por conta
    // própria. Nada do desfecho é dele (a execução segue `running`, sem cartão) e ele não escreve mais uma letra.
    await pool.query('UPDATE runs SET lease_owner = gen_random_uuid() WHERE id = $1', [runId]);
    await engineA.idle();
    await engineA.stop();
    const stalled = await w().timeline(bot);
    expect((await w().runRow(runId)).status).toBe('running');
    expect(stalled.some((entry) => entry.kind === 'card')).toBe(false);
    const frozen = stalled.find((entry) => entry.role === 'assistant')?.content;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await w().timeline(bot)).find((entry) => entry.role === 'assistant')?.content).toBe(frozen);

    // Sem ninguém renovar a posse ela vence, e o novo dono retoma: descarta o texto de A e refaz a etapa. Parar encerra.
    const engineB = w().createEngine();
    engineB.start();
    try {
      await waitFor('retomada com o texto de A descartado e um novo em andamento', async () => {
        const timeline = await w().timeline(bot);
        return timeline.some((entry) => entry.status === 'discarded') && timeline.some((entry) => entry.status === 'streaming' && entry.content !== '');
      });
      await conversations.stop(bot.id);
      await w().waitForStatus(runId, 'interrupted');
    } finally {
      await engineB.stop();
    }
  });

  it('uma chamada ao modelo que não escreve nada também percebe a perda da posse pelo batimento', async () => {
    const { pool } = w();
    // Modelo que nunca responde, já "testado" (o teste sob demanda esperaria o prazo inteiro).
    await pool.query(
      `INSERT INTO model_profiles (model_id, test_status, test_protocol, effort_levels, tested_at, created_at, updated_at)
       VALUES ('opencode/slow-model', 'ok', 'chat_completions', '{}', now(), now(), now())
       ON CONFLICT (model_id) DO UPDATE SET test_status = 'ok', test_protocol = 'chat_completions', tested_at = now()`,
    );
    const bot = await w().createBot({ model: 'opencode/slow-model' });
    await w().send(bot, 'fica sem resposta');
    const engine = w().createEngine();
    engine.start();
    try {
      await waitFor('o modelo ser chamado', async () => w().upstreams.requests.some((request) => request.model === 'slow-model' && request.body !== undefined));
      // Outro worker assumiu. Sem escrita nenhuma para falhar, só o batimento pode perceber: o executor para em instantes.
      await pool.query("UPDATE runs SET lease_owner = gen_random_uuid() WHERE bot_id = $1", [bot.id]);
      const outcome = await Promise.race([engine.idle().then(() => 'parou'), new Promise((resolve) => setTimeout(() => resolve('preso'), 3_000))]);
      expect(outcome).toBe('parou');
    } finally {
      await engine.stop();
    }
  });

  it('toda escrita do executor confere a posse: um dono antigo é recusado antes de gravar texto, atividade ou desfecho', async () => {
    const { pool } = w();
    const bot = await w().createBot();
    const conversation = await pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id]);
    const conversationId = conversation.rows[0]!.id;
    const run = await pool.query<{ id: string; lease_owner: string }>(
      `INSERT INTO runs (conversation_id, bot_id, status, input, lease_until, lease_owner, created_at)
       VALUES ($1, $2, 'running', 'x', now() + interval '1 minute', gen_random_uuid(), now()) RETURNING id, lease_owner::text`,
      [conversationId, bot.id],
    );
    const { id: runId, lease_owner: owner } = run.rows[0]!;
    const held = (token: string) => withTransaction(pool, (tx) => holdLease(tx, runId, token));

    await expect(held(owner)).resolves.toBeUndefined();
    await expect(held('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(LeaseLostError);

    // O TextWriter de um dono antigo não grava nada: a escrita falha na conferência e o erro aparece ao fechar.
    const stale = new TextWriter({ pool, conversationId, runId, owner: '00000000-0000-4000-8000-000000000000', step: 1, flushMs: 5, now: () => new Date() });
    stale.push('texto de quem perdeu a posse');
    await expect(stale.finish()).rejects.toBeInstanceOf(LeaseLostError);
    expect((await w().timeline(bot)).length).toBe(0);

    // Execução que já terminou não tem dono: nem o antigo token vale mais.
    await pool.query("UPDATE runs SET status = 'completed' WHERE id = $1", [runId]);
    await expect(held(owner)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('uma execução abandonada (worker que caiu) é retomada depois do vencimento da posse, fechando o que ficou pela metade', async () => {
    const { pool } = w();
    const bot = await w().createBot();
    const conversation = await pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id]);
    const conversationId = conversation.rows[0]!.id;
    // Estado que um worker morto deixaria: execução `running` com a posse vencida, a pergunta, uma chamada de ferramenta que
    // ficou `running` (sem resultado) e um texto do bot pela metade.
    const run = await pool.query<{ id: string }>(
      `INSERT INTO runs (conversation_id, bot_id, status, input, tool_calls, active_ms, lease_until, created_at, started_at)
       VALUES ($1, $2, 'running', 'retome isto', 1, 5000, now() - interval '1 minute', now(), now()) RETURNING id`,
      [conversationId, bot.id],
    );
    const runId = run.rows[0]!.id;
    const asked = await pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, created_at)
       VALUES ($1, $2, 'user', 'text', 'done', true, 'retome isto', now()) RETURNING id`,
      [conversationId, runId],
    );
    await pool.query('UPDATE runs SET trigger_message_id = $2 WHERE id = $1', [runId, asked.rows[0]!.id]);
    await pool.query(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, step, data, created_at)
       VALUES ($1, $2, 'assistant', 'activity', 'running', 1, $3, now())`,
      [conversationId, runId, JSON.stringify({ callId: 'call_x', tool: 'search_history', label: 'Pesquisou no histórico: x', arguments: '{"query":"x"}', detail: null })],
    );
    await pool.query(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, step, content, created_at)
       VALUES ($1, $2, 'assistant', 'text', 'streaming', 2, 'meio da resp', now())`,
      [conversationId, runId],
    );

    const engine = w().createEngine();
    engine.start();
    await w().waitForStatus(runId, 'completed');
    await engine.stop();
    const timeline = await w().timeline(bot);
    expect(timeline.map((entry) => `${entry.kind}:${entry.status}`)).toEqual(['text:done', 'activity:failed', 'text:discarded', 'text:done']);
    expect(timeline[1]?.content).toContain('reinício do serviço');
    // O modelo viu a chamada interrompida com o resultado de erro, e não o texto pela metade.
    const request = (w().conversationRequests().at(-1)?.body?.messages as { role: string; content?: string; tool_calls?: unknown[] }[]).filter((turn) => !turn.content?.startsWith('# Objetivo do bot ('));
    expect(request.map((turn) => turn.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(request[3]?.content).toContain('reinício do serviço');
    // Contou a chamada e o tempo que já estavam gravados.
    expect(await w().runRow(runId)).toMatchObject({ tool_calls: 1 });
    expect((await w().runRow(runId)).active_ms).toBeGreaterThanOrEqual(5000);
  });
});

describe('falhas do provedor e "tentar novamente"', () => {
  const w = useWorld();

  it('falha do provedor vira cartão seguro; tentar novamente reexecuta a mesma mensagem, só para a última execução que falhou', async () => {
    const { conversations, engine } = w();
    const bot = await w().createBot();
    const failed = await w().send(bot, '[falha] provedor fora do ar');
    engine.start();
    await w().waitForStatus(failed, 'failed');
    expect(await w().runRow(failed)).toMatchObject({ failure_code: 'PROVIDER_ERROR' });
    const timeline = await w().timeline(bot);
    expect(timeline.at(-1)).toMatchObject({ kind: 'card', data: { type: 'run_failed', code: 'PROVIDER_ERROR' }, content: 'O provedor falhou ao responder. Tente novamente.' });
    // A mensagem do cartão é a segura do registro: nada do corpo do erro do provedor chega à conversa.
    expect(JSON.stringify(timeline)).not.toContain('Service unavailable');

    const retry = await conversations.retry(bot.id, failed);
    expect(retry.status).toBe('queued');
    await w().waitForStatus(retry.id, 'completed');
    const after = await w().timeline(bot);
    // Uma só bolha do dono: a repetição reaproveita a mensagem. O turno do cartão ("[Sistema] ...") tira o marcador de falha.
    expect(after.filter((entry) => entry.role === 'user')).toHaveLength(1);
    expect(after.at(-1)).toMatchObject({ role: 'assistant', status: 'done' });
    expect(after.at(-1)?.content).toContain('Resposta: [Sistema]');

    // Repetir de novo: a execução já foi refeita (há uma mais nova), e uma concluída nem é candidata.
    expect(await codeOf(conversations.retry(bot.id, failed))).toBe('RUN_NOT_RETRYABLE');
    expect(await codeOf(conversations.retry(bot.id, retry.id))).toBe('RUN_NOT_RETRYABLE');
  });

  it('o provedor recusando a requisição ou respondendo sem texto também vira PROVIDER_ERROR', async () => {
    const { engine } = w();
    const rejected = await w().createBot();
    const mute = await w().createBot({ model: 'opencode/mute-model' });
    const a = await w().send(rejected, '[rejeitar] recusado');
    const b = await w().send(mute, 'fala algo');
    engine.start();
    await w().waitForStatus(a, 'failed');
    await w().waitForStatus(b, 'failed');
    expect(await w().runRow(a)).toMatchObject({ failure_code: 'PROVIDER_ERROR' });
    expect(await w().runRow(b)).toMatchObject({ failure_code: 'PROVIDER_ERROR' });
  });
});

describe('envio e provedor', () => {
  const w = useWorld();

  it('o envio é recusado sem provedor, sem modelo, em bot arquivado ou inexistente; o primeiro favorito serve de modelo', async () => {
    const { conversations, models, bots, credentials } = w();
    const noModel = await w().createBot({ model: null });
    expect(await codeOf(w().send(noModel, 'oi'))).toBe('MODEL_UNAVAILABLE');
    await models.setFavorite('opencode/glm-5.3-flash', true);
    await new Promise((resolve) => setTimeout(resolve, 5)); // instantes diferentes: a ordem dos favoritos é a de quando foram marcados
    await models.setFavorite('opencode/glm-5.1', true);
    expect(await codeOf(w().send(noModel, 'agora tem favorito'))).toBe('OK');
    expect((await conversations.snapshot(noModel.id)).model).toEqual({ model: 'opencode/glm-5.3-flash', effort: null, effortLevels: [] }); // o favorito mais antigo

    const archived = await w().createBot();
    await bots.archive(archived.id, ORIGIN);
    expect(await codeOf(w().send(archived, 'oi'))).toBe('BOT_ARCHIVED');
    expect(await codeOf(conversations.send('00000000-0000-4000-8000-000000000000', 'oi'))).toBe('BOT_NOT_FOUND');

    await credentials.disconnect('provider', ORIGIN);
    const bot = await w().createBot({ model: null }); // sem provedor não há lista de modelos para validar uma escolha
    expect(await codeOf(w().send(bot, 'oi'))).toBe('PROVIDER_NOT_CONFIGURED');
    expect((await conversations.snapshot(bot.id)).providerConfigured).toBe(false);
  });

  it('desconectar o provedor com a execução na fila termina a execução com PROVIDER_NOT_CONFIGURED', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot();
      const runId = await world.send(bot, 'chegou tarde');
      await world.credentials.disconnect('provider', ORIGIN);
      world.engine.start();
      await world.waitForStatus(runId, 'failed');
      expect(await world.runRow(runId)).toMatchObject({ failure_code: 'PROVIDER_NOT_CONFIGURED' });
      expect((await world.timeline(bot)).at(-1)).toMatchObject({ kind: 'card', data: { type: 'run_failed', code: 'PROVIDER_NOT_CONFIGURED' }, content: 'Configure um provedor.' });
    } finally {
      await world.cleanup();
    }
  });
});

describe('modelo e effort da conversa', () => {
  const w = useWorld();

  it('a troca no composer vale para a conversa sem alterar o padrão do bot; modelo sem ferramentas roda sem ferramentas; effort só dos níveis gravados', async () => {
    const { conversations, bots, models, engine } = w();
    const bot = await w().createBot({ model: 'opencode/glm-5.1' });
    await models.test('opencode/glm-5.1'); // grava os níveis de effort: low, medium, high

    expect(await codeOf(conversations.setPreference(bot.id, 'opencode/glm-5.1', 'max'))).toBe('VALIDATION_FAILED'); // nível que o modelo não aceita
    expect(await codeOf(conversations.setPreference(bot.id, 'modelo-que-nao-existe', null))).toBe('MODEL_UNAVAILABLE');
    expect(await conversations.setPreference(bot.id, 'opencode/glm-5.1', 'high')).toEqual({ model: 'opencode/glm-5.1', effort: 'high', effortLevels: ['low', 'medium', 'high'] });
    const first = await w().send(bot, 'com effort alto');

    engine.start();
    await w().waitForStatus(first, 'completed');
    expect(w().conversationRequests().at(-1)).toMatchObject({ model: 'glm-5.1', effort: 'high', tools: true });

    // Um "testar novamente" que reduz os níveis do modelo: o effort salvo deixa de valer, e NÃO é enviado (nem quebra a execução).
    await w().pool.query("UPDATE model_profiles SET effort_levels = '{low}' WHERE model_id = 'opencode/glm-5.1'");
    const third = await w().send(bot, 'depois do novo teste do modelo');
    await w().waitForStatus(third, 'completed');
    expect(w().conversationRequests().at(-1)?.effort).toBeUndefined();

    // Troca para um modelo que passa em texto e falha em ferramenta: a chamada vai sem nenhuma ferramenta.
    expect(await conversations.setPreference(bot.id, 'opencode/glm-5.3-flash', null)).toEqual({ model: 'opencode/glm-5.3-flash', effort: null, effortLevels: [] });
    const second = await w().send(bot, 'sem ferramentas');
    await w().waitForStatus(second, 'completed');
    expect(w().conversationRequests().at(-1)).toMatchObject({ model: 'glm-5.3-flash', tools: false });
    expect(w().conversationRequests().at(-1)?.effort).toBeUndefined(); // a preferência vale inteira: sem herdar o effort do bot
    // O padrão do bot não mudou.
    expect(await bots.get(bot.id)).toMatchObject({ model: 'opencode/glm-5.1', effort: null });

    // Phase 4, F7 (A13): cada resposta traz o modelo da última chamada da execução dela, no snapshot e no SSE; a mensagem do dono não leva o campo.
    const modelsOf = async () =>
      (await conversations.snapshot(bot.id)).items.flatMap((item) => (item.kind === 'text' ? [[item.role, item.model] as const] : []));
    expect(await modelsOf()).toEqual([
      ['user', undefined], ['assistant', 'opencode/glm-5.1'],
      ['user', undefined], ['assistant', 'opencode/glm-5.1'],
      ['user', undefined], ['assistant', 'opencode/glm-5.3-flash'],
    ]);
    const conversationId = await conversations.conversationIdOf(bot.id);
    const streamed = (await conversations.updatesSince(conversationId, '0')).updates.flatMap((update) =>
      update.event === 'message' && update.data.kind === 'text' && update.data.role === 'assistant' ? [update.data.model] : [],
    );
    expect(streamed).toEqual(['opencode/glm-5.1', 'opencode/glm-5.1', 'opencode/glm-5.3-flash']);
    // Resposta de execução anterior ao registro (coluna nula, como as de antes da migration 0023): sem modelo.
    await w().pool.query('UPDATE runs SET last_model = NULL WHERE id = $1', [first]);
    expect((await modelsOf())[1]).toEqual(['assistant', null]);
  });

  it('o modelo gravado é o da ÚLTIMA chamada: trocar o modelo entre as etapas da mesma execução muda o da resposta', async () => {
    // A ferramenta troca a preferência da conversa entre a primeira etapa (que a pede) e a segunda (a resposta final); o executor relê o modelo a cada etapa.
    const holder: { world?: RunsWorld; botId?: string } = {};
    const switching: ToolHandler = {
      definition: { name: 'search_history', description: 'troca o modelo no meio da execução', parameters: { type: 'object' } },
      external: false,
      prepare: () => ({
        label: 'Troca de modelo',
        execute: async () => {
          await holder.world!.conversations.setPreference(holder.botId!, 'opencode/glm-5.3-flash', null);
          return { result: 'ok' };
        },
      }),
    };
    const world = await createRunsWorld({ tools: [switching] });
    holder.world = world;
    try {
      const bot = await world.createBot({ model: 'opencode/glm-5.1' });
      holder.botId = bot.id;
      const runId = await world.send(bot, '[pesquisar:x] troque no meio');
      world.engine.start();
      await world.waitForStatus(runId, 'completed');
      expect(world.conversationRequests().map((request) => request.model)).toEqual(['glm-5.1', 'glm-5.3-flash']);
      expect((await world.pool.query('SELECT last_model FROM runs WHERE id = $1', [runId])).rows).toEqual([{ last_model: 'opencode/glm-5.3-flash' }]);
      const answer = (await world.conversations.snapshot(bot.id)).items.at(-1);
      expect(answer).toMatchObject({ kind: 'text', role: 'assistant', model: 'opencode/glm-5.3-flash' });
    } finally {
      await world.cleanup();
    }
  });

  it('o rollback da 0023 remove só o modelo das execuções, preservando execuções e mensagens, e o up roda de novo', async () => {
    const { pool } = w();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0023_run_last_model')!;
    expect(migration.destructive).toBeFalsy();
    const count = async (table: string) => Number((await pool.query<{ total: string }>(`SELECT count(*) AS total FROM ${table}`)).rows[0]?.total);
    const [runs, messages] = [await count('runs'), await count('messages')];
    expect((await pool.query('SELECT 1 FROM runs WHERE last_model IS NOT NULL')).rowCount).toBeGreaterThan(0);
    await pool.query(migration.rollback);
    expect((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'last_model'")).rowCount).toBe(0);
    expect([await count('runs'), await count('messages')]).toEqual([runs, messages]);
    await pool.query(migration.rollback); // idempotente
    await pool.query(migration.up);
    expect((await pool.query('SELECT 1 FROM runs WHERE last_model IS NOT NULL')).rowCount).toBe(0); // sem preenchimento retroativo
  });
});

describe('uma falha esperada de ferramenta não derruba a execução', () => {
  it('uma ferramenta que lança ToolFailure entrega o erro ao modelo como resultado', async () => {
    const failing: ToolHandler = {
      definition: { name: 'search_history', description: 'falha de teste', parameters: { type: 'object' } },
      external: false,
      prepare: () => ({
        label: 'Ferramenta instável',
        execute: async () => {
          throw new ToolFailure('serviço de teste indisponível');
        },
      }),
    };
    const world = await createRunsWorld({ tools: [failing] });
    try {
      const bot = await world.createBot();
      const runId = await world.send(bot, '[pesquisar:x] tente');
      world.engine.start();
      await world.waitForStatus(runId, 'completed');
      const timeline = await world.timeline(bot);
      expect(timeline.find((entry) => entry.kind === 'activity')).toMatchObject({ status: 'failed', content: JSON.stringify({ code: 'TOOL_FAILED', message: 'serviço de teste indisponível' }) });
      // O modelo recebeu o erro (no envelope único, A21) e respondeu ao dono.
      expect(timeline.at(-1)?.content).toBe(`Encontrei: ${JSON.stringify({ code: 'TOOL_FAILED', message: 'serviço de teste indisponível' })}`);
    } finally {
      await world.cleanup();
    }
  });
});

// Tokens de raciocínio no ledger por chamada (phase 10, T8; spec A16): `model_call_usage.reasoning_tokens` recebe a fatia que o provedor informou, na chamada principal e na de
// resumo, e fica NULL quando não informou. `output_tokens` continua o total, e o veredito do resumo continua julgando o total (o raciocínio nunca se soma a ele).
describe('tokens de raciocínio no ledger de chamadas', () => {
  /** Linhas do ledger da conversa de um bot, na ordem das chamadas, só com o que a prova compara. */
  const ledgerOf = async (world: RunsWorld, botId: string) => (await world.pool.query<{ purpose: string; output: number | null; reasoning: number | null }>(
    'SELECT purpose, output_tokens::int AS output, reasoning_tokens::int AS reasoning FROM model_call_usage WHERE conversation_id=$1 ORDER BY created_at, id',
    [await world.conversations.conversationIdOf(botId)],
  )).rows;

  it('a migration 0045 é aditiva e reversível: linha antiga fica NULL, o CHECK recusa negativo, o up repete sem erro e o rollback remove só a coluna', async () => {
    const world = await createRunsWorld();
    const column = async () => (await world.pool.query<{ is_nullable: string; data_type: string }>("SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name='model_call_usage' AND column_name='reasoning_tokens'")).rows;
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const run = await world.send(bot, 'oi');
      /** Linha do ledger sem a coluna nova no INSERT, como a escreve um worker anterior à migration. */
      const insertOld = async () => { const id = randomUUID(); await world.pool.query("INSERT INTO model_call_usage(id,conversation_id,run_id,purpose,model,protocol,created_at) VALUES($1,$2,$3,'main','opencode/glm-5.1','chat_completions',now())", [id, conversationId, run]); return id; };
      // Banco antes da 0045: sem a coluna, e a linha antiga já existe quando ela chega.
      await world.pool.query(modelCallReasoningMigration.rollback);
      expect(await column()).toEqual([]);
      const oldRow = await insertOld();
      await world.pool.query(modelCallReasoningMigration.up);
      await world.pool.query(modelCallReasoningMigration.up);
      expect(await column()).toEqual([{ is_nullable: 'YES', data_type: 'bigint' }]);
      expect((await world.pool.query('SELECT reasoning_tokens FROM model_call_usage WHERE id=$1', [oldRow])).rows).toEqual([{ reasoning_tokens: null }]);
      // O CHECK aceita zero e positivo e recusa negativo (valor externo nunca vira contagem negativa no ledger).
      await world.pool.query('UPDATE model_call_usage SET reasoning_tokens=0 WHERE id=$1', [oldRow]);
      await world.pool.query('UPDATE model_call_usage SET reasoning_tokens=12 WHERE id=$1', [oldRow]);
      await expect(world.pool.query('UPDATE model_call_usage SET reasoning_tokens=-1 WHERE id=$1', [oldRow])).rejects.toMatchObject({ code: '23514' });
      // O rollback é idempotente e remove só a coluna: a linha, o consumo e o resto do ledger ficam.
      await world.pool.query(modelCallReasoningMigration.rollback);
      await world.pool.query(modelCallReasoningMigration.rollback);
      expect(await column()).toEqual([]);
      expect((await world.pool.query('SELECT id::text, purpose FROM model_call_usage WHERE id=$1', [oldRow])).rows).toEqual([{ id: oldRow, purpose: 'main' }]);
      await world.pool.query(modelCallReasoningMigration.up);
    } finally {
      await world.cleanup();
    }
  });

  it('a chamada principal grava a fatia nos protocolos que a informam, NULL no messages e sem marcador, e o log traz reasoningTokens só quando informado', async () => {
    const world = await createRunsWorld();
    const log = vi.spyOn(world.logger, 'info');
    try {
      world.engine.start();
      for (const [model, protocol] of [['opencode/glm-5.1', 'chat_completions'], ['opencode/kimi-k2.7-code', 'messages'], ['opencode/grok-4.7', 'responses']] as const) {
        const bot = await world.createBot({ model });
        const informed = await world.send(bot, '[raciocinio:7] raciocine');
        await world.waitForStatus(informed, 'completed');
        const silent = await world.send(bot, 'sem marcador');
        await world.waitForStatus(silent, 'completed');
        // Com o marcador a saída informada é a base (2) mais a fatia (7); o messages não tem o campo e fica NULL. Sem o marcador, nenhum protocolo informa.
        expect(await ledgerOf(world, bot.id), protocol).toEqual([
          { purpose: 'main', output: 9, reasoning: protocol === 'messages' ? null : 7 },
          { purpose: 'main', output: 2, reasoning: null },
        ]);
        const entries = log.mock.calls.filter((call) => call[1] === 'uso de tokens do modelo' && [informed, silent].includes((call[0] as { runId?: string }).runId ?? ''));
        // `toStrictEqual` separa "sem a chave" de "chave undefined": o log da etapa sem dado não pode nem ter o campo.
        expect(entries.map((call) => call[0])).toStrictEqual([
          { runId: informed, step: 1, model, protocol, inputTokens: 100, cachedTokens: 80, outputTokens: 9, cachedFraction: 0.8, ...(protocol === 'messages' ? {} : { reasoningTokens: 7 }) },
          { runId: silent, step: 1, model, protocol, inputTokens: 100, cachedTokens: 80, outputTokens: 2, cachedFraction: 0.8 },
        ]);
      }
    } finally {
      log.mockRestore();
      await world.cleanup();
    }
  });

  it('a chamada de resumo grava a fatia (ou NULL) e o veredito segue julgando a saída total, sem somar o raciocínio', async () => {
    const world = await createRunsWorld();
    const checkpoint = SUMMARY_SECTIONS.map((title, index) => `## ${title}\n${index === 0 ? 'Direção preservada.' : 'Nada.'}`).join('\n\n');
    // Uso que cada chamada informa; trocado entre as duas jornadas para provar o caso informado e o sem dado.
    let main: { outputTokens: number; reasoningTokens?: number } = { outputTokens: 10, reasoningTokens: 4 };
    let summary: { outputTokens: number; reasoningTokens?: number } = { outputTokens: 4_000, reasoningTokens: 3_500 };
    const log = vi.spyOn(world.logger, 'info');
    try {
      await world.models.test('opencode/glm-5.1');
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
        const isSummary = request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS;
        yield { type: 'text', text: isSummary ? checkpoint : 'Resposta normal.' };
        yield { type: 'usage', usage: { inputTokens: 100, ...(isSummary ? summary : main) } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      /** Conversa nova com histórico antigo a cobrir (cobertura criada antes de semear, como nas jornadas de manutenção), uma rodada real e a compactação manual. */
      const compact = async () => {
        const bot = await world.createBot();
        const conversationId = await world.conversations.conversationIdOf(bot.id);
        await loadManagedContext(world.pool, conversationId);
        for (let index = 0; index < 5; index++) await world.pool.query("INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,$2,now())", [conversationId, `Histórico ${index}: ${'a'.repeat(4000)}`]);
        await world.waitForStatus(await world.send(bot, 'Pedido atual'), 'completed');
        const state = await world.conversations.contextState(bot.id), requestId = randomUUID();
        await world.conversations.maintainContext(bot.id, { requestId, mode: 'summarize', expectedRevision: state.revision }, randomUUID());
        const run = (await world.pool.query<{ id: string }>('SELECT id::text FROM runs WHERE context_operation_id=$1', [requestId])).rows[0]!.id;
        await world.waitForStatus(run, 'completed');
        return bot;
      };

      // Informado: 4.000 de saída com 3.500 de raciocínio. Se o veredito somasse os dois (7.500 > 6.144) o resumo seria recusado por limite de saída; aplicado prova que não soma.
      const informedBot = await compact();
      expect(await ledgerOf(world, informedBot.id)).toEqual([{ purpose: 'main', output: 10, reasoning: 4 }, { purpose: 'summary', output: 4_000, reasoning: 3_500 }]);
      expect((await world.pool.query("SELECT state, summary_outcome FROM model_call_usage WHERE purpose='summary' AND conversation_id=$1", [await world.conversations.conversationIdOf(informedBot.id)])).rows).toEqual([{ state: 'completed', summary_outcome: 'applied' }]);
      expect(log.mock.calls.find((call) => call[1] === 'desfecho da chamada de resumo')?.[0]).toMatchObject({ outputTokens: 4_000, reasoningTokens: 3_500, valid: true });

      // Sem dado: a chamada principal e a de resumo ficam com NULL, e o log do resumo omite o campo.
      main = { outputTokens: 10 }; summary = { outputTokens: 300 };
      log.mockClear();
      const silentBot = await compact();
      expect(await ledgerOf(world, silentBot.id)).toEqual([{ purpose: 'main', output: 10, reasoning: null }, { purpose: 'summary', output: 300, reasoning: null }]);
      expect(log.mock.calls.find((call) => call[1] === 'desfecho da chamada de resumo')?.[0]).not.toHaveProperty('reasoningTokens');
    } finally {
      vi.restoreAllMocks();
      await world.cleanup();
    }
  });
});

// Phase 15, passo 2 (A5): cada chamada ao modelo grava no ledger o hash de cada bloco do prefixo do pedido (sistema, objetivo, ferramentas, histórico, e o histórico até o início de cada
// rodada) e o effort, e nunca o conteúdo. É o que separa, nas aberturas de rodada, qual bloco quebrou o cache. As esperas vêm do pedido que o provedor falso de fato recebeu.
describe('A5: hash por bloco do pedido no ledger de chamadas', () => {
  it('a chamada principal grava os hashes do sistema, do objetivo, das ferramentas e do histórico e o effort, sem conteúdo da conversa, e o histórico das rodadas localiza o ponto em que o prefixo cresce', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot({ model: 'opencode/glm-5.1' });
      await world.models.test('opencode/glm-5.1');
      await world.conversations.setPreference(bot.id, 'opencode/glm-5.1', 'high');
      await world.pool.query("UPDATE bot_objectives SET content = 'Acompanhar a fatura confidencial do dono', version = 1 WHERE bot_id = $1", [bot.id]);
      const requests: ChatRequest[] = [];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
        requests.push(structuredClone(request));
        yield { type: 'text', text: `Resposta reservada ${requests.length}` };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      for (const text of ['Primeira pergunta sigilosa', 'Segunda pergunta sigilosa']) await world.waitForStatus(await world.send(bot, text), 'completed');
      expect(requests).toHaveLength(2);

      type Row = { system_hash: string; objective_hash: string; tools_hash: string; history_hash: string; history_turns: number; history_round_hashes: string[]; history_prior_hash: string; effort: string };
      const rows = (await world.pool.query<Row>("SELECT system_hash, objective_hash, tools_hash, history_hash, history_turns, history_round_hashes, history_prior_hash, effort FROM model_call_usage WHERE purpose = 'main' ORDER BY created_at, id")).rows;
      expect(rows).toHaveLength(2);

      // O esperado sai do pedido recebido, calculado aqui peça por peça: sistema no turno 0, objetivo no turno 1 e o resto é histórico.
      const history = requests.map((request) => request.turns.slice(2));
      expect(requests[0]!.turns[0]!.role).toBe('system');
      expect(requests[0]!.turns[1]!.text).toContain('Acompanhar a fatura confidencial do dono');
      requests.forEach((request, index) => {
        expect(rows[index]).toMatchObject({
          system_hash: contextFingerprint(request.turns[0]!.text),
          objective_hash: contextFingerprint(request.turns[1]!.text),
          tools_hash: contextFingerprint(request.tools),
          history_hash: contextFingerprint(history[index]),
          history_turns: history[index]!.length,
          effort: 'high',
        });
      });
      expect(requests[0]!.tools?.length).toBeGreaterThan(0);

      // Histórico por rodada: o vetor tem o hash do histórico ANTES de cada turno que abre uma rodada (o que leva o `# Dados`), e o último é o histórico até o início da rodada atual.
      const opening = (turns: ChatRequest['turns']) => turns.flatMap((turn, index) => (turn.role === 'user' && turn.text.startsWith('# Dados\n') ? [index] : []));
      expect(opening(history[0]!)).toEqual([0]);
      expect(opening(history[1]!)).toEqual([0, 2]); // abertura da 1a rodada, resposta do bot, abertura da 2a
      expect(rows[0]!.history_round_hashes).toEqual([contextFingerprint([])]);
      expect(rows[1]!.history_round_hashes).toEqual([contextFingerprint([]), contextFingerprint(history[1]!.slice(0, 2))]);
      expect(rows.map((row) => row.history_prior_hash)).toEqual([contextFingerprint([]), contextFingerprint(history[1]!.slice(0, 2))]);

      // Prefixo estável entre as duas chamadas: os blocos de cima ficam iguais e só o histórico muda, o que o diagnóstico da queda de cache precisa distinguir.
      expect(rows[1]).toMatchObject({ system_hash: rows[0]!.system_hash, objective_hash: rows[0]!.objective_hash, tools_hash: rows[0]!.tools_hash, effort: 'high' });
      expect(rows[1]!.history_hash).not.toBe(rows[0]!.history_hash);

      // Só hash, contagem e effort: nada do que o dono ou o bot escreveram vai para a linha.
      for (const row of rows) {
        for (const hash of [row.system_hash, row.objective_hash, row.tools_hash, row.history_hash, row.history_prior_hash, ...row.history_round_hashes]) expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(row)).not.toMatch(/sigilosa|reservada|confidencial/i);
      }
    } finally {
      vi.restoreAllMocks();
      await world.cleanup();
    }
  });

  it('modelo sem ferramentas e sem effort grava NULL na lista e no effort e continua gravando sistema, objetivo e histórico', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot({ model: 'opencode/glm-5.3-flash' });
      await world.models.test('opencode/glm-5.3-flash'); // passa em texto e falha em ferramenta: o pedido vai sem `tools`
      await world.conversations.setPreference(bot.id, 'opencode/glm-5.3-flash', null);
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'sem ferramentas'), 'completed');
      const rows = (await world.pool.query<{ system_hash: string | null; objective_hash: string | null; tools_hash: string | null; effort: string | null; history_turns: number }>("SELECT system_hash, objective_hash, tools_hash, effort, history_turns FROM model_call_usage WHERE purpose = 'main'")).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.system_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.objective_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]).toMatchObject({ tools_hash: null, effort: null, history_turns: 1 });
    } finally {
      await world.cleanup();
    }
  });
});

describe('bot em modelo da Anthropic (phase 17; A10, A15, A16, A17, A19)', () => {
  const w = useWorld();
  const CLAUDE_CREDENTIAL = 'valid-anthropic-QRST';
  const MODEL = 'anthropic/claude-haiku-5-5';

  /** Chamadas de chat da execução à Anthropic falsa (as com instruções de sistema, que são as do motor), a partir de `since`. */
  const anthropicChats = (since: number) =>
    w().upstreams.requests.slice(since).filter((request) => request.service === 'anthropic' && request.method === 'POST' && request.body !== undefined && Array.isArray(request.body.system));
  /** Todo bloco de conteúdo do histórico de um pedido, por tipo. */
  const blockTypes = (body: Record<string, unknown>): string[] => ((body.messages as { content: { type: string }[] }[]) ?? []).flatMap((message) => message.content.map((block) => block.type));

  it('A15: a resposta chega de api.anthropic com x-api-key e anthropic-version, sem Bearer nem sessão do OpenCode, com o id local no corpo e no # Dados e o id do produto no ledger', async () => {
    const { engine, pool, upstreams } = w();
    await w().connectAnthropic();
    const bot = await w().createBot({ model: MODEL });
    engine.start();
    const since = upstreams.requests.length;
    const run = await w().send(bot, 'olá, Claude');
    await w().waitForStatus(run, 'completed');

    const chats = anthropicChats(since);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ service: 'anthropic', path: '/anthropic/v1/messages', key: CLAUDE_CREDENTIAL, model: 'claude-haiku-5-5', anthropicVersion: '2023-06-01', bearer: false, tools: true });
    expect(chats[0]!.sessionId).toBeUndefined();
    expect(JSON.stringify(chats[0]!.body!.messages)).toContain('Modelo desta resposta: claude-haiku-5-5');
    expect(JSON.stringify(chats[0]!.body)).not.toContain('anthropic/claude-haiku-5-5');
    // Nada dessa rodada foi ao OpenCode Go (a chave dele nem é consultada para este modelo): o primeiro teste do modelo e a conversa ficaram na Anthropic.
    expect(upstreams.requests.slice(since).filter((request) => request.service === 'opencode-go' && request.method === 'POST')).toEqual([]);
    expect(upstreams.requests.slice(since).every((request) => request.service === 'anthropic' && request.key === CLAUDE_CREDENTIAL)).toBe(true);
    // Ledger e conversa guardam o id do produto; a resposta é o texto do modelo falso.
    expect((await pool.query("SELECT model, protocol FROM model_call_usage WHERE run_id = $1 AND purpose = 'main'", [run])).rows).toEqual([{ model: MODEL, protocol: 'messages' }]);
    expect((await pool.query('SELECT last_model FROM runs WHERE id = $1', [run])).rows[0]).toEqual({ last_model: MODEL });
    expect((await w().timeline(bot)).filter((entry) => entry.role === 'assistant').map((entry) => entry.content)).toEqual(['Resposta: olá, Claude']);
  });

  it('A16: a chamada de ferramenta volta com o resultado, e a ação do conector segue a regra de aprovação (pausa, decisão do dono e retomada no mesmo provedor)', async () => {
    const { engine, pool, upstreams, approvals } = w();
    await w().connectComposio();
    const bot = await w().createBot({ model: MODEL });
    await w().releaseConnectorAccounts(bot);
    engine.start();
    const since = upstreams.requests.length;
    const run = await w().send(bot, '[github] abra uma issue');
    await w().waitForStatus(run, 'waiting_approval');
    const approval = (await w().approvalOf(run))!;
    expect(anthropicChats(since)).toHaveLength(1); // a pausa veio de UMA chamada ao Claude; a ação ainda não foi executada
    expect(upstreams.requests.slice(since).filter((request) => request.service === 'composio' && request.path.includes('/tools/execute/'))).toEqual([]);

    await approvals.respond(approval.id, 'allow_once', ORIGIN);
    await w().waitForStatus(run, 'completed');
    // A retomada chama o Claude de novo com a chamada e o resultado da ferramenta no formato do messages (tool_use e tool_result), sem bloco de raciocínio.
    const chats = anthropicChats(since);
    expect(chats).toHaveLength(2);
    expect(blockTypes(chats[1]!.body!)).toEqual(expect.arrayContaining(['tool_use', 'tool_result']));
    expect(blockTypes(chats[1]!.body!)).not.toContain('thinking');
    expect(chats.every((chat) => chat.key === CLAUDE_CREDENTIAL && chat.bearer === false)).toBe(true);
    expect(upstreams.requests.slice(since).filter((request) => request.service === 'composio' && request.path.includes('/tools/execute/'))).toHaveLength(1);
    expect((await pool.query("SELECT status FROM runs WHERE id = $1", [run])).rows[0]).toEqual({ status: 'completed' });
    // Negar também vale como antes: a ação não roda e a execução conclui.
    const denied = await w().send(bot, '[github] outra issue');
    await w().waitForStatus(denied, 'waiting_approval');
    await approvals.respond((await w().approvalOf(denied))!.id, 'deny', ORIGIN);
    await w().waitForStatus(denied, 'completed');
    expect(upstreams.requests.slice(since).filter((request) => request.service === 'composio' && request.path.includes('/tools/execute/'))).toHaveLength(1);
  });

  it('A17: o uso grava a leitura e a gravação de cache à parte, com leitura acima de zero, na primeira e na segunda chamada da conversa', async () => {
    const { engine, pool } = w();
    await w().connectAnthropic();
    const bot = await w().createBot({ model: MODEL });
    engine.start();
    const first = await w().send(bot, '[cache-gravacao:20] primeira');
    await w().waitForStatus(first, 'completed');
    const second = await w().send(bot, '[cache-gravacao:20] segunda');
    await w().waitForStatus(second, 'completed');
    for (const run of [first, second]) {
      const usage = (await pool.query<{ input_tokens: string; cached_tokens: string; cache_write_tokens: string; output_tokens: string }>("SELECT input_tokens::text, cached_tokens::text, cache_write_tokens::text, output_tokens::text FROM model_call_usage WHERE run_id = $1 AND purpose = 'main'", [run])).rows;
      expect(usage, run).toEqual([{ input_tokens: '100', cached_tokens: '80', cache_write_tokens: '20', output_tokens: '2' }]);
    }
  });

  it('A18, A19: o effort vai em output_config.effort, o pedido não leva amostragem nem tool_choice, e nenhum thinking volta ao Claude (nem depois de uma compactação), sem 400', async () => {
    const { engine, pool, upstreams, conversations } = w();
    await w().connectAnthropic();
    await w().models.test(MODEL);
    const bot = await w().createBot({ model: MODEL, effort: 'high' });
    engine.start();
    const since = upstreams.requests.length;
    // Rodadas com ferramenta (a resposta de cada etapa traz o bloco thinking com assinatura) para o histórico ter tool_use e tool_result.
    const filler = 'Texto de enchimento da conversa. '.repeat(120); // ~4.000 caracteres por rodada: dá ao resumo o que cobrir
    for (let round = 0; round < 8; round += 1) {
      const run = await w().send(bot, round % 2 === 0 ? `[pesquisar:rodada${round}] consulta ${round} ${filler}` : `conversa comum ${round} ${filler}`);
      await w().waitForStatus(run, 'completed');
    }
    // "Compactar agora": o resumo também é uma chamada ao Claude, e a conversa segue depois dele.
    const state = await conversations.contextState(bot.id);
    expect(state.eligibility.summarizeEnabled).toBe(true);
    const requestId = randomUUID();
    await conversations.maintainContext(bot.id, { requestId, mode: 'summarize', expectedRevision: state.revision }, randomUUID());
    const maintenance = (await pool.query<{ id: string }>('SELECT id::text FROM runs WHERE context_operation_id = $1', [requestId])).rows[0]!.id;
    await waitFor('compactação', async () => ['completed', 'failed'].includes((await w().runRow(maintenance)).status), 30_000);
    expect(await w().runRow(maintenance)).toMatchObject({ status: 'completed', failure_code: null });
    const after = await w().send(bot, 'depois da compactação');
    await w().waitForStatus(after, 'completed');

    const chats = upstreams.requests.slice(since).filter((request) => request.service === 'anthropic' && request.method === 'POST' && request.body !== undefined);
    expect(chats.length).toBeGreaterThan(10);
    for (const chat of chats) {
      expect(blockTypes(chat.body!), 'thinking reenviado').not.toContain('thinking');
      expect(blockTypes(chat.body!)).not.toContain('redacted_thinking');
      for (const forbidden of ['temperature', 'top_p', 'top_k', 'tool_choice', 'thinking']) expect(chat.body, forbidden).not.toHaveProperty(forbidden);
      expect(chat.key).toBe(CLAUDE_CREDENTIAL);
    }
    // O effort do bot vai no parâmetro próprio e só nas chamadas do motor da conversa (o resumo pede o nível mais baixo que o modelo aceita).
    expect(chats.filter((chat) => Array.isArray(chat.body!.system)).every((chat) => (chat.body!.output_config as { effort?: string } | undefined)?.effort !== undefined)).toBe(true);
    expect(chats.some((chat) => (chat.body!.output_config as { effort?: string } | undefined)?.effort === 'high')).toBe(true);
    // O pedido da conversa depois da compactação levou o checkpoint, e a execução terminou normalmente (nenhum 400 por histórico editado).
    expect((await pool.query("SELECT count(*)::int AS n FROM model_call_usage WHERE purpose = 'summary' AND state = 'completed'")).rows[0]!.n).toBeGreaterThan(0);
    expect(await w().runRow(after)).toMatchObject({ status: 'completed', failure_code: null });
  }, 120_000);

  it('A10: a reserva de saída enviada ao Claude respeita o max_tokens do modelo (8.192 num modelo de saída pequena) e uma janela maior que o contexto do modelo não o ultrapassa', async () => {
    const { engine, pool, upstreams } = w();
    await w().connectAnthropic();
    const bot = await w().createBot({ model: 'anthropic/claude-haiku-3-5', contextWindowTokens: 524_288 });
    engine.start();
    const since = upstreams.requests.length;
    const run = await w().send(bot, 'um modelo de saída pequena');
    await w().waitForStatus(run, 'completed');
    const chat = anthropicChats(since)[0]!;
    expect(chat.body!.max_tokens).toBe(8_192);
    // A janela da conversa foi limitada pelos 200.000 de contexto do modelo: a medição gravada usa o orçamento dessa janela (200.000 - 8.192 - 2.048 de margem).
    const measurement = (await pool.query<{ measurement: { inputBudget: number } }>('SELECT measurement FROM conversation_context WHERE conversation_id = (SELECT conversation_id FROM runs WHERE id = $1)', [run])).rows[0]!.measurement;
    expect(measurement.inputBudget).toBe(200_000 - 8_192 - 2_048);
  });
});

describe('saldo da Anthropic esgotado (phase 17, A20 e A21)', () => {
  const w = useWorld();
  const MODEL = 'anthropic/claude-haiku-5-5';

  /** Chamadas de chat do MOTOR à Anthropic falsa (com instruções de sistema) a partir de `since`. */
  const anthropicChats = (since: number) =>
    w().upstreams.requests.slice(since).filter((request) => request.service === 'anthropic' && request.method === 'POST' && request.body !== undefined && Array.isArray(request.body.system));
  const anthropicListed = async () => (await w().models.list()).filter((entry) => entry.id.startsWith('anthropic/')).map((entry) => entry.unavailable ?? null);

  it.each([
    { name: 'HTTP 402 billing_error (a forma documentada)', marker: '[sem-saldo]' },
    { name: 'HTTP 400 com a mensagem de saldo baixo (a forma que a API real também usa)', marker: '[sem-saldo-400]' },
  ])('A20: $name para o bot na primeira chamada com PROVIDER_CREDITS_EXHAUSTED, sem nova tentativa nem outro provedor, e o cartão e o push dizem "Créditos da Anthropic esgotados"', async ({ marker }) => {
    const { engine, pool, upstreams } = w();
    await w().connectAnthropic();
    await w().models.test(MODEL); // o teste do modelo não pode ser a chamada que falha: ele fica gravado antes
    await new PushService({ pool, config: { enabled: false } }).registerDevice('device-saldo', ORIGIN); // sem aparelho cadastrado o aviso nem é enfileirado
    const bot = await w().createBot({ model: MODEL, name: `Bot sem saldo ${marker.length}` });
    engine.start();
    const since = upstreams.requests.length;
    const run = await w().send(bot, `${marker} escreva algo`);
    await w().waitForStatus(run, 'failed');

    expect(await w().runRow(run)).toMatchObject({ status: 'failed', failure_code: 'PROVIDER_CREDITS_EXHAUSTED' });
    expect(anthropicChats(since)).toHaveLength(1); // uma só chamada, sem nova tentativa
    expect(upstreams.requests.slice(since).filter((request) => request.service === 'opencode-go' && request.method === 'POST')).toEqual([]); // nem outro provedor
    const cards = (await w().timeline(bot)).filter((entry) => entry.kind === 'card' && entry.data.type === 'run_failed' && entry.runId === run);
    expect(cards.map((card) => [card.data.code, card.content])).toEqual([['PROVIDER_CREDITS_EXHAUSTED', 'Créditos da Anthropic esgotados.']]);
    // O aviso push sai como em qualquer falha (`run_failed`).
    expect((await pool.query('SELECT kind FROM push_events WHERE run_id = $1', [run])).rows).toEqual([{ kind: 'run_failed' }]);
    // O estado de saldo fica gravado na credencial, e o catálogo do servidor mostra o modelo indisponível.
    expect((await pool.query("SELECT credits_exhausted_at IS NOT NULL AS exhausted FROM credentials WHERE kind = 'anthropic'")).rows).toEqual([{ exhausted: true }]);
    await pool.query("DELETE FROM credentials WHERE kind = 'anthropic'");
  });

  it('A21: depois do saldo esgotado os modelos anthropic/ ficam indisponíveis (o OpenCode Go não), o teste do modelo para sem gravar resultado, e uma chamada que passa os libera', async () => {
    const { engine, pool, upstreams } = w();
    await w().connectAnthropic();
    await w().models.test(MODEL);
    const before = (await pool.query('SELECT test_status, tested_at FROM model_profiles WHERE model_id = $1', [MODEL])).rows[0];
    const bot = await w().createBot({ model: MODEL });
    engine.start();
    expect(new Set(await anthropicListed())).toEqual(new Set([null]));

    upstreams.controls.anthropicOutOfCredits = true;
    const failed = await w().send(bot, 'qualquer coisa');
    await w().waitForStatus(failed, 'failed');
    expect(await w().runRow(failed)).toMatchObject({ failure_code: 'PROVIDER_CREDITS_EXHAUSTED' });
    expect(new Set(await anthropicListed())).toEqual(new Set(['credits_exhausted']));
    expect((await w().models.list()).filter((entry) => entry.id.startsWith('opencode/')).every((entry) => !entry.unavailable)).toBe(true);
    // Testar o modelo agora para com o código próprio e NÃO grava "falhou" por cima do resultado anterior.
    expect(await codeOf(w().models.test(MODEL))).toBe('PROVIDER_CREDITS_EXHAUSTED');
    expect((await pool.query('SELECT test_status, tested_at FROM model_profiles WHERE model_id = $1', [MODEL])).rows[0]).toEqual(before);

    // A próxima chamada que passa libera o modelo: nenhuma tentativa foi bloqueada enquanto ele estava indisponível.
    upstreams.controls.anthropicOutOfCredits = false;
    const since = upstreams.requests.length;
    const again = await w().send(bot, 'agora com saldo');
    await w().waitForStatus(again, 'completed');
    expect(anthropicChats(since)).toHaveLength(1);
    expect(new Set(await anthropicListed())).toEqual(new Set([null]));
    expect((await pool.query("SELECT credits_exhausted_at FROM credentials WHERE kind = 'anthropic'")).rows).toEqual([{ credits_exhausted_at: null }]);
    await pool.query("DELETE FROM credentials WHERE kind = 'anthropic'");
  });

  it('A21: a mensagem seguinte a uma recusa por saldo é uma chamada nova (o histórico leva a falha e o aviso de sistema, mas a recusa vale só para a mensagem do marcador), passa e libera os modelos', async () => {
    const { engine, pool, upstreams } = w();
    await w().connectAnthropic();
    await w().models.test(MODEL);
    const bot = await w().createBot({ model: MODEL });
    engine.start();
    const failed = await w().send(bot, '[sem-saldo] escreva algo');
    await w().waitForStatus(failed, 'failed');
    expect(new Set(await anthropicListed())).toEqual(new Set(['credits_exhausted']));

    const since = upstreams.requests.length;
    const next = await w().send(bot, 'Agora com saldo');
    await w().waitForStatus(next, 'completed');
    // O pedido leva a mensagem antiga, o aviso e a nova no mesmo turno do dono (o `messages` junta os turnos seguidos), e só a atual manda no falso.
    expect(JSON.stringify(anthropicChats(since)[0]!.body!.messages)).toContain('[sem-saldo] escreva algo');
    expect((await w().timeline(bot)).filter((entry) => entry.role === 'assistant' && entry.runId === next).map((entry) => entry.content)).toEqual(['Resposta: Agora com saldo']);
    expect(new Set(await anthropicListed())).toEqual(new Set([null]));
    await pool.query("DELETE FROM credentials WHERE kind = 'anthropic'");
  });
});

describe('429 do OpenCode Go na execução (phase 17, passo 8; A22)', () => {
  const w = useWorld();
  /** Chamadas de chat do MOTOR ao OpenCode Go falso (com instruções de sistema) a partir de `since`. */
  const engineChats = (since: number) =>
    w().upstreams.requests.slice(since).filter((request) => request.service === 'opencode-go' && request.method === 'POST' && Array.isArray(request.body?.messages) && (request.body.messages as { role: string }[]).some((message) => message.role === 'system'));

  it('um 429 antes do stream é repetido e a execução conclui: uma só resposta, um só registro de chamada no ledger e nenhum cartão de falha', async () => {
    const { engine, pool, upstreams } = w();
    const bot = await w().createBot({ name: 'Bot com limite passageiro' });
    await w().models.test('opencode/glm-5.1');
    engine.start();
    const since = upstreams.requests.length;
    const run = await w().send(bot, '[limitar] responda');
    await w().waitForStatus(run, 'completed');

    expect(engineChats(since)).toHaveLength(2); // a recusada (429) e a que passou, com o mesmo corpo
    expect(JSON.stringify(engineChats(since)[0]!.body)).toBe(JSON.stringify(engineChats(since)[1]!.body));
    const timeline = await w().timeline(bot);
    expect(timeline.filter((entry) => entry.role === 'assistant').map((entry) => entry.content)).toEqual(['Resposta: [limitar] responda']);
    expect(timeline.filter((entry) => entry.kind === 'card')).toEqual([]);
    // Para o ledger e o custo é UMA chamada lógica, e a execução não guardou falha.
    expect((await pool.query("SELECT count(*)::int AS n FROM model_call_usage WHERE run_id = $1 AND purpose = 'main'", [run])).rows[0]!.n).toBe(1);
    expect(await w().runRow(run)).toMatchObject({ status: 'completed', failure_code: null });
  });

  it('com o provedor limitando sempre, a execução faz a chamada e só 2 novas tentativas e termina como RATE_LIMITED (a classe da falha fica em runs.failure_code, e o cartão e o push dizem o motivo)', async () => {
    const { engine, pool, upstreams } = w();
    await new PushService({ pool, config: { enabled: false } }).registerDevice('device-limite', ORIGIN); // sem aparelho o aviso nem é enfileirado
    const bot = await w().createBot({ name: 'Bot com limite permanente' });
    engine.start();
    const since = upstreams.requests.length;
    const run = await w().send(bot, '[limitar-sempre] responda');
    await w().waitForStatus(run, 'failed');

    expect(engineChats(since)).toHaveLength(3);
    expect(await w().runRow(run)).toMatchObject({ status: 'failed', failure_code: 'RATE_LIMITED' });
    const cards = (await w().timeline(bot)).filter((entry) => entry.kind === 'card' && entry.runId === run);
    expect(cards.map((card) => [card.data.type, card.data.code])).toEqual([['run_failed', 'RATE_LIMITED']]);
    expect((await pool.query('SELECT kind FROM push_events WHERE run_id = $1', [run])).rows).toEqual([{ kind: 'run_failed' }]);
    // O ledger fecha como uma chamada que falhou, uma só.
    expect((await pool.query("SELECT count(*)::int AS n FROM model_call_usage WHERE run_id = $1 AND purpose = 'main'", [run])).rows[0]!.n).toBe(1);
  });
});

describe('recentes e provedor único (phase 17, passo 9; A26)', () => {
  it('A26: os recentes são os 5 modelos usados mais recentemente (do mais novo ao mais antigo), só entre os da lista atual, sem repetir', async () => {
    const world = await createRunsWorld();
    try {
      world.engine.start();
      const models = ['opencode/glm-5.1', 'opencode/glm-5.3-flash', 'opencode/kimi-k2.7-code', 'opencode/grok-4.7', 'opencode/deepseek-v4.1-flash', 'opencode/vision-model'];
      const runs: string[] = [];
      for (const model of models) {
        const bot = await world.createBot({ model });
        const run = await world.send(bot, 'oi');
        await world.waitForStatus(run, 'completed');
        runs.push(run);
      }
      // Instantes controlados (as execuções rápidas poderiam empatar no relógio): o modelo `i` foi usado no minuto `i`; o primeiro volta a ser usado por último.
      for (const [index, run] of runs.entries()) await world.pool.query("UPDATE runs SET created_at = '2026-11-14T10:00:00Z'::timestamptz + make_interval(mins => $2::int) WHERE id = $1", [run, index]);
      const extra = await world.send(await world.createBot({ model: models[0]! }), 'de novo');
      await world.waitForStatus(extra, 'completed');
      await world.pool.query("UPDATE runs SET created_at = '2026-11-14T11:00:00Z' WHERE id = $1", [extra]);

      const listed = (await world.models.list()).map((entry) => entry.id);
      expect(await world.models.recents(listed)).toEqual(['opencode/glm-5.1', 'opencode/vision-model', 'opencode/deepseek-v4.1-flash', 'opencode/grok-4.7', 'opencode/kimi-k2.7-code']);
      // Um modelo que saiu da lista atual não aparece (o próximo mais recente ocupa o lugar dele).
      expect(await world.models.recents(listed.filter((id) => id !== 'opencode/vision-model'))).toEqual(['opencode/glm-5.1', 'opencode/deepseek-v4.1-flash', 'opencode/grok-4.7', 'opencode/kimi-k2.7-code', 'opencode/glm-5.3-flash']);
      expect(await world.models.recents([])).toEqual([]);
    } finally {
      await world.cleanup();
    }
  }, 60_000);

  it('a consulta de Recentes olha só as execuções mais novas (RECENT_MODELS_SCAN_RUNS), sem varrer a tabela inteira: um modelo usado só antes da janela não aparece, e dentro dela aparece', async () => {
    const world = await createRunsWorld();
    try {
      world.engine.start();
      const bot = await world.createBot();
      const old = await world.send(bot, 'oi');
      await world.waitForStatus(old, 'completed');
      await world.pool.query("UPDATE runs SET last_model = 'opencode/kimi-k2.7-code' WHERE id = $1", [old]);
      const listed = (await world.models.list()).map((entry) => entry.id);
      const filler = (count: number) =>
        world.pool.query(
          "INSERT INTO runs (conversation_id, bot_id, status, input, last_model, created_at, finished_at) SELECT r.conversation_id, r.bot_id, 'completed', 'preenchimento', 'opencode/glm-5.1', now() + make_interval(secs => g), now() FROM runs r, generate_series(1, $2::int) AS g WHERE r.id = $1",
          [old, count],
        );
      // Dentro da janela (a execução antiga e mais 150): o modelo antigo ainda aparece, depois do mais novo.
      await filler(150);
      expect(await world.models.recents(listed)).toEqual(['opencode/glm-5.1', 'opencode/kimi-k2.7-code']);
      // Passada a janela (200 execuções mais novas), o modelo usado só antes dela sai de Recentes, e a consulta nunca devolve mais que o limite.
      await filler(RECENT_MODELS_SCAN_RUNS - 150);
      expect(await world.models.recents(listed)).toEqual(['opencode/glm-5.1']);
    } finally {
      await world.cleanup();
    }
  }, 60_000);

  it('um dono só com a chave da Anthropic não vê "Configure um provedor": o snapshot da conversa diz provedor configurado, o envio e a rotina rodam, e o resumo de Conexões não reclama', async () => {
    const world = await createRunsWorld();
    try {
      await world.connectAnthropic();
      await world.credentials.disconnect('provider', ORIGIN);
      const overview = await world.credentials.overview();
      expect(overview.provider.configured).toBe(false);
      expect(hasModelProvider(overview)).toBe(true);
      const bot = await world.createBot({ model: 'anthropic/claude-haiku-5-5' });
      world.engine.start();
      expect((await world.conversations.snapshot(bot.id)).providerConfigured).toBe(true);
      const run = await world.send(bot, 'olá');
      await world.waitForStatus(run, 'completed');
      const routine = await world.routines.create({ name: 'Só Claude', botId: bot.id, instruction: 'diga ok', schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null }, ORIGIN);
      await world.waitForStatus((await world.routines.runNow(routine.id, ORIGIN)).id, 'completed');
      // Sem nenhuma das duas chaves o aviso volta (a regra é "algum provedor", não "qualquer coisa").
      await world.credentials.disconnect('anthropic', ORIGIN);
      expect((await world.conversations.snapshot(bot.id)).providerConfigured).toBe(false);
      expect(await codeOf(world.send(bot, 'de novo'))).toBe('PROVIDER_NOT_CONFIGURED');
    } finally {
      await world.cleanup();
    }
  }, 60_000);
});
