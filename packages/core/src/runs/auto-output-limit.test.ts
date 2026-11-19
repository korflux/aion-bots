// Orçamento automático persistido e descarte de chamadas truncadas, com worker/banco/ferramentas reais.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { tableCreateSchema } from '@aion/shared';
import type { ChatEvent } from '../models/chat-protocols';
import { TableService } from '../tables/service';
import { createRunsWorld, waitFor } from './test-support';

describe('continuação automática limitada', () => {
  it('ferramentas com erro não renovam o progresso entre dois cortes', async () => {
    const world = await createRunsWorld(); let responses = 0;
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (): AsyncGenerator<ChatEvent> {
        if (responses++ % 2 === 0) {
          yield { type: 'tool_call', id: `invalid-${responses}`, name: 'search_history', arguments: '{"query":1}' };
          yield { type: 'done', reason: 'stop' };
        } else yield { type: 'done', reason: 'output_limit' };
      });
      const runId = await world.send(bot, 'Não insistir em erro'); world.engine.start(); await world.waitForStatus(runId, 'limit_reached');
      const timeline = await world.timeline(bot);
      expect(timeline.filter((message) => message.kind === 'activity').map((message) => message.status)).toEqual(['failed', 'failed']);
      expect(timeline.filter((message) => message.data.type === 'run_limit').map((message) => message.data.continuation)).toEqual([
        { automatic: true, count: 1, consecutiveCuts: 1, confirmedTools: 0 },
        { automatic: false, count: 1, consecutiveCuts: 2, confirmedTools: 0 },
      ]);
    } finally { await world.cleanup(); vi.restoreAllMocks(); }
  });
  it('progresso confirmado permite três autos; restart e Continue manual não renovam o orçamento nem repetem escrita', async () => {
    const world = await createRunsWorld(); let resumed: ReturnType<typeof world.createEngine> | undefined;
    let paused = false; let pauseOnce = true;
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const tables = new TableService({ pool: world.pool }); const owner = { kind: 'owner' } as const;
      const table = await tables.create(tableCreateSchema.parse({ operationId: randomUUID(), name: 'Progresso', columns: [{ name: 'Nome', type: 'text' }] }), owner, bot.id);
      const column = table.columns[0]!.id;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, _request, signal): AsyncGenerator<ChatEvent> {
        const records = (await tables.records(table.id, owner)).records;
        const cuts = (await world.pool.query("SELECT data FROM messages WHERE data->>'type'='run_limit' AND data->>'limit'='tokens' ORDER BY id")).rows;
        if (cuts.length === 1 && pauseOnce) {
          pauseOnce = false; paused = true;
          await new Promise<void>((_resolve, reject) => { signal!.addEventListener('abort', () => reject(new Error('parada da fixture')), { once: true }); });
        }
        if (records.length === cuts.length) {
          yield { type: 'tool_call', id: `write-${records.length}`, name: 'table_write', arguments: JSON.stringify({ tableId: table.id, input: { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [{ deduplicationKey: `row-${records.length}`, values: { [column]: String(records.length) } }] } }) };
          yield { type: 'done', reason: 'stop' };
        } else {
          yield { type: 'text', text: 'Trecho incompleto' };
          yield { type: 'tool_call', id: 'partial', name: 'table_create', arguments: '{' };
          yield { type: 'done', reason: 'output_limit' };
        }
      });
      const runId = await world.send(bot, 'Gravar e continuar'); world.engine.start();
      await waitFor('primeiro checkpoint automático', async () => paused); await world.engine.stop();
      const before = await world.runRow(runId); expect(before.status).toBe('running'); expect(before.tool_calls).toBe(1);
      resumed = world.createEngine(); resumed.start(); await world.waitForStatus(runId, 'limit_reached'); await resumed.stop();
      const cards = (await world.timeline(bot)).filter((message) => message.data.type === 'run_limit');
      expect(cards.map((message) => (message.data.continuation as { count: number }).count)).toEqual([1, 2, 3, 3]);
      // A4 (phase 12): o teto de saída vale por etapa e não acumula entre continuações: toda chamada principal, inclusive as das três continuações automáticas, leva a mesma reserva (16.384 na janela de 64k do mundo de teste).
      expect([...new Set(vi.mocked(world.provider.streamChat).mock.calls.map((call) => call[2].maxTokens))]).toEqual([16384]);
      expect(cards.map((message) => (message.data.continuation as { consecutiveCuts: number }).consecutiveCuts)).toEqual([1, 1, 1, 1]);
      expect((await tables.records(table.id, owner)).records.map((record) => record.version)).toEqual([1, 1, 1, 1]);
      expect((await world.runRow(runId)).tool_calls).toBe(4);
      expect((await world.pool.query('SELECT id FROM data_tables')).rowCount).toBe(1);
      // Simula queda entre checkpoint terminal e settle: o novo worker deve finalizar sem pedir outra resposta.
      const requestsBeforeRecovery = vi.mocked(world.provider.streamChat).mock.calls.length;
      await world.pool.query("UPDATE runs SET status='running', lease_until=now()-interval '1 second' WHERE id=$1", [runId]);
      const recovering = world.createEngine(); try { recovering.start(); await world.waitForStatus(runId, 'limit_reached'); } finally { await recovering.stop(); }
      expect(vi.mocked(world.provider.streamChat).mock.calls.length).toBe(requestsBeforeRecovery);
      await world.conversations.continueRun(bot.id, runId, cards.at(-1)!.id);
      const manual = world.createEngine(); try { manual.start(); await world.waitForStatus(runId, 'limit_reached'); } finally { await manual.stop(); }
      expect((await world.runRow(runId)).tool_calls).toBe(5);
      const last = (await world.timeline(bot)).filter((message) => message.data.type === 'run_limit').at(-1)!;
      expect(last.data.continuation).toMatchObject({ count: 3, automatic: false });
      expect((await world.pool.query('SELECT id FROM runs')).rowCount).toBe(1);
    } finally { await resumed?.stop(); await world.cleanup(); vi.restoreAllMocks(); }
  });
  it.each(['stop', 'time', 'steps'] as const)('%s continua prioritário durante auto e não declara completed', async (kind) => {
    const maxActiveMs = 60_000;
    const world = await createRunsWorld({ engine: { maxActiveMs } });
    let call = 0; let entered = false;
    try {
      const bot = await world.createBot({ stepLimit: 1 }); await world.models.test('opencode/glm-5.1');
      // Só o cenário time avança o tempo ativo, depois do checkpoint automático: carga do setup não decide a prova.
      // Timers, PostgreSQL e espera monotônica permanecem reais; o prazo de streaming já é coberto nas provas do motor.
      const wallNow = Date.now.bind(Date); let elapsedOffset = 0;
      if (kind === 'time') vi.spyOn(Date, 'now').mockImplementation(() => wallNow() + elapsedOffset);
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, _request, signal): AsyncGenerator<ChatEvent> {
        if (call++ === 0) { yield { type: 'done', reason: 'output_limit' }; return; }
        entered = true;
        if (kind === 'time') { elapsedOffset = maxActiveMs + 1; yield { type: 'done', reason: 'output_limit' }; return; }
        if (kind === 'steps') {
          for (let index = 0; index < 2; index++) yield { type: 'tool_call', id: String(index), name: 'search_history', arguments: '{"query":"x"}' };
          yield { type: 'done', reason: 'stop' }; return;
        }
        await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('parada da fixture')), { once: true }));
      });
      const runId = await world.send(bot, 'Continuação'); world.engine.start(); await waitFor('modelo em continuação automática', async () => entered);
      if (kind === 'stop') await world.conversations.stop(bot.id);
      await world.waitForStatus(runId, kind === 'stop' ? 'interrupted' : 'limit_reached');
      expect((await world.runRow(runId)).tool_calls).toBe(0);
      const cards = (await world.timeline(bot)).filter((message) => message.kind === 'card');
      expect(cards[0]!.data.continuation).toMatchObject({ automatic: true, count: 1 });
      expect(cards.at(-1)!.data).toMatchObject(kind === 'stop' ? { type: 'run_interrupted' } : { type: 'run_limit', limit: kind });
    } finally { await world.cleanup(); vi.restoreAllMocks(); }
  });

});
