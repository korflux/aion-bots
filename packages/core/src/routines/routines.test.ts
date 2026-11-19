// Prova das rotinas agendadas contra PostgreSQL real, o provedor falso e o motor de execução de verdade (T9; aceites A4, A12, F12, F13; phase 10, A12 a A15):
// o disparo no horário previsto com o cartão da rotina, uma execução por horário mesmo com reinícios e dois agendadores, os atrasos
// de 30 e de 90 minutos, pausar/editar/excluir com uma execução em andamento, o arquivamento do bot, os limites, "executar agora", a
// rotina que o bot cria e que já vale (com a proposta antiga pendente ainda confirmável), recusar e editar pelo cartão (desfazer cada caso, inclusive a
// exclusão com o histórico, idempotência, "mudou depois", avisos ao bot sem acender a bolinha) e o histórico. O relógio é uma variável: o teste avança o tempo em vez de esperar.
import type { Bot, RoutineInput, RoutineProposal, RoutineProposalCard, RoutineReplace, RoutineScheduleSettings } from '@aion/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../errors';
import { proposeRoutineTool } from '../runs/propose-routine';
import { ORIGIN, createRunsWorld, waitFor, type RunsWorld } from '../runs/test-support';
import type { ToolContext } from '../runs/tools';
import { RoutineScheduler } from './scheduler';
import { RoutineService } from './service';

const SP = 'America/Sao_Paulo';
/** 06:00 em Brasília: a rotina diária das 07:00 vence às 10:00Z. */
const START = new Date('2026-10-01T09:00:00Z');
let clock = START;
let world: RunsWorld;

beforeAll(async () => {
  world = await createRunsWorld({ now: () => clock });
  world.engine.start();
});

afterAll(async () => {
  await world.cleanup();
});

afterEach(async () => {
  // Os agendadores tratam TODAS as rotinas vencidas do banco: cada teste devolve o banco sem rotinas e o relógio ao início.
  await world.pool.query('DELETE FROM routine_occurrences');
  await world.pool.query('UPDATE runs SET routine_id = NULL WHERE routine_id IS NOT NULL');
  await world.pool.query('DELETE FROM routines');
  clock = START;
});

const daily = (time: string): RoutineScheduleSettings => ({ schedule: { type: 'daily', times: [time] }, timezone: SP, startsAt: null, endsAt: null, maxRuns: null });
const every5: RoutineScheduleSettings = { schedule: { type: 'interval', every: 5, unit: 'minutes', window: null }, timezone: SP, startsAt: null, endsAt: null, maxRuns: null };

async function createRoutine(botId: string, overrides: Partial<RoutineInput> = {}) {
  return world.routines.create({ name: 'Resumo', botId, instruction: 'Resuma o dia', ...daily('07:00'), ...overrides }, ORIGIN);
}

const runsOf = async (routineId: string) =>
  (await world.pool.query<{ id: string; status: string; input: string; routine_name: string | null; routine_id: string | null }>(
    'SELECT id::text AS id, status, input, routine_name, routine_id FROM runs WHERE routine_id = $1 ORDER BY runs.id',
    [routineId],
  )).rows;

const occurrencesOf = async (routineId: string) =>
  (await world.pool.query<{ scheduled_for: Date; outcome: string; manual: boolean; run_id: string | null; message_id: string | null }>(
    'SELECT scheduled_for, outcome, manual, run_id::text AS run_id, message_id::text AS message_id FROM routine_occurrences WHERE routine_id = $1 ORDER BY id',
    [routineId],
  )).rows;

/** Um bot ocupado com uma execução que só termina quando o dono pára (a fila dele passa a acumular). */
async function busyBot() {
  const bot = await world.createBot();
  const run = await world.send(bot, '[demorar]');
  await world.waitForStatus(run, 'running');
  return { bot, run };
}

describe('disparo no horário previsto (F13, A12)', () => {
  it('dia útil e mensal ajustado disparam os horários da prévia com fila/motor reais e relógio controlado', async () => {
    clock = new Date('2027-01-01T11:59:00Z');
    const bot = await world.createBot();
    for (const schedule of [{ type: 'monthly_business_day', position: 1, time: '09:00' }, { type: 'monthly_day', day: 31, time: '09:00' }] as const) {
      const settings = { schedule, timezone: SP, startsAt: null, endsAt: null, maxRuns: 2 };
      const preview = world.routines.preview(settings);
      expect(preview.valid).toBe(true);
      const routine = await createRoutine(bot.id, settings);
      expect(routine.nextRunAt).toBe(preview.occurrences[0]);
      for (const expected of preview.occurrences.slice(0, 2)) {
        clock = new Date(Date.parse(expected) + 30_000);
        expect(await world.scheduler.tickOnce()).toBe(1);
        const run = (await runsOf(routine.id)).at(-1)!;
        await world.waitForStatus(run.id, 'completed');
        expect((await occurrencesOf(routine.id)).at(-1)?.scheduled_for.toISOString()).toBe(expected);
        expect(await world.scheduler.tickOnce()).toBe(0);
      }
      expect((await world.routines.get(routine.id)).status).toBe('completed');
      clock = new Date('2027-01-01T11:59:00Z');
    }
  });
  it('dispara no horário, enfileira no bot e a execução abre o cartão da rotina com o tipo de disparo schedule', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id);
    expect(routine.status).toBe('active');
    expect(routine.nextRunAt).toBe('2026-10-01T10:00:00.000Z');
    expect((await world.pool.query<{ trigger_kind: string }>('SELECT trigger_kind FROM routines WHERE id = $1', [routine.id])).rows[0]?.trigger_kind).toBe('schedule');

    expect(await world.scheduler.tickOnce()).toBe(0); // ainda não chegou a hora
    expect(await runsOf(routine.id)).toEqual([]);

    clock = new Date('2026-10-01T10:00:30Z');
    expect(await world.scheduler.tickOnce()).toBe(1);
    const [run] = await runsOf(routine.id);
    expect(run).toMatchObject({ input: 'Resuma o dia', routine_name: 'Resumo' });
    expect((await world.routines.get(routine.id)).nextRunAt).toBe('2026-10-02T10:00:00.000Z');
    expect((await world.routines.get(routine.id)).runCount).toBe(1);

    await world.waitForStatus((run as { id: string }).id, 'completed');
    const timeline = await world.timeline(bot);
    const card = timeline.find((entry) => entry.kind === 'card' && entry.data.type === 'routine_run');
    expect(card).toBeDefined();
    expect(card?.role).toBe('system');
    expect(card?.data).toMatchObject({ routineId: routine.id, routineName: 'Resumo', scheduledFor: '2026-10-01T10:00:00.000Z', manual: false, state: 'completed', failureCode: null });
    // T20: o resultado do bot NÃO é copiado para o cartão (apareceria duas vezes na conversa); ele é a mensagem do bot logo abaixo.
    expect(card?.data).not.toHaveProperty('result');
    const reply = timeline.find((entry) => entry.kind === 'text' && entry.role === 'assistant');
    expect(String(reply?.content)).toContain('Resuma o dia'); // o provedor falso ecoa o último turno
    // A execução de rotina não gera o cartão de falha nem a bolha do dono; o cartão da rotina abre a rodada.
    expect(timeline.some((entry) => entry.role === 'user')).toBe(false);

    // O modelo recebe o cartão como o início da rodada, com a instrução.
    const messages = (world.conversationRequests().at(-1)?.body as { messages: { role: string; content: string }[] }).messages;
    const lastUser = messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
    expect(lastUser).toContain('[Sistema] Rotina "Resumo" iniciada');
    expect(lastUser).toContain('Instrução da rotina: Resuma o dia');
  });

  it('o cartão que o modelo lê traz o horário previsto no fuso do dono (Configurações), e não num fuso fixo (T28)', async () => {
    await world.pool.query("UPDATE app_settings SET time_zone = 'America/New_York'");
    try {
      const bot = await world.createBot();
      const routine = await createRoutine(bot.id);
      clock = new Date('2026-10-01T10:00:30Z');
      await world.scheduler.tickOnce();
      const [run] = await runsOf(routine.id);
      await world.waitForStatus((run as { id: string }).id, 'completed');
      const messages = (world.conversationRequests().at(-1)?.body as { messages: { role: string; content: string }[] }).messages;
      // 10:00Z é 06:00 em Nova York (horário de verão) e 07:00 em Brasília: o cartão diz o horário do dono, não o de Brasília.
      expect(messages.filter((message) => message.role === 'user').at(-1)?.content).toContain('(horário previsto: 01/10/2026, 06:00)');
    } finally {
      await world.pool.query("UPDATE app_settings SET time_zone = 'America/Sao_Paulo'");
    }
  });

  it('uma execução por horário previsto, mesmo com dois agendadores ao mesmo tempo e depois de um reinício', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id);
    clock = new Date('2026-10-01T10:00:05Z');
    const other = new RoutineScheduler({ pool: world.pool, logger: world.logger, now: () => clock });
    const handled = await Promise.all([world.scheduler.tickOnce(), other.tickOnce()]);
    expect(handled.reduce((sum, value) => sum + value, 0)).toBe(1);

    // "Reinício": outro agendador, mesmo banco, mesmo instante.
    const restarted = new RoutineScheduler({ pool: world.pool, logger: world.logger, now: () => clock });
    expect(await restarted.tickOnce()).toBe(0);
    expect(await runsOf(routine.id)).toHaveLength(1);
    expect(await occurrencesOf(routine.id)).toHaveLength(1);

    // Um horário previsto já tratado não se repete nem forçando o ponteiro para trás (o índice único é a segunda defesa).
    await world.pool.query("UPDATE routines SET next_run_at = '2026-10-01T10:00:00Z' WHERE id = $1", [routine.id]);
    await world.scheduler.tickOnce();
    expect(await runsOf(routine.id)).toHaveLength(1);
    expect(await occurrencesOf(routine.id)).toHaveLength(1);
  });
});

