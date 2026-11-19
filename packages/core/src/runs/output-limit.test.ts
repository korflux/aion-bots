// Limite de saída: (1) o teto de saída por etapa (phase 12, F1) que o corpo enviado ao provedor leva, sempre o mesmo número da estimativa e nunca acima da capacidade de saída confirmada
// do modelo; (2) persistência real, descarte global de chamadas e continuação explícita da mesma execução.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tableCreateSchema } from '@aion/shared';
import { DomainError } from '../errors';
import { GeneralChatService } from '../general-chat/service';
import { createLogger } from '../logging';
import { TableService } from '../tables/service';
import type { ChatEvent, ChatProtocol, ChatRequest } from '../models/chat-protocols';
import { estimateChatPayload } from './context-budget';
import { createRunsWorld, ORIGIN, waitFor } from './test-support';

/**
 * Capacidade de saída confirmada simulada do `opencode/glm-5.1` (nulo = sem capacidade, o caso real do modelo). O contexto confirmado fica em 1M, acima de toda opção de janela, para que só a
 * saída limite o envelope. Hoisted porque o `vi.mock` roda antes dos imports; os demais testes do arquivo rodam com nulo, que é o registro real.
 */
const modelCapacity = vi.hoisted(() => ({ outputTokens: null as number | null }));
vi.mock('../models/context-capacity', () => ({
  readModelContextCapacity: (model: string | null) => (modelCapacity.outputTokens !== null && model === 'opencode/glm-5.1'
    ? { provider: 'opencode_go', model, contextTokens: 1_000_000, outputTokens: modelCapacity.outputTokens, source: 'https://exemplo.test/glm-5-1', checkedAt: '2026-10-18T00:00:00.000Z' }
    : null),
}));
afterEach(() => { modelCapacity.outputTokens = null; });

// A1 e A2 (phase 12, F1): a reserva de saída é o menor entre 32.768, 25% da janela efetiva e a capacidade de saída confirmada, e é o MESMO número na estimativa, no log e no `max_tokens` do
// corpo capturado no provedor falso; o corpo nunca passa da capacidade confirmada. Os valores esperados são os da spec, escritos à mão.
describe('teto de saída por etapa', () => {
  it.each([
    { window: 65536, outputCapacity: null, expected: 16384, inputBudget: 47104 },
    { window: 262144, outputCapacity: null, expected: 32768, inputBudget: 227328 },
    { window: 262144, outputCapacity: 4096, expected: 4096, inputBudget: 262144 - 4096 - 2048 },
  ] as const)('janela $window com capacidade de saída $outputCapacity: o corpo leva max_tokens $expected, o mesmo da estimativa e do log', async ({ window, outputCapacity, expected, inputBudget }) => {
    modelCapacity.outputTokens = outputCapacity;
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', name: 'output-limit-test', destination: { write: (line: string) => void lines.push(line) } });
    const world = await createRunsWorld({ contextWindow: window, logger });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const sent: { protocol: ChatProtocol; request: ChatRequest }[] = [];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, protocol, request): AsyncGenerator<ChatEvent> {
        sent.push({ protocol, request });
        yield { type: 'text', text: 'Pronto.' };
        yield { type: 'done', reason: 'stop' };
      });
      const runId = await world.send(bot, 'Responder.'); world.engine.start(); await world.waitForStatus(runId, 'completed');
      expect(sent).toHaveLength(1);
      const { protocol, request } = sent[0]!;
      expect(request.maxTokens).toBe(expected);
      if (outputCapacity !== null) expect(request.maxTokens).toBeLessThanOrEqual(outputCapacity);
      // Mesmo número na estimativa: a medição gravada na preparação leva a reserva e o orçamento do envelope que o corpo usou.
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      expect((await world.pool.query<{ measurement: unknown }>('SELECT measurement FROM conversation_context WHERE conversation_id = $1', [conversationId])).rows[0]!.measurement).toMatchObject({ outputReserve: expected, inputBudget, margin: 2048 });
      // E no log "contexto enviado ao modelo": os bytes do corpo estimado são os do corpo capturado (com 4.096 o `max_tokens` tem um dígito a menos que o teto base, então um log feito com o teto cru divergiria).
      const logged = lines.map((line) => JSON.parse(line) as { msg?: string; payloadBytes?: number }).find((entry) => entry.msg === 'contexto enviado ao modelo');
      expect(logged?.payloadBytes).toBe(estimateChatPayload(request, protocol).payloadBytes);
    } finally { await world.cleanup(); vi.restoreAllMocks(); }
  });
});

