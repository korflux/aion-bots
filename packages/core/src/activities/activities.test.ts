// Prova da tela Atividades (F15, A14; T11) contra PostgreSQL real, o motor de execução real, o provedor falso e o Composio falso:
// a pendência de aprovação e as execuções de todos os bots aparecem com bot, origem, estado e o cartão certo para onde o clique leva;
// `cancelled` fica de fora; a pendência vencida some; a lista pagina por cursor (50 por página, sem página fantasma, sem repetir
// nem pular); e a parada com `runId` nunca atinge uma execução que não é a que o dono viu.
import { randomUUID } from 'node:crypto';
import { ACTIVITIES_PAGE_SIZE } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocService } from '../docs';
import { DomainError } from '../errors';
import { ORIGIN, createRunsWorld, type RunsWorld } from '../runs/test-support';
import { tableMarker } from '../testing/fake-upstreams';
import { ActivityService } from './service';

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `INESPERADO:${String(error)}`;
  }
};

/** Só os itens dos bots do teste (a lista é global e os outros testes do arquivo deixam execuções no banco). */
const onlyBots = <T extends { bot: { id: string } | null }>(items: T[], ...ids: string[]): T[] => items.filter((item) => item.bot !== null && ids.includes(item.bot.id));

describe('execuções, pendências e navegação até o cartão', () => {
  let world: RunsWorld;
  let activities: ActivityService;

  beforeAll(async () => {
    world = await createRunsWorld({ engine: { approvalSweepMs: 40 } });
    await world.connectComposio();
    activities = new ActivityService({ pool: world.pool });
    world.engine.start();
  });
  afterAll(async () => {
    await world.cleanup();
  });

  const approvalCardOf = async (runId: string) =>
    (await world.pool.query<{ id: string; card_id: string }>('SELECT id::text AS id, card_id::text AS card_id FROM approvals WHERE run_id = $1', [runId])).rows[0];

  const lastVisible = async (runId: string): Promise<string> =>
    (
      await world.pool.query<{ id: string }>(
        "SELECT id::text AS id FROM messages WHERE run_id = $1 AND kind IN ('card', 'text') AND status <> 'discarded' ORDER BY messages.id DESC LIMIT 1",
        [runId],
      )
    ).rows[0]!.id;

  it('lista a pendência e as execuções de todos os bots, da mais nova à mais antiga, com origem, estado e o cartão de cada uma', async () => {
    const alfa = await world.createBot({ color: '#4ADE80' });
    const beta = await world.createBot();
    const gama = await world.createBot();
    const delta = await world.createBot();

    // Mensagem concluída e mensagem que falha (o provedor falso responde 503).
    const done = await world.send(alfa, 'oi');
    await world.waitForStatus(done, 'completed');
    const failed = await world.send(alfa, '[falha] provedor fora');
    await world.waitForStatus(failed, 'failed');
    // Rotina (origem "Rotina: Resumo").
    const routine = await world.routines.create(
      { name: 'Resumo', botId: gama.id, instruction: 'Resuma o dia', schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null },
      ORIGIN,
    );
    const routineRun = (await world.routines.runNow(routine.id, ORIGIN)).id;
    await world.waitForStatus(routineRun, 'completed');
    // Pedido de aprovação (a execução fica pausada, segurando a vaga do bot).
    await world.releaseConnectorAccounts(beta);
    const waiting = await world.send(beta, '[gmail] envie o relatório');
    await world.waitForStatus(waiting, 'waiting_approval');
    // Uma execução ativa e, atrás dela, uma na fila (enviar agora viraria complemento da ativa, CONV-03).
    const running = await world.send(delta, '[demorar]');
    await world.waitForStatus(running, 'running');
    const queued = await world.enqueue(delta, 'depois');

    const page = await activities.list(undefined);
    const mine = onlyBots(page.items, alfa.id, beta.id, gama.id, delta.id);
    expect(mine.map((item) => [item.runId, item.status, item.routineName])).toEqual([
      [queued, 'queued', null],
      [running, 'running', null],
      [waiting, 'waiting_approval', null],
      [routineRun, 'completed', 'Resumo'],
      [failed, 'failed', null],
      [done, 'completed', null],
    ]);
    // O bot de cada item vem com nome, cor e o estado de arquivado (avatar e nome da tela), sem personagem.
    expect(mine.at(-1)?.bot).toEqual({ id: alfa.id, name: alfa.name, color: '#4ADE80', archived: false });
    // O clique leva à última mensagem visível da execução (a resposta, o cartão de falha, o cartão de aprovação); na fila ainda não há nenhuma.
    expect(mine.find((item) => item.runId === done)?.messageId).toBe(await lastVisible(done));
    expect(mine.find((item) => item.runId === failed)?.messageId).toBe(await lastVisible(failed));
    expect(mine.find((item) => item.runId === routineRun)?.messageId).toBe(await lastVisible(routineRun));
    expect(mine.find((item) => item.runId === queued)?.messageId).toBeNull();
    expect(mine.find((item) => item.runId === running)?.messageId).not.toBeNull();
    const failureCard = (await world.timeline(alfa)).find((entry) => entry.id === mine.find((item) => item.runId === failed)?.messageId);
    expect(failureCard?.data).toMatchObject({ type: 'run_failed' });

    // A pendência: o bot, a ação legível e o app, a conta (A9: a conta liberada não tem nome, então vale o rótulo automático, o mesmo do cartão), o prazo e o cartão da aprovação na
    // conversa (o mesmo para onde o item da execução leva).
    const approval = await approvalCardOf(waiting);
    const pending = onlyBots(page.pending, beta.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual({
      approvalId: approval?.id,
      runId: waiting,
      bot: { id: beta.id, name: beta.name, color: beta.color, archived: false },
      sessionId: null,
      actionLabel: 'Send Email · Gmail',
      accountLabel: 'Gmail · ca_…1',
      expiresAt: pending[0]?.expiresAt,
      messageId: approval?.card_id,
    });
    expect(Date.parse(pending[0]!.expiresAt)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(mine.find((item) => item.runId === waiting)?.messageId).toBe(approval?.card_id);
    expect(page.nextCursor).toBeNull();

    // `cancelled` (rotina tirada da fila antes de começar) não aparece.
    await world.pool.query("UPDATE runs SET status = 'cancelled' WHERE id = $1", [queued]);
    expect(onlyBots((await activities.list(undefined)).items, delta.id).map((item) => item.runId)).toEqual([running]);
    await world.conversations.stop(delta.id);
    await world.waitForStatus(running, 'interrupted');
    await world.conversations.stop(beta.id);
    await world.waitForStatus(waiting, 'interrupted');
  });

  it('a pendência gravada antes da phase 13 (chamada sem conta) segue na lista, sem o campo da conta', async () => {
    const bot = await world.createBot();
    await world.releaseConnectorAccounts(bot);
    const run = await world.send(bot, '[gmail] envie');
    await world.waitForStatus(run, 'waiting_approval');
    // O pedido de antes da phase não tinha `account` na chamada gravada.
    await world.pool.query("UPDATE approvals SET call = call - 'account' WHERE run_id = $1", [run]);
    const [pending] = onlyBots((await activities.list(undefined)).pending, bot.id);
    expect(pending).toMatchObject({ runId: run, actionLabel: 'Send Email · Gmail' });
    expect(pending).not.toHaveProperty('accountLabel');
    await world.conversations.stop(bot.id, run);
    await world.waitForStatus(run, 'interrupted');
  });

  // A35 (decisão 23, phase 14): a linha pendente mostra o título do doc que a exclusão apagaria, lido do impacto que o cartão da aprovação gravou (a mesma fonte do cartão), nunca do argumento do modelo.
  it('a pendência de exclusão de doc traz o título do doc, da mesma fonte do cartão; a do conector segue sem ele', async () => {
    const bot = await world.createBot();
    const doc = await new DocService({ pool: world.pool }).create({ title: 'Plano', content: 'texto', botIds: [bot.id], operationId: randomUUID() }, { kind: 'owner' });
    const run = await world.send(bot, tableMarker('doc_delete', { docId: doc.id, operationId: randomUUID() }));
    await world.waitForStatus(run, 'waiting_approval');
    const approval = await approvalCardOf(run);
    const [pending] = onlyBots((await activities.list(undefined)).pending, bot.id);
    expect(pending).toEqual({
      approvalId: approval?.id,
      runId: run,
      bot: { id: bot.id, name: bot.name, color: bot.color, archived: false },
      sessionId: null,
      actionLabel: 'Excluir doc',
      docTitle: 'Plano',
      expiresAt: pending?.expiresAt,
      messageId: approval?.card_id,
    });
    // O título da linha é o do impacto gravado no cartão: a mesma fonte, sem coluna nem campo novo na chamada.
    const card = (await world.pool.query<{ data: { impact: { docTitle: string } } }>('SELECT data FROM messages WHERE id = $1', [approval?.card_id])).rows[0]!.data;
    expect(card.impact.docTitle).toBe(pending?.docTitle);
    // Pendência antiga (cartão sem impacto, como as gravadas antes da decisão 23): a linha segue, sem o título.
    await world.pool.query("UPDATE messages SET data = data - 'impact' WHERE id = $1", [approval?.card_id]);
    const [legacy] = onlyBots((await activities.list(undefined)).pending, bot.id);
    expect(legacy).toMatchObject({ runId: run, actionLabel: 'Excluir doc' });
    expect(legacy).not.toHaveProperty('docTitle');
    await world.conversations.stop(bot.id, run);
    await world.waitForStatus(run, 'interrupted');
  });

  it('parar com runId só vale para a execução ativa que o dono viu; a que começou depois não é tocada', async () => {
    const bot = await world.createBot();
    const first = await world.send(bot, '[demorar]');
    await world.waitForStatus(first, 'running');
    const second = await world.enqueue(bot, '[demorar]'); // na fila atrás da ativa (o envio viraria complemento, CONV-03)
    expect((await world.runRow(second)).status).toBe('queued');

    // O dono vê `first` ativa e clica em Parar; a parada acontece.
    expect((await world.conversations.stop(bot.id, first)).id).toBe(first);
    await world.waitForStatus(first, 'interrupted');
    await world.waitForStatus(second, 'running');

    // Uma lista desatualizada ainda mostra `first` ativa: o clique tardio é recusado e `second` segue intocada.
    expect(await codeOf(world.conversations.stop(bot.id, first))).toBe('RUN_NOT_ACTIVE');
    const untouched = await world.pool.query<{ stop_requested_at: Date | null }>('SELECT stop_requested_at FROM runs WHERE id = $1', [second]);
    expect(untouched.rows[0]?.stop_requested_at).toBeNull();
    // Execução de outro bot (ou inexistente) também não é alcançada pelo id do bot errado.
    const other = await world.createBot();
    expect(await codeOf(world.conversations.stop(other.id, second))).toBe('RUN_NOT_ACTIVE');
    expect((await world.runRow(second)).status).toBe('running');

    expect((await world.conversations.stop(bot.id, second)).id).toBe(second);
    await world.waitForStatus(second, 'interrupted');
    const items = onlyBots((await activities.list(undefined)).items, bot.id);
    expect(items.map((item) => [item.runId, item.status])).toEqual([
      [second, 'interrupted'],
      [first, 'interrupted'],
    ]);
  });

  it('parar a execução que espera aprovação tira a pendência da lista; a pendência vencida e o bot arquivado também são tratados', async () => {
    const waitingBot = await world.createBot();
    await world.releaseConnectorAccounts(waitingBot);
    const run = await world.send(waitingBot, '[gmail] envie');
    await world.waitForStatus(run, 'waiting_approval');
    expect(onlyBots((await activities.list(undefined)).pending, waitingBot.id)).toHaveLength(1);
    // As pendências só vêm na primeira página: com cursor a lista traz só execuções.
    expect((await activities.list('999999999999999')).pending).toEqual([]);

    // Relógio 25 h à frente: o pedido ainda consta `pending` no banco, mas já passou do prazo e não é mais respondível.
    const later = new ActivityService({ pool: world.pool, now: () => new Date(Date.now() + 25 * 3_600_000) });
    expect(onlyBots((await later.list(undefined)).pending, waitingBot.id)).toEqual([]);

    await world.conversations.stop(waitingBot.id, run);
    await world.waitForStatus(run, 'interrupted');
    const after = await activities.list(undefined);
    expect(onlyBots(after.pending, waitingBot.id)).toEqual([]);
    expect(onlyBots(after.items, waitingBot.id).map((item) => item.status)).toEqual(['interrupted']);

    // Bot arquivado: o histórico dele continua na lista, marcado como arquivado.
    await world.bots.archive(waitingBot.id, ORIGIN);
    expect(onlyBots((await activities.list(undefined)).items, waitingBot.id)[0]?.bot?.archived).toBe(true);
  });
});

describe('paginação por cursor', () => {
  let world: RunsWorld;
  let activities: ActivityService;

  beforeAll(async () => {
    world = await createRunsWorld();
    activities = new ActivityService({ pool: world.pool });
  });
  afterAll(async () => {
    await world.cleanup();
  });

  it('50 por página, do mais novo ao mais antigo, sem repetir nem pular, sem `cancelled` e sem página fantasma no limite exato', async () => {
    const bot = await world.createBot();
    const conversation = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
    // 120 execuções, as de número múltiplo de 10 canceladas: 108 visíveis.
    await world.pool.query(
      `INSERT INTO runs (conversation_id, bot_id, status, input, created_at)
       SELECT $1, $2, CASE WHEN g % 10 = 0 THEN 'cancelled' ELSE 'completed' END, 'x', now() FROM generate_series(1, 120) AS g`,
      [conversation, bot.id],
    );
    const visible = (await world.pool.query<{ id: string }>("SELECT id::text AS id FROM runs WHERE bot_id = $1 AND status <> 'cancelled' ORDER BY runs.id DESC", [bot.id])).rows.map((row) => row.id);
    expect(visible).toHaveLength(108);

    const first = await activities.list(undefined);
    const second = await activities.list(first.nextCursor ?? undefined);
    const third = await activities.list(second.nextCursor ?? undefined);
    expect([first, second, third].map((page) => page.items.length)).toEqual([ACTIVITIES_PAGE_SIZE, ACTIVITIES_PAGE_SIZE, 8]);
    expect(first.nextCursor).toBe(first.items.at(-1)?.runId);
    expect(second.nextCursor).toBe(second.items.at(-1)?.runId);
    expect(third.nextCursor).toBeNull();
    expect([...first.items, ...second.items, ...third.items].map((item) => item.runId)).toEqual(visible);

    // Limite exato: sobram 50 depois do cursor e não existe uma terceira página vazia.
    const exact = await activities.list(visible[57]);
    expect(exact.items).toHaveLength(ACTIVITIES_PAGE_SIZE);
    expect(exact.nextCursor).toBeNull();
    // Cursor depois do fim: página vazia, sem erro.
    expect(await activities.list(visible.at(-1))).toMatchObject({ pending: [], items: [], nextCursor: null });
  });
});