describe('execução perdida (spec decisão 15, F13 passo 3)', () => {
  it('atraso de 30 minutos: roda uma vez, no horário previsto original', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id);
    clock = new Date('2026-10-01T10:30:00Z');
    await world.scheduler.tickOnce();
    const occurrences = await occurrencesOf(routine.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ outcome: 'fired', manual: false });
    expect(occurrences[0]?.scheduled_for.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(await runsOf(routine.id)).toHaveLength(1);
  });

  it('atraso de 90 minutos: não executa, registra perdida no histórico e no cartão, e segue para o próximo horário', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id);
    clock = new Date('2026-10-01T11:30:00Z');
    await world.scheduler.tickOnce();
    expect(await runsOf(routine.id)).toEqual([]);
    const [occurrence] = await occurrencesOf(routine.id);
    expect(occurrence).toMatchObject({ outcome: 'missed', run_id: null });
    expect(occurrence?.message_id).not.toBeNull();
    const card = (await world.timeline(bot)).find((entry) => entry.data.type === 'routine_missed');
    expect(card?.data).toMatchObject({ routineId: routine.id, routineName: 'Resumo', scheduledFor: '2026-10-01T10:00:00.000Z' });
    expect((await world.routines.get(routine.id)).nextRunAt).toBe('2026-10-02T10:00:00.000Z');
    expect((await world.routines.get(routine.id)).runCount).toBe(0);
    const history = await world.routines.history(routine.id, undefined);
    expect(history.items).toMatchObject([{ state: 'missed', messageId: occurrence?.message_id }]);
  });

  it('rotina frequente parada por 3 horas: o grupo recente roda uma vez e só as 10 perdidas mais recentes ganham registro', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id, every5);
    clock = new Date('2026-10-01T12:03:00Z');
    await world.scheduler.tickOnce();
    const occurrences = await occurrencesOf(routine.id);
    const fired = occurrences.filter((occurrence) => occurrence.outcome === 'fired');
    const missed = occurrences.filter((occurrence) => occurrence.outcome === 'missed');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.scheduled_for.toISOString()).toBe('2026-10-01T11:05:00.000Z'); // o mais antigo dentro dos 60 minutos
    expect(missed).toHaveLength(10);
    expect(missed.map((occurrence) => occurrence.scheduled_for.toISOString())).toEqual(
      Array.from({ length: 10 }, (_, index) => new Date(Date.parse('2026-10-01T10:15:00Z') + index * 300_000).toISOString()),
    );
    expect(await runsOf(routine.id)).toHaveLength(1);
    expect((await world.routines.get(routine.id)).nextRunAt).toBe('2026-10-01T12:05:00.000Z');
  });
});

describe('uma rotina que não consegue calcular a agenda não trava as outras (R15)', () => {
  it('a rotina quebrada é pausada com auditoria e as demais do mesmo ciclo disparam normalmente', async () => {
    const bot = await world.createBot();
    const healthy = await createRoutine(bot.id, { name: 'Saudável' });
    const broken = await createRoutine(bot.id, { name: 'Quebrada' });
    // Um fuso que o banco de fusos deixou de reconhecer (ou um cron que uma versão nova do parser recusa): o cálculo da agenda lança
    // sempre. A quebrada vence ANTES da saudável, então é a primeira que o agendador pega em cada ciclo.
    await world.pool.query("UPDATE routines SET timezone = 'Nowhere/Invalid', next_run_at = next_run_at - interval '5 minutes' WHERE id = $1", [broken.id]);

    clock = new Date('2026-10-01T10:00:30Z');
    expect(await world.scheduler.tickOnce()).toBe(2); // a quebrada foi tratada (pausada) e a saudável disparou

    expect(await world.routines.get(broken.id)).toMatchObject({ status: 'paused', nextRunAt: null });
    expect(await runsOf(broken.id)).toEqual([]);
    expect(await runsOf(healthy.id)).toHaveLength(1);
    const audit = await world.pool.query<{ outcome: string; actor: string; details: { reason: string } }>(
      "SELECT outcome, actor, details FROM audit_log WHERE action = 'routine.auto_pause' AND target = $1",
      [broken.id],
    );
    expect(audit.rows).toEqual([{ outcome: 'failure', actor: 'system', details: { reason: 'SCHEDULE_ERROR' } }]);

    // O ciclo seguinte não volta à rotina quebrada: ela está pausada.
    expect(await world.scheduler.tickOnce()).toBe(0);
    await world.pool.query("UPDATE routines SET timezone = 'America/Sao_Paulo' WHERE id = $1", [broken.id]); // o dono corrige e retoma
    expect((await world.routines.resume(broken.id, ORIGIN)).status).toBe('active');
  });
});

describe('pausar, editar e excluir (F12 passo 4)', () => {
  it('excluir a rotina anula o routineId dos cartões dela na conversa ("Ver rotina" não leva a um 404) e preserva os das outras rotinas (R18)', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id);
    const other = await createRoutine(bot.id, { name: 'Outra' });
    clock = new Date('2026-10-01T10:00:10Z');
    await world.scheduler.tickOnce(); // as duas disparam: cada uma abre o cartão da sua execução
    for (const entry of [routine, other]) {
      for (const run of await runsOf(entry.id)) await world.waitForStatus(run.id, 'completed');
    }
    const cardsOf = async (id: string) =>
      (await world.timeline(bot)).filter((entry) => entry.kind === 'card' && entry.data.type === 'routine_run' && entry.data.routineName === (id === routine.id ? 'Resumo' : 'Outra'));
    expect((await cardsOf(routine.id))[0]?.data.routineId).toBe(routine.id);

    await world.routines.remove(routine.id, ORIGIN);
    expect((await cardsOf(routine.id))[0]?.data.routineId).toBeNull(); // o cartão da excluída perdeu o vínculo
    expect((await cardsOf(other.id))[0]?.data.routineId).toBe(other.id); // o da outra rotina segue intacto
  });

  it('editar o nome de uma rotina cujo horário já venceu (worker parado) não descarta aquela execução (R17)', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id);
    expect(routine.nextRunAt).toBe('2026-10-01T10:00:00.000Z');

    // O worker ficou parado: o horário das 10:00Z venceu e nada o tratou. Às 10:20Z o dono só renomeia a rotina (a agenda é a mesma).
    clock = new Date('2026-10-01T10:20:00Z');
    const renamed = await world.routines.update(routine.id, { name: 'Só o nome mudou', botId: bot.id, instruction: 'Resuma o dia', ...daily('07:00') }, ORIGIN);
    expect(renamed.nextRunAt).toBe('2026-10-01T10:00:00.000Z'); // continua o horário que venceu, e não o de amanhã

    // O agendador volta e trata o horário vencido pela regra de sempre (20 minutos de atraso: dispara uma vez).
    expect(await world.scheduler.tickOnce()).toBe(1);
    expect(await runsOf(routine.id)).toHaveLength(1);
    expect((await world.routines.get(routine.id)).nextRunAt).toBe('2026-10-02T10:00:00.000Z');
    const [run] = await runsOf(routine.id);
    await world.waitForStatus((run as { id: string }).id, 'completed');
  });

  it('não interrompem a execução em andamento; a edição vale a partir do próximo horário e o cartão fecha mesmo com a rotina excluída', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id, { instruction: 'Esperar [demorar]' });
    clock = new Date('2026-10-01T10:00:10Z');
    await world.scheduler.tickOnce();
    const [run] = await runsOf(routine.id);
    const runId = (run as { id: string }).id;
    await world.waitForStatus(runId, 'running');

    const paused = await world.routines.pause(routine.id, ORIGIN);
    expect(paused).toMatchObject({ status: 'paused', nextRunAt: null });
    expect((await world.runRow(runId)).status).toBe('running');

    const edited = await world.routines.update(routine.id, { name: 'Resumo novo', botId: bot.id, instruction: 'Outra instrução', ...daily('08:00') }, ORIGIN);
    expect(edited).toMatchObject({ name: 'Resumo novo', status: 'paused', nextRunAt: null });
    expect((await world.runRow(runId)).status).toBe('running');
    // A execução em andamento segue com a instrução que tinha.
    expect((await runsOf(routine.id))[0]?.input).toBe('Esperar [demorar]');

    await world.routines.remove(routine.id, ORIGIN);
    expect((await world.runRow(runId)).status).toBe('running');
    expect((await world.pool.query('SELECT id FROM routines WHERE id = $1', [routine.id])).rowCount).toBe(0);
    const orphan = await world.pool.query<{ routine_id: string | null; routine_name: string | null }>('SELECT routine_id, routine_name FROM runs WHERE id = $1', [runId]);
    expect(orphan.rows[0]).toEqual({ routine_id: null, routine_name: 'Resumo' });

    // Parada pelo dono (F7): a execução termina e o cartão que já estava na conversa mostra o desfecho.
    await world.conversations.stop(bot.id);
    await world.waitForStatus(runId, 'interrupted');
    const card = (await world.timeline(bot)).find((entry) => entry.data.type === 'routine_run');
    expect(card?.data).toMatchObject({ routineName: 'Resumo', state: 'interrupted' });
  });

  it('pausar e excluir tiram da fila a execução que ainda não começou (ela vira cancelada e o horário, pulado)', async () => {
    const { bot, run: busy } = await busyBot();
    const routine = await createRoutine(bot.id);
    clock = new Date('2026-10-01T10:00:10Z');
    await world.scheduler.tickOnce();
    const [queued] = await runsOf(routine.id);
    expect(queued?.status).toBe('queued');

    await world.routines.pause(routine.id, ORIGIN);
    expect((await runsOf(routine.id))[0]?.status).toBe('cancelled');
    expect((await occurrencesOf(routine.id))[0]?.outcome).toBe('skipped');
    // A execução ativa do bot (outra) segue.
    expect((await world.runRow(busy)).status).toBe('running');

    // Excluir: o mesmo para o que estiver na fila.
    await world.routines.resume(routine.id, ORIGIN);
    clock = new Date('2026-10-02T10:00:10Z');
    await world.scheduler.tickOnce();
    const queuedAgain = (await runsOf(routine.id)).find((row) => row.status === 'queued');
    expect(queuedAgain).toBeDefined();
    await world.routines.remove(routine.id, ORIGIN);
    expect((await world.runRow((queuedAgain as { id: string }).id)).status).toBe('cancelled');

    await world.conversations.stop(bot.id);
    await world.waitForStatus(busy, 'interrupted');
  });

  it('a edição da instrução vale a partir do próximo horário previsto; o que já estava na fila segue com a instrução antiga', async () => {
    const { bot } = await busyBot();
    const routine = await createRoutine(bot.id, { instruction: 'Instrução antiga' });
    clock = new Date('2026-10-01T10:00:10Z');
    await world.scheduler.tickOnce();
    const edited = await world.routines.update(routine.id, { name: 'Resumo', botId: bot.id, instruction: 'Instrução nova', ...daily('07:00') }, ORIGIN);
    expect(edited.nextRunAt).toBe('2026-10-02T10:00:00.000Z');
    expect((await runsOf(routine.id))[0]?.input).toBe('Instrução antiga');
    clock = new Date('2026-10-02T10:00:10Z');
    await world.routines.pause(routine.id, ORIGIN);
    await world.routines.resume(routine.id, ORIGIN);
    clock = new Date('2026-10-03T10:00:10Z');
    await world.scheduler.tickOnce();
    expect((await runsOf(routine.id)).at(-1)?.input).toBe('Instrução nova');
    await world.conversations.stop(bot.id);
  });
});