describe('limite de saída e continuação', () => {
  it('fixture HTTP mantém o pedido original como identidade após os cartões user e o Continue manual', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const runId = await world.send(bot, `[saida-limitada-manual] concluir ${bot.id}`); world.engine.start(); await world.waitForStatus(runId, 'limit_reached');
      const cards = (await world.timeline(bot)).filter((message) => message.data.type === 'run_limit');
      expect(cards.map((message) => (message.data.continuation as { automatic: boolean } | undefined)?.automatic)).toEqual([true, false]);
      await world.conversations.continueRun(bot.id, runId, cards.at(-1)!.id); await world.waitForStatus(runId, 'completed');
      expect((await world.timeline(bot)).filter((message) => message.role === 'assistant' && message.kind === 'text').at(-1)?.content).toBe('Resposta concluída após continuar.');
      expect((await world.pool.query('SELECT id FROM runs')).rowCount).toBe(1);
    } finally { await world.cleanup(); }
  });
  it.each(['bot', 'routine', 'session'] as const)('%s: preserva o checkpoint e aceita uma só continuação no mesmo run após reinício', async (kind) => {
    const world = await createRunsWorld();
    let resumed: ReturnType<typeof world.createEngine> | undefined;
    try {
      const bot = await world.createBot();
      await world.models.test('opencode/glm-5.1');
      const ref = kind === 'session' ? { sessionId: (await new GeneralChatService({ pool: world.pool }).create()).id } : bot.id;
      if (typeof ref !== 'string') await world.conversations.setPreference(ref, 'opencode/glm-5.1', null);
      const tables = new TableService({ pool: world.pool });
      const table = await tables.create(tableCreateSchema.parse({ operationId: randomUUID(), name: 'Checkpoint', columns: [{ name: 'Valor', type: 'text' }] }), { kind: 'owner' }, bot.id);
      const columnId = table.columns[0]!.id;
      const operationId = randomUUID();
      const args = JSON.stringify({ tableId: table.id, input: { operationId, expectedSchemaVersion: table.schemaVersion, creates: [{ deduplicationKey: 'unico', values: { [columnId]: 'confirmado' } }] } });
      let stage = 0;
      const requests: ChatRequest[] = [];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        requests.push(request);
        if (kind !== 'session' && stage++ === 0) {
          yield { type: 'tool_call', id: 'write-confirmed', name: 'table_write', arguments: args };
          yield { type: 'done', reason: 'stop' };
        } else if (requests.length <= (kind === 'session' ? 2 : 3)) {
          yield { type: 'text', text: 'Texto preservado, incompleto.' };
          // Mesmo uma chamada bem formada não está autorizada quando a resposta inteira foi cortada.
          yield { type: 'tool_call', id: 'must-not-execute', name: 'table_write', arguments: args };
          yield { type: 'done', reason: 'output_limit' };
        } else {
          yield { type: 'text', text: 'Concluído após continuar.' };
          yield { type: 'done', reason: 'stop' };
        }
      });
      const routine = kind === 'routine' ? await world.routines.create({ botId: bot.id, name: 'Rotina limite', instruction: 'Criar um lançamento e concluir.', timezone: 'America/Sao_Paulo', schedule: { type: 'daily', times: ['08:00'] }, startsAt: null, endsAt: null, maxRuns: null }, ORIGIN) : null;
      const runId = routine ? (await world.routines.runNow(routine.id, ORIGIN)).id : (await world.conversations.send(ref, 'Criar e concluir.')).id;
      world.engine.start();
      await world.waitForStatus(runId, 'limit_reached');
      await world.engine.stop();
      const before = await world.runRow(runId);
      const records = await tables.records(table.id, { kind: 'owner' });
      expect(records.records).toHaveLength(kind === 'session' ? 0 : 1);
      expect(before.tool_calls).toBe(kind === 'session' ? 0 : 1);
      const snapshot = await world.conversations.snapshot(ref);
      expect(snapshot.items).toContainEqual(expect.objectContaining({ kind: 'text', role: 'assistant', incomplete: true, content: 'Texto preservado, incompleto.' }));
      expect(snapshot.items).toContainEqual(expect.objectContaining({ kind: 'card', card: expect.objectContaining({ type: 'run_limit', limit: 'tokens' }) }));
      const limitCard = snapshot.items.find((item) => item.kind === 'card' && item.card.type === 'run_limit' && !item.card.continuation?.automatic)!;
      const concurrent = await Promise.allSettled([world.conversations.continueRun(ref, runId, limitCard.id), world.conversations.continueRun(ref, runId, limitCard.id)]);
      expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(concurrent.find((result) => result.status === 'fulfilled')).toMatchObject({ value: { id: runId, status: 'queued' } });
      expect(concurrent.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'RUN_NOT_RETRYABLE' } });
      resumed = world.createEngine(); resumed.start();
      await world.waitForStatus(runId, 'completed');
      expect((await world.runRow(runId)).tool_calls).toBe(before.tool_calls);
      expect((await world.runRow(runId)).active_ms).toBeGreaterThanOrEqual(before.active_ms);
      expect(await tables.records(table.id, { kind: 'owner' })).toEqual(records);
      const turns = JSON.stringify(requests.at(-1)!.turns);
      expect(turns).toContain('Texto preservado, incompleto.');
      expect(turns).toContain('Ao continuar');
      if (kind !== 'session') { expect(turns).toContain('write-confirmed'); expect(turns).toContain('confirmado'); }
      const runs = await world.pool.query('SELECT id FROM runs'); expect(runs.rows.map((row) => String(row.id))).toEqual([runId]);
      if (kind === 'session') {
        await expect(world.conversations.continueRun(ref, runId, limitCard.id)).rejects.toMatchObject({ code: 'RUN_NOT_RETRYABLE' });
        const regenerated = await world.conversations.retry(ref, runId);
        expect(regenerated.id).not.toBe(runId);
        expect(regenerated.status).toBe('queued');
      }

      if (routine) {
        expect((await world.pool.query('SELECT id FROM routine_occurrences WHERE routine_id=$1', [routine.id])).rowCount).toBe(1);
        expect((await world.pool.query("SELECT data->>'state' AS state FROM messages WHERE run_id=$1 AND data->>'type'='routine_run'", [runId])).rows).toEqual([{ state: 'completed' }]);
      }
    } finally { await resumed?.stop(); await world.cleanup(); vi.restoreAllMocks(); }
  });

  it.each([{ kind: 'bot', limit: 'steps' }, { kind: 'bot', limit: 'time' }, { kind: 'bot', limit: 'tokens' }, { kind: 'session', limit: 'steps' }, { kind: 'session', limit: 'time' }, { kind: 'session', limit: 'tokens' }] as const)('$kind tokens→continuar→$limit: cartão antigo não autoriza outro trecho', async ({ kind, limit }) => {
    const world = await createRunsWorld();
    let resumed: ReturnType<typeof world.createEngine> | undefined;
    try {
      const bot = await world.createBot({ stepLimit: 1 }); await world.models.test('opencode/glm-5.1');
      const ref = kind === 'session' ? { sessionId: (await new GeneralChatService({ pool: world.pool }).create()).id } : bot.id;
      if (typeof ref !== 'string') await world.conversations.setPreference(ref, 'opencode/glm-5.1', null);
      // A visão pública fornece a revisão terminal que o clique confirma.
      const messages = async () => (await world.conversations.snapshot(ref)).items.filter((message) => message.kind === 'card' && message.card.type === 'run_limit' && !message.card.continuation?.automatic);
      let called = 0;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (): AsyncGenerator<ChatEvent> {
        if (called++ < 2) { yield { type: 'text', text: 'Incompleto' }; yield { type: 'done', reason: 'output_limit' }; }
        else {
          for (let index = 0; index < 26; index++) yield { type: 'tool_call', id: String(index), name: 'search_history', arguments: '{"query":"a"}' };
          yield { type: 'done', reason: limit === 'tokens' ? 'output_limit' : 'stop' };
        }
      });
      const runId = (await world.conversations.send(ref, 'Teste')).id; world.engine.start(); await world.waitForStatus(runId, 'limit_reached'); await world.engine.stop();
      const before = await world.runRow(runId);
      const tokenCard = (await messages()).at(-1)!;
      await world.conversations.continueRun(ref, runId, tokenCard.id);
      resumed = world.createEngine(limit === 'time' ? { maxActiveMs: before.active_ms } : {});
      resumed.start(); await world.waitForStatus(runId, 'limit_reached');
      const cards = await messages();
      expect(cards.map((message) => message.kind === 'card' && message.card.type === 'run_limit' ? message.card.limit : null)).toEqual(['tokens', limit]);
      const terminal = await world.runRow(runId);
      await expect(world.conversations.continueRun(ref, runId, tokenCard.id)).rejects.toMatchObject({ code: 'RUN_NOT_RETRYABLE' });
      expect(await world.runRow(runId)).toEqual(terminal);
      expect((await world.pool.query('SELECT id FROM runs')).rowCount).toBe(1);
      if (limit === 'tokens') {
        await resumed.stop();
        expect(await world.conversations.continueRun(ref, runId, cards.at(-1)!.id)).toMatchObject({ id: runId, status: 'queued' });
        expect((await world.runRow(runId)).tool_calls).toBe(terminal.tool_calls);
      }
    } finally { await resumed?.stop(); await world.cleanup(); vi.restoreAllMocks(); }
  });

  it('complemento promovido invalida a continuação antiga e mantém seu histórico', async () => {
    const world = await createRunsWorld();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let attempt = 0;
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (): AsyncGenerator<ChatEvent> {
        if (attempt++ === 0) { yield { type: 'done', reason: 'output_limit' }; return; }
        entered = true;
        await barrier;
        yield { type: 'text', text: 'Histórico anterior preservado' };
        yield { type: 'done', reason: 'output_limit' };
      });
      const runId = await world.send(bot, 'Executar'); world.engine.start();
      await waitFor('modelo aguardando complemento', async () => entered);
      const complement = await world.conversations.send(bot.id, 'Complemento pendente');
      expect(complement).toHaveProperty('kind', 'complement');
      expect((await world.pool.query("SELECT state FROM complements WHERE run_id=$1", [runId])).rows).toEqual([{ state: 'pending' }]);
      release(); await world.waitForStatus(runId, 'limit_reached'); await world.engine.stop();
      expect((await world.pool.query('SELECT id FROM runs WHERE id > $1', [runId])).rowCount).toBe(1);
      await expect(world.conversations.continueRun(bot.id, runId, (await world.timeline(bot)).find((message) => message.data.type === 'run_limit' && !(message.data.continuation as { automatic?: boolean } | undefined)?.automatic)!.id)).rejects.toMatchObject<Partial<DomainError>>({ code: 'RUN_NOT_RETRYABLE' });
      expect((await world.timeline(bot)).some((message) => message.runId === runId && message.content === 'Histórico anterior preservado')).toBe(true);
    } finally { release(); await world.cleanup(); vi.restoreAllMocks(); }
  });

  it.each(['unknown', 'missing'] as const)('%s: terminal não comprovado nunca completa nem executa chamada', async (reason) => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot();
      await world.models.test('opencode/glm-5.1');
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'text', text: 'Trecho interrompido' };
        yield { type: 'tool_call', id: 'untrusted', name: 'table_create', arguments: JSON.stringify({ input: { operationId: randomUUID(), name: 'Não criar' } }) };
        if (reason === 'unknown') yield { type: 'done', reason: 'unknown' };
      });
      const runId = await world.send(bot, 'Testar terminal'); world.engine.start(); await world.waitForStatus(runId, 'failed');
      expect((await world.runRow(runId)).failure_code).toBe('PROVIDER_ERROR');
      expect((await world.pool.query('SELECT id FROM data_tables')).rowCount).toBe(0);
      expect((await world.runRow(runId)).tool_calls).toBe(0);
    } finally { await world.cleanup(); vi.restoreAllMocks(); }
  });
});