describe('arquivar o bot (A4, spec decisão 16)', () => {
  it('pausa as rotinas e tira da fila o que não começou; desarquivar não as retoma; retomar de bot arquivado é recusado', async () => {
    const { bot, run: busy } = await busyBot();
    const routine = await createRoutine(bot.id);
    const other = await createRoutine((await world.createBot()).id, { name: 'De outro bot' });
    clock = new Date('2026-10-01T10:00:10Z');
    await world.scheduler.tickOnce();
    expect((await runsOf(routine.id))[0]?.status).toBe('queued');

    await world.bots.archive(bot.id, ORIGIN);
    expect(await world.routines.get(routine.id)).toMatchObject({ status: 'paused', nextRunAt: null });
    expect((await runsOf(routine.id))[0]?.status).toBe('cancelled');
    expect((await world.routines.get(other.id)).status).toBe('active'); // só as rotinas DESTE bot
    await expect(world.routines.resume(routine.id, ORIGIN)).rejects.toMatchObject({ code: 'BOT_ARCHIVED' });
    await expect(world.routines.runNow(routine.id, ORIGIN)).rejects.toMatchObject({ code: 'BOT_ARCHIVED' });
    await expect(createRoutine(bot.id)).rejects.toMatchObject({ code: 'BOT_ARCHIVED' });

    await world.bots.unarchive(bot.id, ORIGIN);
    expect((await world.routines.get(routine.id)).status).toBe('paused'); // as rotinas ficam pausadas
    expect((await world.routines.resume(routine.id, ORIGIN)).status).toBe('active');

    await world.conversations.stop(bot.id).catch(() => undefined);
    await world.waitForStatus(busy, 'interrupted').catch(() => undefined);
  });

  it('arquivar o bot no meio do disparo da rotina não gera deadlock: a ordem de trava é sempre rotina e depois bot (R14)', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id);

    // O disparo do agendador: segura a linha da rotina e, logo depois, trava o bot para enfileirar a execução (`queueRun`).
    const firing = await world.pool.connect();
    try {
      await firing.query('BEGIN');
      await firing.query('SELECT id FROM routines WHERE id = $1 FOR UPDATE', [routine.id]);

      // O dono arquiva o bot nesse instante, e o arquivamento fica esperando a rotina (a trava dela vem antes da do bot).
      const archiving = world.bots.archive(bot.id, ORIGIN);
      await waitFor('o arquivamento esperando uma trava', async () => Number((await world.pool.query('SELECT count(*) AS n FROM pg_locks WHERE NOT granted')).rows[0]?.n) > 0);

      // O disparo segue e trava o bot. Com a ordem antiga (bot primeiro, rotinas depois) esta consulta esperaria o arquivamento, que espera
      // o disparo, e o PostgreSQL derrubaria uma das duas transações por deadlock (40P01).
      await firing.query('SELECT id FROM bots WHERE id = $1 FOR UPDATE', [bot.id]);
      await firing.query('COMMIT');

      const archived = await archiving;
      expect(archived.archivedAt).not.toBeNull();
    } finally {
      firing.release();
    }
    expect(await world.routines.get(routine.id)).toMatchObject({ status: 'paused', nextRunAt: null });
  });
});

describe('limites e fim da agenda', () => {
  it('o limite de execuções conclui a rotina; a execução única conclui depois de disparar', async () => {
    const bot = await world.createBot();
    const limited = await createRoutine(bot.id, { name: 'Com limite', ...daily('07:00'), maxRuns: 1 });
    const once = await createRoutine(bot.id, { name: 'Única', schedule: { type: 'once', at: '2026-10-01T07:30' }, maxRuns: null });
    expect(once.nextRunAt).toBe('2026-10-01T10:30:00.000Z');
    clock = new Date('2026-10-01T10:31:00Z');
    await world.scheduler.tickOnce();
    expect(await world.routines.get(limited.id)).toMatchObject({ status: 'completed', nextRunAt: null, runCount: 1 });
    expect(await world.routines.get(once.id)).toMatchObject({ status: 'completed', nextRunAt: null, runCount: 1 });
  });

  it('o fim do período conclui a rotina, e editar uma concluída com agenda futura a reativa', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id, { endsAt: '2026-10-01T07:00' });
    clock = new Date('2026-10-01T10:00:30Z');
    await world.scheduler.tickOnce();
    expect(await world.routines.get(routine.id)).toMatchObject({ status: 'completed', nextRunAt: null });
    const reopened = await world.routines.update(routine.id, { name: 'Resumo', botId: bot.id, instruction: 'Resuma o dia', ...daily('07:00') }, ORIGIN);
    expect(reopened).toMatchObject({ status: 'active', nextRunAt: '2026-10-02T10:00:00.000Z' });
  });

  it('uma rotina nunca tem mais de uma execução aguardando: o horário seguinte, com a anterior ainda na fila, é pulado', async () => {
    const { bot } = await busyBot();
    const routine = await createRoutine(bot.id, every5);
    clock = new Date('2026-10-01T09:05:30Z');
    await world.scheduler.tickOnce();
    clock = new Date('2026-10-01T09:10:30Z');
    await world.scheduler.tickOnce();
    expect((await runsOf(routine.id)).filter((run) => run.status === 'queued')).toHaveLength(1);
    expect((await occurrencesOf(routine.id)).map((occurrence) => occurrence.outcome)).toEqual(['fired', 'skipped']);
    expect((await world.routines.get(routine.id)).runCount).toBe(1);
    await world.conversations.stop(bot.id);
  });
});

describe('executar agora (F12 passo 4)', () => {
  it('enfileira uma execução manual na hora, sem consumir o limite nem mudar o próximo horário, inclusive com a rotina pausada', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id, { maxRuns: 1 });
    await world.routines.pause(routine.id, ORIGIN);
    const run = await world.routines.runNow(routine.id, ORIGIN);
    expect(run).toMatchObject({ status: 'queued', routineName: 'Resumo' });
    await world.waitForStatus(run.id, 'completed');
    expect(await world.routines.get(routine.id)).toMatchObject({ status: 'paused', runCount: 0, nextRunAt: null });
    expect((await occurrencesOf(routine.id))[0]).toMatchObject({ outcome: 'fired', manual: true });
    const card = (await world.timeline(bot)).find((entry) => entry.data.type === 'routine_run');
    expect(card?.data).toMatchObject({ manual: true, state: 'completed' });
    // Duas vezes seguidas: dois cliques não são o mesmo horário previsto.
    const [first, second] = await Promise.all([world.routines.runNow(routine.id, ORIGIN), world.routines.runNow(routine.id, ORIGIN)]);
    expect(first.id).not.toBe(second.id);
  });

  it('A20: a rotina de um bot sem saldo da Anthropic falha com PROVIDER_CREDITS_EXHAUSTED: a execução e o cartão da rotina gravam o código, o aviso push o mostra e não há nova tentativa', async () => {
    await world.connectAnthropic();
    await world.models.test('anthropic/claude-haiku-5-5');
    const bot = await world.createBot({ model: 'anthropic/claude-haiku-5-5', name: 'Bot da rotina sem saldo' });
    const routine = await createRoutine(bot.id, { name: 'Sem saldo', instruction: '[sem-saldo] resuma o dia' });
    const since = world.upstreams.requests.length;
    const run = await world.routines.runNow(routine.id, ORIGIN);
    await world.waitForStatus(run.id, 'failed');
    expect(await world.runRow(run.id)).toMatchObject({ status: 'failed', failure_code: 'PROVIDER_CREDITS_EXHAUSTED' });
    expect(world.upstreams.requests.slice(since).filter((request) => request.service === 'anthropic' && request.method === 'POST')).toHaveLength(1);
    const card = (await world.timeline(bot)).find((entry) => entry.data.type === 'routine_run');
    expect(card?.data).toMatchObject({ state: 'failed', failureCode: 'PROVIDER_CREDITS_EXHAUSTED' });
    await world.pool.query("DELETE FROM credentials WHERE kind = 'anthropic'");
  });

  it('A9: a rotina de um bot cujo modelo foi ocultado em Conexões roda do mesmo jeito (oculto só tira o modelo das escolhas novas)', async () => {
    const bot = await world.createBot({ name: 'Bot da rotina com modelo oculto', model: 'opencode/glm-5.3-flash' });
    const routine = await createRoutine(bot.id, { name: 'Com modelo oculto', instruction: 'diga ok' });
    await world.models.setHidden('opencode/glm-5.3-flash', true);
    try {
      const run = await world.routines.runNow(routine.id, ORIGIN);
      await world.waitForStatus(run.id, 'completed');
      expect(await world.runRow(run.id)).toMatchObject({ status: 'completed', failure_code: null });
      expect((await world.pool.query('SELECT last_model FROM runs WHERE id = $1', [run.id])).rows[0]).toEqual({ last_model: 'opencode/glm-5.3-flash' });
    } finally {
      await world.models.setHidden('opencode/glm-5.3-flash', false);
    }
  });

  it('A22: a rotina que recebe um 429 passageiro conclui na repetição da chamada; com o 429 permanente falha como RATE_LIMITED, e a classe da falha fica na execução e no cartão da rotina', async () => {
    const bot = await world.createBot({ name: 'Bot da rotina com limite' });
    const passing = await createRoutine(bot.id, { name: 'Limite passageiro', instruction: '[limitar] resuma o dia' });
    const since = world.upstreams.requests.length;
    const ok = await world.routines.runNow(passing.id, ORIGIN);
    await world.waitForStatus(ok.id, 'completed');
    // Só as chamadas desta rotina (o mundo é compartilhado e outras execuções do arquivo também falam com o provedor falso): a recusada e a repetida, com o mesmo texto.
    expect(world.upstreams.requests.slice(since).filter((request) => request.service === 'opencode-go' && request.method === 'POST' && JSON.stringify(request.body ?? {}).includes('[limitar] resuma o dia'))).toHaveLength(2);
    expect(await world.runRow(ok.id)).toMatchObject({ status: 'completed', failure_code: null });

    const forever = await createRoutine(bot.id, { name: 'Limite permanente', instruction: '[limitar-sempre] resuma o dia' });
    const failed = await world.routines.runNow(forever.id, ORIGIN);
    await world.waitForStatus(failed.id, 'failed');
    expect(await world.runRow(failed.id)).toMatchObject({ status: 'failed', failure_code: 'RATE_LIMITED' });
    const card = (await world.timeline(bot)).find((entry) => entry.data.type === 'routine_run' && entry.data.routineName === 'Limite permanente');
    expect(card?.data).toMatchObject({ state: 'failed', failureCode: 'RATE_LIMITED' });
  });

  it('limita os cliques por minuto (R16): o excedente é RATE_LIMITED com Retry-After, e a janela volta a liberar', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id);
    // Instância própria, com limite baixo: o limitador do mundo é compartilhado entre os testes do arquivo.
    const limited = new RoutineService({ pool: world.pool, credentials: world.credentials, now: () => clock, runNowPerMinute: 2 });
    await limited.runNow(routine.id, ORIGIN);
    await limited.runNow(routine.id, ORIGIN);
    const refused = await limited.runNow(routine.id, ORIGIN).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 60 });
    expect(await runsOf(routine.id)).toHaveLength(2); // o recusado não enfileirou nada

    clock = new Date(clock.getTime() + 61_000); // a janela de 1 minuto passou
    await expect(limited.runNow(routine.id, ORIGIN)).resolves.toMatchObject({ status: 'queued' });
    for (const run of await runsOf(routine.id)) await world.waitForStatus(run.id, 'completed'); // o motor termina o que foi enfileirado
  });

  it('respeita o teto de 20 aguardando do bot e a falta de provedor', async () => {
    const { bot } = await busyBot();
    const routine = await createRoutine(bot.id);
    // Fila cheia atrás da ativa (o envio do dono, com execução ativa, viraria complemento: CONV-03).
    for (let index = 0; index < 20; index += 1) await world.enqueue(bot, `mensagem ${index}`);
    await expect(world.routines.runNow(routine.id, ORIGIN)).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    await world.conversations.stop(bot.id);
    await world.pool.query("UPDATE runs SET status = 'cancelled', finished_at = now() WHERE bot_id = $1 AND status = 'queued'", [bot.id]);
  });
});

describe('criar e validar (SCHEDULE_INVALID, SCHEDULE_IN_PAST, BOT_ARCHIVED, ROUTINE_NOT_FOUND)', () => {
  it('recusa a agenda inválida com o motivo legível e a execução única no passado', async () => {
    const bot = await world.createBot();
    const tooFast = await createRoutine(bot.id, { schedule: { type: 'interval', every: 3, unit: 'minutes', window: null } }).catch((error: unknown) => error);
    expect(tooFast).toMatchObject({ code: 'SCHEDULE_INVALID', fields: [{ field: 'schedule', reason: 'O intervalo mínimo é de 5 minutos.' }] });
    await expect(createRoutine(bot.id, { schedule: { type: 'cron', expression: '99 * * * *' } })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
    await expect(createRoutine(bot.id, { schedule: { type: 'once', at: '2026-09-01T10:00' } })).rejects.toMatchObject({ code: 'SCHEDULE_IN_PAST' });
    await expect(createRoutine('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'BOT_NOT_FOUND' });
    await expect(world.routines.get('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'ROUTINE_NOT_FOUND' });
    await expect(world.routines.remove('00000000-0000-4000-8000-000000000000', ORIGIN)).rejects.toMatchObject({ code: 'ROUTINE_NOT_FOUND' });
    expect((await world.pool.query('SELECT count(*) AS total FROM routines')).rows[0]).toEqual({ total: '0' });
  });

  it('a prévia devolve as 5 próximas datas, ou o motivo no lugar delas', async () => {
    const valid = world.routines.preview({ schedule: { type: 'monthly_position', position: 'second', weekday: 'TU', time: '09:00' }, timezone: 'America/New_York', startsAt: null, endsAt: null, maxRuns: null });
    expect(valid).toMatchObject({ valid: true, reason: null, description: 'Na segunda terça-feira do mês às 09:00' });
    expect(valid.occurrences).toEqual(['2026-10-13T13:00:00.000Z', '2026-11-10T14:00:00.000Z', '2026-12-08T14:00:00.000Z', '2027-01-12T14:00:00.000Z', '2027-02-09T14:00:00.000Z']);
    const invalid = world.routines.preview({ schedule: { type: 'cron', expression: 'abc' }, timezone: SP, startsAt: null, endsAt: null, maxRuns: null });
    expect(invalid).toMatchObject({ valid: false, description: null, occurrences: [] });
    expect(invalid.reason).toMatch(/cron inválida/);
  });

  it('a rotina traz o nome e a cor do bot (o avatar do seletor do editor), sem personagem, na criação, na leitura e na lista', async () => {
    const bot = await world.createBot({ color: '#4ADE80' });
    const created = await createRoutine(bot.id);
    const expected = { id: bot.id, name: bot.name, color: '#4ADE80', archived: false };
    expect(created.bot).toEqual(expected);
    expect((await world.routines.get(created.id)).bot).toEqual(expected);
    expect((await world.routines.list()).routines.find((routine) => routine.id === created.id)?.bot).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------------------------
// Rotina criada pelo bot: vale na hora (phase 10, A12, C6) e a proposta ANTIGA pendente segue confirmável (A15)
// ---------------------------------------------------------------------------------------------

/** A conversa do bot como o dono a lê: o resumo da lista (bolinha de não lido e prévia da última novidade). */
const summaryOf = async (bot: Bot) => (await world.bots.list()).find((item) => item.id === bot.id)!;

/** O dono leu a conversa inteira (posição de leitura sincronizada): a bolinha de não lido some até a próxima novidade visível. */
const markRead = (bot: Bot) =>
  world.pool.query('UPDATE conversations SET read_through_message_id = (SELECT max(id) FROM messages WHERE conversation_id = conversations.id) WHERE bot_id = $1', [bot.id]);

/** Os cartões de um tipo na conversa do bot, em ordem, com o id da mensagem. */
const cardsOf = async (bot: Bot, type: string) => (await world.timeline(bot)).filter((entry) => entry.kind === 'card' && entry.data.type === type);

/** Insere uma proposta ANTIGA pendente (criada antes da phase 10): a ferramenta já não a grava, mas o cartão segue existindo e confirmável. */
async function insertLegacyProposal(bot: Bot, proposal: RoutineProposal): Promise<string> {
  const card: RoutineProposalCard = { type: 'routine_proposal', proposal, summary: 'Todos os dias às 07:30', nextRuns: [], status: 'pending', routineId: null };
  const conversation = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0] as { id: string };
  const inserted = await world.pool.query<{ id: string }>(
    "INSERT INTO messages (conversation_id, role, kind, status, content, data, created_at) VALUES ($1, 'system', 'card', 'done', '', $2, now()) RETURNING id::text AS id",
    [conversation.id, JSON.stringify(card)],
  );
  return (inserted.rows[0] as { id: string }).id;
}

const LEGACY_PROPOSAL: RoutineProposal = { name: 'Resumo diário', instruction: 'Executar Resumo diário', ...daily('07:30') };

/** O código de erro de domínio de uma operação que deve falhar ('OK' se não falhou). */
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `INESPERADO:${String(error)}`;
  }
};

describe('rotina criada pelo bot vale na hora (A12, C6)', () => {
  it('a ferramenta cria a rotina ATIVA com o cartão aplicado, ela dispara na agenda sem clique do dono e o resultado diz ao bot que já vale', async () => {
    const bot = await world.createBot();
    const run = await world.send(bot, '[rotina:Resumo diário|07:30]');
    await world.waitForStatus(run, 'completed');

    // A rotina já existe e está ativa, no horário previsto, sem Confirmar.
    const [routine] = (await world.routines.list()).routines;
    expect(routine).toMatchObject({ name: 'Resumo diário', instruction: 'Executar Resumo diário', status: 'active', bot: { id: bot.id }, nextRunAt: '2026-10-01T10:30:00.000Z' });
    const [card] = await cardsOf(bot, 'routine_proposal');
    expect(card?.data).toMatchObject({ status: 'applied', routineId: routine?.id, summary: 'Todos os dias às 07:30', proposal: { name: 'Resumo diário', instruction: 'Executar Resumo diário', timezone: SP } });
    expect((card?.data.nextRuns as string[]).length).toBe(5);
    expect(card?.content).toBe(''); // fora da busca e do contexto do modelo
    expect(card?.runId).toBe(run);
    // C6: o resultado que o bot recebe diz que a rotina já vale e que o dono pode recusar ou editar.
    const sent = JSON.stringify(world.conversationRequests().at(-1)?.body);
    expect(sent).toContain('Rotina criada e ATIVA');
    expect(sent).toContain('já vale e roda na agenda, sem confirmação do dono');
    expect(sent).toContain('O dono pode recusá-la (ela é excluída) ou editá-la pelo cartão');
    // D3: a criação é auditada como `system`, com o bot, a execução e a origem, sem a instrução.
    const audit = await world.pool.query<{ actor: string; details: Record<string, unknown> }>("SELECT actor, details FROM audit_log WHERE action = 'routine.create' AND target = $1", [routine?.id]);
    expect(audit.rows).toEqual([{ actor: 'system', details: { bot: bot.id, origin: 'bot', run } }]);

    // Roda na agenda sem nenhum clique do dono.
    clock = new Date('2026-10-01T10:30:30Z');
    expect(await world.scheduler.tickOnce()).toBe(1);
    const [fired] = await runsOf(routine!.id);
    expect(fired).toMatchObject({ input: 'Executar Resumo diário', routine_name: 'Resumo diário' });
    await world.waitForStatus((fired as { id: string }).id, 'completed');
    expect((await world.routines.get(routine!.id)).runCount).toBe(1);
  });

  it('uma rotina que o bot criou e passou a rodar continua pedindo aprovação em cada ação externa: aceitar por padrão muda só a agenda (A15)', async () => {
    await world.connectComposio();
    const bot = await world.createBot();
    await world.releaseConnectorAccounts(bot); // a rotina executa com as contas liberadas ao bot dela (A21)
    const first = await world.send(bot, 'Olá');
    await world.waitForStatus(first, 'completed');
    const conversation = (await world.pool.query<{ conversation_id: string }>('SELECT conversation_id::text FROM runs WHERE id = $1', [first])).rows[0] as { conversation_id: string };
    const context = { pool: world.pool, botId: bot.id, conversationId: conversation.conversation_id, runId: first, now: () => clock, signal: new AbortController().signal } satisfies ToolContext;
    // A instrução leva o marcador que faz o modelo falso chamar uma ação externa do Composio (sem regra, ela PERGUNTA).
    await proposeRoutineTool.prepare(JSON.stringify({ name: 'Envio', instruction: '[gmail] envie o relatório', ...daily('07:00') })).execute(context);
    const routine = (await world.routines.list()).routines[0]!;
    const sentBefore = world.composioExecutions().length;

    clock = new Date('2026-10-01T10:00:30Z');
    expect(await world.scheduler.tickOnce()).toBe(1);
    const [run] = await runsOf(routine.id);
    await world.waitForStatus((run as { id: string }).id, 'waiting_approval');
    expect(world.composioExecutions()).toHaveLength(sentBefore); // nada foi enviado: a execução aguarda o dono
    expect(await world.approvalOf((run as { id: string }).id)).toMatchObject({ status: 'pending' });
  });
});

describe('proposta ANTIGA pendente (criada antes da phase 10): o dono ainda confirma (A15)', () => {
  it('confirmar cria a rotina uma vez só, e outro bot não alcança o cartão; as rotas novas não a tratam como aplicada', async () => {
    const bot = await world.createBot();
    const otherBot = await world.createBot();
    const cardId = await insertLegacyProposal(bot, LEGACY_PROPOSAL);
    expect((await world.routines.list()).routines).toEqual([]); // a proposta antiga NÃO é uma rotina

    await expect(world.routines.create({ ...LEGACY_PROPOSAL, botId: otherBot.id, proposalMessageId: cardId }, ORIGIN)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const created = await world.routines.create({ ...LEGACY_PROPOSAL, botId: bot.id, proposalMessageId: cardId }, ORIGIN);
    expect(created).toMatchObject({ name: 'Resumo diário', status: 'active', bot: { id: bot.id } });
    const [confirmed] = await cardsOf(bot, 'routine_proposal');
    expect(confirmed?.data).toMatchObject({ status: 'confirmed', routineId: created.id });

    const again = await world.routines.create({ ...LEGACY_PROPOSAL, botId: bot.id, proposalMessageId: cardId }, ORIGIN);
    expect(again.id).toBe(created.id);
    expect((await world.routines.list()).routines).toHaveLength(1);
    // Confirmar de novo não duplica o aviso de confirmação.
    expect(await cardsOf(bot, 'routine_confirmed')).toHaveLength(1);

    // O cartão da rotina que o bot criou já vale: confirmá-lo de novo (criação com `proposalMessageId`) nunca duplicaria a rotina.
    await world.waitForStatus(await world.send(bot, '[rotina:Outra|08:00]'), 'completed');
    const applied = (await cardsOf(bot, 'routine_proposal')).find((entry) => entry.data.status === 'applied')!;
    await expect(world.routines.create({ ...LEGACY_PROPOSAL, name: 'Outra', botId: bot.id, proposalMessageId: applied.id }, ORIGIN)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await world.routines.list()).routines).toHaveLength(2);
    // Recusar e editar pelo cartão só existem para o que o bot aplicou: a proposta antiga pendente e a confirmada dão NOT_FOUND.
    expect(await codeOf(world.routines.refuse(cardId, ORIGIN))).toBe('NOT_FOUND');
    expect(await codeOf(world.routines.update(created.id, { ...LEGACY_PROPOSAL, botId: bot.id }, ORIGIN, { cardId }))).toBe('NOT_FOUND');
  });

  it('o bot fica sabendo da confirmação: o aviso entra no fim da conversa e chega ao modelo na rodada seguinte', async () => {
    const bot = await world.createBot();
    await world.waitForStatus(await world.send(bot, 'Olá'), 'completed'); // o aviso só entra no pedido dentro de uma rodada: a conversa já tem a primeira
    const cardId = await insertLegacyProposal(bot, { ...LEGACY_PROPOSAL, name: 'Lembrete reunião' });
    // Pelo "Editar" o dono pode renomear antes de confirmar: o aviso leva o nome da rotina criada.
    const created = await world.routines.create({ ...LEGACY_PROPOSAL, name: 'Reunião semanal', botId: bot.id, proposalMessageId: cardId }, ORIGIN);

    const timeline = await world.timeline(bot);
    const notice = timeline.at(-1)!;
    expect(notice.data).toEqual({ type: 'routine_confirmed', routineId: created.id, routineName: 'Reunião semanal', action: 'create' });
    expect(notice.content).toContain(`a rotina "Reunião semanal" (id ${created.id}) foi criada`);

    const before = world.conversationRequests().length;
    await world.waitForStatus(await world.send(bot, 'Eu autorizei a rotina?'), 'completed');
    const request = JSON.stringify(world.conversationRequests().slice(before)[0]!.body);
    expect(request).toContain('O dono confirmou a sua proposta: a rotina \\"Reunião semanal\\"');
  });

  it('uma agenda recusada volta ao bot como falha da ferramenta, com o motivo, e nenhuma rotina nem cartão é gravado', async () => {
    const bot = await world.createBot();
    const run = await world.send(bot, '[rotina-invalida]');
    await world.waitForStatus(run, 'completed');
    const timeline = await world.timeline(bot);
    const activity = timeline.find((entry) => entry.kind === 'activity');
    expect(activity?.status).toBe('failed');
    expect(activity?.content).toContain('O intervalo mínimo é de 5 minutos.');
    expect(activity?.content).toContain('Corrija e tente de novo.');
    expect(timeline.some((entry) => entry.data.type === 'routine_proposal')).toBe(false);
    expect((await world.routines.list()).routines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Recusar e editar pelo cartão (phase 10, A13 a A15)
// ---------------------------------------------------------------------------------------------

describe('recusar pelo cartão desfaz o que o bot aplicou, avisa o bot e é idempotente (A13, A14)', () => {
  it('rotina criada: recusar a exclui, o cartão vira "recusada", o aviso entra no fim da conversa e chega ao modelo, sem acender a bolinha; a segunda recusa não muda nada', async () => {
    const bot = await world.createBot();
    await world.waitForStatus(await world.send(bot, '[rotina:Lembrete|08:00]'), 'completed');
    const routine = (await world.routines.list()).routines[0]!;
    const [card] = await cardsOf(bot, 'routine_proposal');
    await markRead(bot);
    expect((await summaryOf(bot)).unread).toBe(false);

    expect(await world.routines.refuse(card!.id, ORIGIN)).toEqual({ routine: null });
    expect(await codeOf(world.routines.get(routine.id))).toBe('ROUTINE_NOT_FOUND');
    expect((await cardsOf(bot, 'routine_proposal'))[0]?.data).toMatchObject({ status: 'refused', routineId: null });
    const notice = (await world.timeline(bot)).at(-1)!;
    expect(notice.data).toEqual({ type: 'routine_refused', routineId: null, routineName: 'Lembrete', action: 'create' });
    expect(notice.content).toContain('O dono recusou a rotina que você criou: a rotina "Lembrete" foi excluída');
    expect(notice.runId).toBeNull();
    // O aviso registra a ação do próprio dono: não acende a bolinha nem vira a prévia da lista.
    const summary = await summaryOf(bot);
    expect(summary.unread).toBe(false);
    expect(summary.preview).not.toContain('recusada');

    // Idempotente: a segunda recusa devolve o mesmo resultado, sem outro aviso nem outra auditoria.
    expect(await world.routines.refuse(card!.id, ORIGIN)).toEqual({ routine: null });
    expect(await cardsOf(bot, 'routine_refused')).toHaveLength(1);
    const audit = await world.pool.query<{ actor: string; details: Record<string, unknown> }>("SELECT actor, details FROM audit_log WHERE action = 'routine.card_refused'");
    expect(audit.rows.filter((row) => row.details.card === card!.id)).toEqual([{ actor: 'owner', details: { action: 'create', card: card!.id } }]);

    // O modelo vê o aviso no pedido seguinte.
    const before = world.conversationRequests().length;
    await world.waitForStatus(await world.send(bot, 'E agora?'), 'completed');
    expect(JSON.stringify(world.conversationRequests().slice(before)[0]!.body)).toContain('O dono recusou a rotina que você criou');
  });

  it('alteração, pausa e retomada: recusar devolve a rotina ao estado anterior', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id, { name: 'Boletim', instruction: 'Instrução antiga.' });

    // Mudar: instrução e agenda voltam.
    await world.waitForStatus(await world.send(bot, '[rotina-mudar:Boletim|09:30]'), 'completed');
    expect(await world.routines.get(routine.id)).toMatchObject({ instruction: 'Nova instrução de Boletim', schedule: { type: 'daily', times: ['09:30'] } });
    const update = (await cardsOf(bot, 'routine_change')).at(-1)!;
    expect(update.data).toMatchObject({ status: 'applied', change: { action: 'update' } });
    const refusedUpdate = await world.routines.refuse(update.id, ORIGIN);
    expect(refusedUpdate.routine).toMatchObject({ id: routine.id, instruction: 'Instrução antiga.', schedule: { type: 'daily', times: ['07:00'] }, status: 'active', nextRunAt: '2026-10-01T10:00:00.000Z' });
    expect((await cardsOf(bot, 'routine_change')).at(-1)?.data).toMatchObject({ status: 'refused', routineId: routine.id });
    expect((await cardsOf(bot, 'routine_refused')).at(-1)?.data).toEqual({ type: 'routine_refused', routineId: routine.id, routineName: 'Boletim', action: 'update' });
    expect((await cardsOf(bot, 'routine_refused')).at(-1)?.content).toContain(`a rotina "Boletim" (id ${routine.id}) voltou a ser como era antes dela`);

    // Pausar: a recusa retoma (o próximo horário volta a existir).
    await world.waitForStatus(await world.send(bot, '[rotina-pausar:Boletim]'), 'completed');
    expect(await world.routines.get(routine.id)).toMatchObject({ status: 'paused', nextRunAt: null });
    const pause = (await cardsOf(bot, 'routine_change')).at(-1)!;
    expect((await world.routines.refuse(pause.id, ORIGIN)).routine).toMatchObject({ status: 'active', nextRunAt: '2026-10-01T10:00:00.000Z' });

    // Retomar: a recusa pausa de novo.
    await world.waitForStatus(await world.send(bot, '[rotina-pausar:Boletim]'), 'completed');
    await world.waitForStatus(await world.send(bot, '[rotina-retomar:Boletim]'), 'completed');
    const resume = (await cardsOf(bot, 'routine_change')).at(-1)!;
    expect(resume.data).toMatchObject({ status: 'applied', change: { action: 'resume' } });
    expect((await world.routines.refuse(resume.id, ORIGIN)).routine).toMatchObject({ status: 'paused', nextRunAt: null });
    expect((await cardsOf(bot, 'routine_refused')).map((entry) => (entry.data as { action: string }).action)).toEqual(['update', 'pause', 'resume']);
  });

  it('exclusão: recusar traz a rotina de volta com o mesmo id, a mesma configuração e o mesmo histórico, religando execuções e cartões', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id, { name: 'Resumo', maxRuns: 5 });
    clock = new Date('2026-10-01T10:00:10Z');
    await world.scheduler.tickOnce(); // dispara uma vez: ocorrência, execução e cartão da execução
    const [run] = await runsOf(routine.id);
    await world.waitForStatus((run as { id: string }).id, 'completed');
    const runCard = (await cardsOf(bot, 'routine_run'))[0]!;
    const historyBefore = (await world.routines.history(routine.id, undefined)).items.map((item) => [item.scheduledFor, item.state, item.manual, item.messageId]);
    const occurrencesBefore = await occurrencesOf(routine.id);
    expect(historyBefore).toHaveLength(1);
    const viewBefore = await world.routines.get(routine.id);

    await world.waitForStatus(await world.send(bot, '[rotina-excluir:Resumo]'), 'completed');
    expect(await codeOf(world.routines.get(routine.id))).toBe('ROUTINE_NOT_FOUND');
    expect((await world.pool.query('SELECT 1 FROM routine_occurrences WHERE routine_id = $1', [routine.id])).rowCount).toBe(0); // o histórico foi apagado
    expect((await runsOf(routine.id)).length).toBe(0);
    expect((await world.pool.query<{ data: { routineId: string | null } }>('SELECT data FROM messages WHERE id = $1', [runCard.id])).rows[0]?.data.routineId).toBeNull();

    const deletion = (await cardsOf(bot, 'routine_change')).at(-1)!;
    expect(deletion.data).toMatchObject({ status: 'applied', routineId: null, change: { action: 'delete' } });
    const restored = (await world.routines.refuse(deletion.id, ORIGIN)).routine!;
    expect(restored).toMatchObject({ id: routine.id, name: 'Resumo', instruction: viewBefore.instruction, schedule: viewBefore.schedule, timezone: SP, maxRuns: 5, runCount: 1, status: 'active' });
    expect(restored.createdAt).toBe(viewBefore.createdAt);
    expect(restored.nextRunAt).toBe('2026-10-02T10:00:00.000Z'); // recalculado a partir de agora: o tempo excluída não vira "perdida"
    // O histórico voltou: as mesmas ocorrências (na mesma ordem), a execução ligada à rotina e o cartão da execução com o vínculo.
    expect((await world.routines.history(routine.id, undefined)).items.map((item) => [item.scheduledFor, item.state, item.manual, item.messageId])).toEqual(historyBefore);
    expect((await occurrencesOf(routine.id)).map((row) => [row.scheduled_for.toISOString(), row.outcome, row.manual, row.run_id])).toEqual(occurrencesBefore.map((row) => [row.scheduled_for.toISOString(), row.outcome, row.manual, row.run_id]));
    expect((await runsOf(routine.id)).map((row) => row.id)).toEqual([(run as { id: string }).id]);
    expect((await world.pool.query<{ data: { routineId: string | null } }>('SELECT data FROM messages WHERE id = $1', [runCard.id])).rows[0]?.data.routineId).toBe(routine.id);
    expect((await cardsOf(bot, 'routine_change')).at(-1)?.data).toMatchObject({ status: 'refused', routineId: routine.id });
    expect((await cardsOf(bot, 'routine_refused')).at(-1)?.content).toContain('voltou, com a mesma configuração e o mesmo histórico');
    // O instantâneo já cumpriu o papel e sai da linha do cartão.
    expect((await world.pool.query<{ data: Record<string, unknown> }>('SELECT data FROM messages WHERE id = $1', [deletion.id])).rows[0]?.data).not.toHaveProperty('restore');

    // Segunda recusa: o mesmo resultado, sem duplicar ocorrências nem avisos. A rotina restaurada volta a disparar na agenda.
    expect((await world.routines.refuse(deletion.id, ORIGIN)).routine?.id).toBe(routine.id);
    expect((await occurrencesOf(routine.id)).length).toBe(1);
    expect(await cardsOf(bot, 'routine_refused')).toHaveLength(1);
    clock = new Date('2026-10-02T10:00:10Z');
    expect(await world.scheduler.tickOnce()).toBe(1);
    expect((await world.routines.get(routine.id)).runCount).toBe(2);
    await waitFor('a execução restaurada terminar', async () => ((await world.pool.query("SELECT 1 FROM runs WHERE routine_id = $1 AND status IN ('queued', 'running')", [routine.id])).rowCount === 0 ? true : null));
  });

  it('exclusão com histórico maior que o teto: o instantâneo guarda só a janela mais recente (ocorrências, execuções e cartões) e a recusa restaura o que foi guardado, sem repetir efeito', async () => {
    const MAX = 3;
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id, { name: 'Longa' });
    // Cinco disparos diários, dois a mais que o teto: cada um deixa ocorrência, execução e cartão da execução (histórico real, sem inserir linhas à mão).
    for (let day = 0; day < 5; day += 1) {
      clock = new Date(Date.UTC(2026, 9, 1 + day, 10, 0, 10));
      expect(await world.scheduler.tickOnce()).toBe(1);
      await world.waitForStatus((await runsOf(routine.id)).at(-1)!.id, 'completed');
    }
    const allRuns = (await runsOf(routine.id)).map((row) => row.id);
    const occurrencesBefore = await occurrencesOf(routine.id);
    const runCardIds = (await cardsOf(bot, 'routine_run')).map((card) => card.id);
    expect([allRuns.length, occurrencesBefore.length, runCardIds.length]).toEqual([5, 5, 5]);

    // O bot exclui por um serviço com teto baixo (o teto de produção é 5.000; a regra é a mesma).
    const botRun = await world.send(bot, 'Olá');
    await world.waitForStatus(botRun, 'completed');
    const conversationId = ((await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0] as { id: string }).id;
    const limited = new RoutineService({ pool: world.pool, now: () => clock, restoreOccurrencesMax: MAX });
    await limited.applyChangeByBot({ botId: bot.id, conversationId, runId: botRun }, routine.id, { action: 'delete' });
    expect(await runsOf(routine.id)).toEqual([]);

    // As três listas do instantâneo respeitam o teto e falam da mesma janela: as 3 ocorrências mais recentes, as execuções delas e os 3 cartões mais recentes.
    const deletion = (await cardsOf(bot, 'routine_change')).at(-1)!;
    type Snapshot = { occurrences: unknown[][]; occurrencesTruncated: boolean; runIds: string[]; cardIds: string[] };
    const snapshot = ((await world.pool.query<{ restore: Snapshot }>("SELECT data -> 'restore' AS restore FROM messages WHERE id = $1", [deletion.id])).rows[0] as { restore: Snapshot }).restore;
    expect(snapshot.occurrencesTruncated).toBe(true);
    expect(snapshot.occurrences.map((occurrence) => occurrence[3])).toEqual(allRuns.slice(-MAX));
    expect(snapshot.runIds).toEqual(allRuns.slice(-MAX));
    expect([...snapshot.cardIds].sort()).toEqual(runCardIds.slice(-MAX).sort());

    // A recusa (por um serviço de teto padrão: o instantâneo se descreve sozinho) restaura só o que foi guardado.
    const restored = (await world.routines.refuse(deletion.id, ORIGIN)).routine!;
    expect(restored).toMatchObject({ id: routine.id, name: 'Longa', runCount: 5, status: 'active' });
    expect((await occurrencesOf(routine.id)).map((row) => [row.scheduled_for.toISOString(), row.run_id])).toEqual(occurrencesBefore.slice(-MAX).map((row) => [row.scheduled_for.toISOString(), row.run_id]));
    expect((await runsOf(routine.id)).map((row) => row.id)).toEqual(allRuns.slice(-MAX));
    // O que ficou fora do teto segue sem rotina, como numa exclusão feita pelo dono, e guarda o nome da hora do disparo.
    const cut = await world.pool.query<{ routine_id: string | null; routine_name: string | null }>('SELECT routine_id, routine_name FROM runs WHERE id = ANY($1::bigint[]) ORDER BY id', [allRuns.slice(0, 5 - MAX)]);
    expect(cut.rows).toEqual([{ routine_id: null, routine_name: 'Longa' }, { routine_id: null, routine_name: 'Longa' }]);
    const linked = await world.pool.query<{ id: string; routine_id: string | null }>("SELECT id::text AS id, data ->> 'routineId' AS routine_id FROM messages WHERE id = ANY($1::bigint[]) ORDER BY id", [runCardIds]);
    expect(linked.rows.map((row) => row.routine_id)).toEqual([null, null, routine.id, routine.id, routine.id]);
    expect((await cardsOf(bot, 'routine_refused')).at(-1)?.content).toContain(`só as ${MAX} execuções mais recentes do histórico voltaram`);

    // Segunda recusa: o mesmo resultado, sem repor ocorrências nem avisar de novo.
    expect((await world.routines.refuse(deletion.id, ORIGIN)).routine?.id).toBe(routine.id);
    expect((await occurrencesOf(routine.id)).length).toBe(MAX);
    expect((await runsOf(routine.id)).map((row) => row.id)).toEqual(allRuns.slice(-MAX));
    expect(await cardsOf(bot, 'routine_refused')).toHaveLength(1);
  });
});

describe('recusar e editar só valem enquanto a rotina não mudou depois do cartão (A15)', () => {
  /** O bot cria a rotina `name` e devolve a rotina e o id do cartão aplicado. */
  async function created(bot: Bot, name: string) {
    await world.waitForStatus(await world.send(bot, `[rotina:${name}|08:00]`), 'completed');
    const routine = (await world.routines.list()).routines.find((candidate) => candidate.name === name)!;
    const card = (await cardsOf(bot, 'routine_proposal')).at(-1)!;
    return { routine, cardId: card.id };
  }
  const editBody = (bot: Bot, patch: Partial<RoutineReplace> = {}) => ({ name: 'Lembrete', botId: bot.id, instruction: 'Executar Lembrete', ...daily('08:00'), ...patch });
  const cardStatus = async (id: string) => (await world.pool.query<{ data: { status: string } }>('SELECT data FROM messages WHERE id = $1', [id])).rows[0]?.data.status;

  it('uma edição, uma pausa ou uma exclusão do dono marcam o cartão como "mudou depois": recusar e editar respondem ROUTINE_CHANGED e nada é desfeito nem avisado', async () => {
    const bot = await world.createBot();
    const edited = await created(bot, 'Lembrete');
    await world.routines.update(edited.routine.id, editBody(bot, { name: 'Lembrete renomeado' }), ORIGIN);
    expect(await cardStatus(edited.cardId)).toBe('superseded'); // já na hora, sem esperar o clique
    expect(await codeOf(world.routines.refuse(edited.cardId, ORIGIN))).toBe('ROUTINE_CHANGED');
    expect(await codeOf(world.routines.update(edited.routine.id, editBody(bot), ORIGIN, { cardId: edited.cardId }))).toBe('ROUTINE_CHANGED');
    expect(await world.routines.get(edited.routine.id)).toMatchObject({ name: 'Lembrete renomeado', status: 'active' });

    const paused = await created(bot, 'Pausável');
    await world.routines.pause(paused.routine.id, ORIGIN);
    expect(await cardStatus(paused.cardId)).toBe('superseded');

    const removed = await created(bot, 'Descartável');
    await world.routines.remove(removed.routine.id, ORIGIN);
    expect(await cardStatus(removed.cardId)).toBe('superseded');
    expect(await codeOf(world.routines.refuse(removed.cardId, ORIGIN))).toBe('ROUTINE_CHANGED');

    // Nenhum desses cliques gravou aviso ao bot.
    expect(await cardsOf(bot, 'routine_refused')).toEqual([]);
    expect(await cardsOf(bot, 'routine_edited')).toEqual([]);
  });

  it('uma mudança por fora do serviço (o cartão ainda aparece como aplicado) é pega no clique: ROUTINE_CHANGED e o cartão passa a "mudou depois"', async () => {
    const bot = await world.createBot();
    const { routine, cardId } = await created(bot, 'Lembrete');
    // Mudança que o serviço não vê (arquivar o bot, pausa automática do agendador): o cartão segue "aplicado" até alguém agir.
    await world.pool.query("UPDATE routines SET status = 'paused', next_run_at = NULL WHERE id = $1", [routine.id]);
    expect(await cardStatus(cardId)).toBe('applied');
    expect(await codeOf(world.routines.refuse(cardId, ORIGIN))).toBe('ROUTINE_CHANGED');
    expect(await cardStatus(cardId)).toBe('superseded');
    expect((await world.routines.get(routine.id)).status).toBe('paused'); // nada foi desfeito
    expect(await cardsOf(bot, 'routine_refused')).toEqual([]);
  });

  it('o bot alterar de novo sobrepõe o cartão anterior: só o último pode ser recusado', async () => {
    const bot = await world.createBot();
    const { routine, cardId } = await created(bot, 'Lembrete');
    await world.waitForStatus(await world.send(bot, '[rotina-mudar:Lembrete|10:00]'), 'completed');
    expect(await cardStatus(cardId)).toBe('superseded');
    const latest = (await cardsOf(bot, 'routine_change')).at(-1)!;
    expect(latest.data).toMatchObject({ status: 'applied' });
    expect(await codeOf(world.routines.refuse(cardId, ORIGIN))).toBe('ROUTINE_CHANGED');
    expect((await world.routines.refuse(latest.id, ORIGIN)).routine).toMatchObject({ id: routine.id, schedule: { type: 'daily', times: ['08:00'] } });
  });

  it('editar pelo cartão que o dono já recusou responde ROUTINE_CHANGED (o mesmo código estável) e não grava nem avisa o bot', async () => {
    const bot = await world.createBot();
    const { routine } = await created(bot, 'Lembrete');
    await world.waitForStatus(await world.send(bot, '[rotina-mudar:Lembrete|10:00]'), 'completed');
    const change = (await cardsOf(bot, 'routine_change')).at(-1)!;
    await world.routines.refuse(change.id, ORIGIN); // a rotina volta ao que era e o cartão fica "recusado"
    expect(await cardStatus(change.id)).toBe('refused');
    expect(await codeOf(world.routines.update(routine.id, editBody(bot, { name: 'Lembrete do dono', instruction: 'Não deve ser gravada.' }), ORIGIN, { cardId: change.id }))).toBe('ROUTINE_CHANGED');
    expect(await cardStatus(change.id)).toBe('refused'); // continua recusado, não vira "editado"
    expect(await world.routines.get(routine.id)).toMatchObject({ name: 'Lembrete', schedule: { type: 'daily', times: ['08:00'] } });
    expect(await cardsOf(bot, 'routine_edited')).toEqual([]);
  });

  it('editar pelo cartão grava pela validação do editor, liga a edição ao cartão ("editada") e avisa o bot com o estado final; depois disso, recusar e editar de novo respondem ROUTINE_CHANGED', async () => {
    const bot = await world.createBot();
    const { routine, cardId } = await created(bot, 'Lembrete');
    await markRead(bot);

    // Edição inválida: o erro é o do editor, o cartão continua aplicado e nada é avisado.
    expect(await codeOf(world.routines.update(routine.id, editBody(bot, { schedule: { type: 'interval', every: 2, unit: 'minutes', window: null } }), ORIGIN, { cardId }))).toBe('SCHEDULE_INVALID');
    expect(await cardStatus(cardId)).toBe('applied');
    expect(await cardsOf(bot, 'routine_edited')).toEqual([]);

    const result = await world.routines.update(routine.id, editBody(bot, { name: 'Lembrete do dono', instruction: 'Instrução do dono.', ...daily('09:15') }), ORIGIN, { cardId });
    expect(result).toMatchObject({ id: routine.id, name: 'Lembrete do dono', instruction: 'Instrução do dono.', schedule: { type: 'daily', times: ['09:15'] }, status: 'active' });
    expect(await cardStatus(cardId)).toBe('edited');
    const notice = (await cardsOf(bot, 'routine_edited')).at(-1)!;
    expect(notice.data).toEqual({ type: 'routine_edited', routineId: routine.id, routineName: 'Lembrete do dono' });
    // O aviso leva o estado final: nome, agenda legível, fuso e instrução.
    expect(notice.content).toContain(`O dono editou a rotina "Lembrete do dono" (id ${routine.id}) pelo cartão`);
    expect(notice.content).toContain(`Agenda: ${result.summary} (${SP})`);
    expect(notice.content).toContain('Instrução:\nInstrução do dono.');
    // Fora da bolinha de não lido.
    expect((await summaryOf(bot)).unread).toBe(false);
    const audit = await world.pool.query<{ actor: string; details: Record<string, unknown> }>("SELECT actor, details FROM audit_log WHERE action = 'routine.card_edited' AND target = $1", [routine.id]);
    expect(audit.rows).toEqual([{ actor: 'owner', details: { card: cardId } }]);
    expect(JSON.stringify(audit.rows)).not.toContain('Instrução do dono');

    expect(await codeOf(world.routines.refuse(cardId, ORIGIN))).toBe('ROUTINE_CHANGED');
    expect(await codeOf(world.routines.update(routine.id, editBody(bot), ORIGIN, { cardId }))).toBe('ROUTINE_CHANGED');
    expect(await world.routines.get(routine.id)).toMatchObject({ name: 'Lembrete do dono' });
    expect(await cardsOf(bot, 'routine_edited')).toHaveLength(1);

    // O modelo vê o aviso com o estado final no pedido seguinte.
    const before = world.conversationRequests().length;
    await world.waitForStatus(await world.send(bot, 'E agora?'), 'completed');
    const request = JSON.stringify(world.conversationRequests().slice(before)[0]!.body);
    expect(request).toContain('O dono editou a rotina');
    expect(request).toContain('Instrução do dono.');
  });

  it('só o cartão da própria rotina vale: o cartão de outra rotina, uma mensagem comum e um id inexistente são recusados sem aplicar nada (anti-IDOR)', async () => {
    const bot = await world.createBot();
    const stranger = await world.createBot();
    const mine = await created(bot, 'Lembrete');
    const theirs = await created(stranger, 'Alheia');
    const text = await world.send(bot, 'só uma mensagem');
    await world.waitForStatus(text, 'completed');
    const message = (await world.pool.query<{ id: string }>("SELECT id::text AS id FROM messages WHERE run_id = $1 AND kind = 'text' LIMIT 1", [text])).rows[0] as { id: string };

    // O cartão de outra rotina não liga a edição desta; a mensagem comum e um id inexistente nem são cartões de rotina.
    expect(await codeOf(world.routines.update(mine.routine.id, editBody(bot), ORIGIN, { cardId: theirs.cardId }))).toBe('NOT_FOUND');
    expect(await codeOf(world.routines.update(mine.routine.id, editBody(bot), ORIGIN, { cardId: message.id }))).toBe('NOT_FOUND');
    expect(await codeOf(world.routines.refuse(message.id, ORIGIN))).toBe('NOT_FOUND');
    expect(await codeOf(world.routines.refuse('999999999', ORIGIN))).toBe('NOT_FOUND');
    expect(await cardStatus(mine.cardId)).toBe('applied');
    expect(await cardStatus(theirs.cardId)).toBe('applied');
    expect(await world.routines.get(mine.routine.id)).toMatchObject({ name: 'Lembrete', status: 'active' });
    expect(await world.routines.get(theirs.routine.id)).toMatchObject({ name: 'Alheia', status: 'active' });
  });
});

describe('histórico (F12 passo 5)', () => {
  it('lista os horários do mais recente ao mais antigo, com o estado da execução, e pagina por cursor', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot.id);
    clock = new Date('2026-10-01T10:00:10Z');
    await world.scheduler.tickOnce();
    const [run] = await runsOf(routine.id);
    await world.waitForStatus((run as { id: string }).id, 'completed');
    await world.routines.runNow(routine.id, ORIGIN);
    const history = await world.routines.history(routine.id, undefined);
    expect(history.items.map((item) => [item.state, item.manual])).toEqual([
      ['queued', true],
      ['completed', false],
    ]);
    expect(history.items[1]?.messageId).not.toBeNull(); // o cartão da conversa, para "Ver na conversa"
    expect(history.items[1]?.startedAt).not.toBeNull();

    await world.pool.query(
      `INSERT INTO routine_occurrences (routine_id, scheduled_for, outcome, created_at)
       SELECT $1, timestamptz '2026-01-01' + n * interval '1 day', 'skipped', now() FROM generate_series(1, 55) AS n`,
      [routine.id],
    );
    const first = await world.routines.history(routine.id, undefined);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await world.routines.history(routine.id, first.nextCursor as string);
    expect(second.items).toHaveLength(7); // 57 no total
    expect(second.nextCursor).toBeNull();
    await waitFor('a execução manual terminar', async () => ((await world.pool.query("SELECT 1 FROM runs WHERE routine_id = $1 AND status IN ('queued', 'running')", [routine.id])).rowCount === 0 ? true : null));
  });
});
