// Prova de que o bot VÊ e ALTERA as próprias rotinas (T21; phase 10, A12 e A14, SEC-03 substituída, C6) contra PostgreSQL real, o motor de execução real e o
// provedor falso: `list_routines` e `get_routine` leem só as rotinas do bot (o id de outro bot é "não encontrada"); `propose_routine` cria a rotina ATIVA e
// `propose_routine_change` aplica mudar, pausar, retomar e excluir NA HORA, com as regras do editor e o cartão `applied` com o antes e o depois, auditado como
// `system` sem a instrução, e o resultado de cada ferramenta diz ao bot que já vale. A confirmação do dono de uma proposta ANTIGA pendente (criada antes da
// phase 10, que a ferramenta já não grava) segue valendo: os cartões antigos são inseridos à mão aqui e `confirmChange` os aplica, recusando a desatualizada.
// A recusa e a edição pelo cartão têm a prova própria em `routines/routines.test.ts`.
import { ROUTINE_CHANGE_FIELDS, routineChangeCardSchema, routineProposalCardSchema, type Bot, type RoutineChangeCard, type RoutineScheduleSettings, type RoutineSnapshot, type RoutineView } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../errors';
import { canonicalJson } from '../routines/rows';
import { RoutineService } from '../routines/service';
import { ORIGIN, createRunsWorld, type RunsWorld } from './test-support';
import { GET_ROUTINE_TOOL, LIST_ROUTINES_LIMIT, LIST_ROUTINES_PAGE, LIST_ROUTINES_TOOL, PROPOSE_ROUTINE_CHANGE_TOOL, getRoutineTool, listRoutinesTool, proposeRoutineChangeTool } from './routine-tools';
import { ToolFailure, type ToolContext } from './tools';
import { proposeRoutineTool } from './propose-routine';

it('publica todos os campos de cada agenda em schema aninhado e recusa agendas incompletas no handler', () => {
  const schedules = [
    { type: 'once', at: '2027-01-01T09:00' },
    { type: 'interval', every: 5, unit: 'minutes', window: null },
    { type: 'daily', times: ['09:00'] },
    { type: 'weekly', days: ['MO'], times: ['09:00'] },
    { type: 'monthly_day', day: 'last', time: '09:00' },
    { type: 'monthly_business_day', position: 20, time: '09:00' },
    { type: 'monthly_position', position: 'second', weekday: 'TU', time: '09:00' },
    { type: 'yearly', month: 12, day: 31, time: '09:00' },
    { type: 'cron', expression: '0 9 * * *' },
  ];
  for (const handler of [proposeRoutineTool, proposeRoutineChangeTool]) {
    const root = handler.definition.parameters as { type: string; oneOf?: unknown; properties: { schedule: { oneOf?: { properties: Record<string, unknown> & { type: { const: string } }; required: string[]; additionalProperties: boolean }[] } } };
    expect(root.type).toBe('object'); expect(root.oneOf).toBeUndefined();
    // A18: o esquema aninhado completo da agenda é publicado UMA vez, em `propose_routine`; `propose_routine_change` valida igual no servidor e publica só o contorno (teste de A18 abaixo).
    expect(root.properties.schedule.oneOf).toHaveLength(9);
    for (const schedule of schedules) {
      if (handler === proposeRoutineTool) {
        const branch = root.properties.schedule.oneOf!.find((candidate) => candidate.properties.type.const === schedule.type)!;
        expect(branch.required.sort()).toEqual(Object.keys(schedule).sort());
        expect(branch.additionalProperties).toBe(false);
      }
      const args = handler === proposeRoutineTool ? { name: 'Teste', instruction: 'Teste', schedule } : { routineId: '00000000-0000-4000-8000-000000000001', action: 'update', schedule };
      expect(() => handler.prepare(JSON.stringify(args))).not.toThrow();
      expect(() => handler.prepare(JSON.stringify({ ...args, schedule: { type: schedule.type } }))).toThrow('Argumentos inválidos');
    }
  }
});

const SP = 'America/Sao_Paulo';
let world: RunsWorld;

beforeAll(async () => {
  world = await createRunsWorld();
  world.engine.start();
});

afterAll(async () => {
  await world.cleanup();
});

const daily = (time: string): RoutineScheduleSettings => ({ schedule: { type: 'daily', times: [time] }, timezone: SP, startsAt: null, endsAt: null, maxRuns: null });

const createRoutine = (bot: Bot, name: string, overrides: Partial<RoutineScheduleSettings> & { instruction?: string } = {}): Promise<RoutineView> =>
  world.routines.create({ name, botId: bot.id, instruction: overrides.instruction ?? `Executar ${name}`, ...daily('07:00'), ...overrides }, ORIGIN);

/** O resultado (texto que o bot recebeu) da atividade de uma ferramenta numa execução. */
async function activityOf(runId: string, tool: string): Promise<{ status: string; content: string }> {
  const row = await world.pool.query<{ status: string; content: string }>(
    "SELECT status, content FROM messages WHERE run_id = $1 AND kind = 'activity' AND data->>'tool' = $2 ORDER BY id DESC LIMIT 1",
    [runId, tool],
  );
  return row.rows[0] as { status: string; content: string };
}

/** O cartão de alteração mais recente da conversa do bot, com o id da mensagem. */
async function changeCardOf(bot: Bot): Promise<{ id: string; card: RoutineChangeCard }> {
  const rows = await world.pool.query<{ id: string; data: unknown }>(
    `SELECT m.id::text AS id, m.data FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.bot_id = $1 AND m.kind = 'card' AND m.data->>'type' = 'routine_change' ORDER BY m.id DESC LIMIT 1`,
    [bot.id],
  );
  const row = rows.rows[0];
  if (!row) throw new Error('nenhum cartão de alteração');
  return { id: row.id, card: routineChangeCardSchema.parse(row.data) };
}

/** Insere um cartão de rotina ANTIGO (proposta pendente, criado antes da phase 10) na conversa do bot: a ferramenta já não o grava, mas ele segue confirmável. */
async function insertLegacyCard(bot: Bot, card: RoutineChangeCard): Promise<string> {
  const conversation = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0] as { id: string };
  const inserted = await world.pool.query<{ id: string }>(
    "INSERT INTO messages (conversation_id, role, kind, status, content, data, created_at) VALUES ($1, 'system', 'card', 'done', '', $2, now()) RETURNING id::text AS id",
    [conversation.id, JSON.stringify(card)],
  );
  return (inserted.rows[0] as { id: string }).id;
}

const snapshotOf = (routine: RoutineView): RoutineSnapshot => ({
  name: routine.name, instruction: routine.instruction, schedule: routine.schedule, timezone: routine.timezone, startsAt: routine.startsAt, endsAt: routine.endsAt, maxRuns: routine.maxRuns, summary: routine.summary,
});

/** Proposta antiga de ALTERAÇÃO pendente: `patch` é o "depois" sobre a rotina de agora, e `changed` lista os campos que ele muda. */
function legacyUpdate(routine: RoutineView, patch: Partial<RoutineSnapshot>): RoutineChangeCard {
  const before = snapshotOf(routine);
  const after = { ...before, ...patch };
  const changed = ROUTINE_CHANGE_FIELDS.filter((field) => canonicalJson(after[field]) !== canonicalJson(before[field]));
  return { type: 'routine_change', routineId: routine.id, routineName: routine.name, change: { action: 'update', before, after, changed, nextRuns: [] }, status: 'pending' };
}

/** Proposta antiga pendente de pausar, retomar ou excluir. */
const legacySimple = (routine: RoutineView, action: 'pause' | 'resume' | 'delete'): RoutineChangeCard => ({
  type: 'routine_change', routineId: routine.id, routineName: routine.name, change: { action }, status: 'pending',
});

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `INESPERADO:${String(error)}`;
  }
};

/** Chama a ferramenta direto, no contexto de um bot, para provar o que o modelo falso não alcança (argumentos inválidos, rotina de outro bot). */
const callTool = (tool: typeof getRoutineTool, botId: string, args: unknown): Promise<{ result: string }> =>
  tool.prepare(JSON.stringify(args)).execute({ pool: world.pool, conversationId: '0', botId, runId: '0', signal: new AbortController().signal, now: () => new Date() } satisfies ToolContext);

const failureOf = async (tool: typeof getRoutineTool, botId: string, args: unknown): Promise<string> => {
  try {
    await callTool(tool, botId, args);
    return 'OK';
  } catch (error) {
    // O texto da falha, venha ele solto (execute) ou no envelope único (recusa de argumentos, A21): é o que o modelo lê de "o que deu errado".
    return error instanceof ToolFailure && error.enveloped ? (JSON.parse(error.message) as { message: string }).message : (error as Error).message;
  }
};

describe('criar e ver as próprias rotinas', () => {
  it('criar e alterar por dia útil preservam a agenda e valem na hora, sem confirmação do dono (A12, A14)', async () => {
    const bot = await world.createBot();
    const runId = await world.send(bot, 'Olá');
    await world.waitForStatus(runId, 'completed');
    const row = await world.pool.query<{ conversation_id: string }>('SELECT conversation_id::text FROM runs WHERE id = $1', [runId]);
    const now = () => new Date();
    const context = { pool: world.pool, botId: bot.id, conversationId: row.rows[0]!.conversation_id, runId, now, signal: new AbortController().signal } satisfies ToolContext;
    const settings: RoutineScheduleSettings = { ...daily('09:00'), schedule: { type: 'monthly_business_day', position: 1, time: '09:00' } };
    const created = await proposeRoutineTool.prepare(JSON.stringify({ name: 'Dia útil', instruction: 'Resuma o dia', ...settings })).execute(context);
    expect(created.result).toContain('Rotina criada e ATIVA');
    expect(created.result).toContain('já vale');

    // A rotina já existe e está ativa, sem nenhum clique do dono.
    const routine = (await world.routines.list()).routines.find((candidate) => candidate.bot.id === bot.id)!;
    expect(routine).toMatchObject({ name: 'Dia útil', status: 'active', schedule: settings.schedule, instruction: 'Resuma o dia' });
    const proposalRow = await world.pool.query<{ id: string; data: unknown }>("SELECT id::text, data FROM messages WHERE run_id = $1 AND data->>'type' = 'routine_proposal'", [runId]);
    const card = routineProposalCardSchema.parse(proposalRow.rows[0]!.data);
    expect(card).toMatchObject({ status: 'applied', routineId: routine.id });
    expect(card.proposal.schedule).toEqual(settings.schedule);
    expect(card.nextRuns).toHaveLength(5);
    expect(routine.nextRunAt).toBe(card.nextRuns[0]);

    const changed = { type: 'monthly_business_day', position: 'last', time: '10:00' } as const;
    const outcome = await proposeRoutineChangeTool.prepare(JSON.stringify({ routineId: routine.id, action: 'update', schedule: changed })).execute(context);
    expect(outcome.result).toContain('JÁ VALE');
    const after = await world.routines.get(routine.id);
    expect(after.schedule).toEqual(changed);
    const change = await changeCardOf(bot);
    expect(change.card).toMatchObject({ status: 'applied', routineId: routine.id });
    if (change.card.change.action === 'update') expect(after.nextRunAt).toBe(change.card.change.nextRuns[0]);
    // A rotina mudou depois do cartão de criação: ele passa a "mudou depois" (`superseded`) e só o cartão da alteração segue em vigor.
    expect(routineProposalCardSchema.parse((await world.pool.query<{ data: unknown }>('SELECT data FROM messages WHERE id = $1', [proposalRow.rows[0]!.id])).rows[0]!.data).status).toBe('superseded');
  });

  it('list_routines e get_routine devolvem só as rotinas do bot, com a instrução inteira no detalhe, e a rotina de outro bot é "não encontrada"', async () => {
    const mine = await world.createBot();
    const other = await world.createBot();
    const resumo = await createRoutine(mine, 'Resumo do dia', { instruction: 'Resuma as novidades.\nCite as fontes.' });
    await createRoutine(mine, 'Lembrete', { schedule: { type: 'interval', every: 30, unit: 'minutes', window: null } });
    const foreign = await createRoutine(other, 'Rotina alheia');

    const listing = await world.send(mine, '[rotinas]');
    await world.waitForStatus(listing, 'completed');
    const listed = await activityOf(listing, LIST_ROUTINES_TOOL);
    expect(listed.status).toBe('completed');
    expect(listed.content).toContain('Suas rotinas (2):');
    expect(listed.content).toContain(`id: ${resumo.id}`);
    expect(listed.content).toMatch(/Nome: Resumo do dia\n\s+Estado: Ativa\n\s+Agenda: .*07:00.*\(America\/Sao_Paulo\)\n\s+Próxima execução: .+\n\s+Execuções: 0, sem limite/);
    expect(listed.content).toContain('Nome: Lembrete');
    expect(listed.content).not.toContain('Rotina alheia');
    expect(listed.content).not.toContain(foreign.id);
    // A lista não traz a instrução (ela é longa): só o detalhe.
    expect(listed.content).not.toContain('Resuma as novidades');

    const detail = await world.send(mine, '[rotina-ver:Resumo do dia]');
    await world.waitForStatus(detail, 'completed');
    const shown = await activityOf(detail, GET_ROUTINE_TOOL);
    expect(shown.content).toContain('Resuma as novidades.\nCite as fontes.');
    expect(shown.content).toContain('"type":"daily"');
    expect(shown.content).toContain('Início: sem início definido');

    // A rotina de OUTRO bot, e um id que não existe, dão a MESMA resposta: nada revela que a outra existe.
    const notFound = 'Rotina não encontrada entre as suas. Use list_routines para ver os ids das suas rotinas.';
    expect(await failureOf(getRoutineTool, mine.id, { routineId: foreign.id })).toBe(notFound);
    expect(await failureOf(getRoutineTool, mine.id, { routineId: '00000000-0000-4000-8000-000000000000' })).toBe(notFound);
    expect(await failureOf(proposeRoutineChangeTool, mine.id, { routineId: foreign.id, action: 'delete' })).toBe(notFound);
    expect(await failureOf(getRoutineTool, mine.id, { routineId: 'nao-e-uuid' })).toBe('Argumentos inválidos (routineId: esperado UUID v4 (3º grupo começa com 4; 4º com 8, 9, a ou b)).');
    expect(await failureOf(getRoutineTool, mine.id, { routineId: resumo.id, botId: other.id })).toBe('Argumentos inválidos (argumentos: campo não aceito: botId (aceitos: routineId)).');
    // Sem rotina nenhuma, a resposta diz isso.
    const empty = await world.createBot();
    expect(await failureOf(getRoutineTool, empty.id, { routineId: resumo.id })).toBe(notFound);
    // A rotina de outro bot segue intacta depois das tentativas de alterá-la.
    expect(await world.routines.get(foreign.id)).toMatchObject({ status: 'active', name: 'Rotina alheia' });
  });
});

describe('limites do que o bot lê e altera', () => {
  it('phase-15:A20: list_routines devolve uma página com total e nextOffset e, seguindo o nextOffset, entrega todas as rotinas uma vez só; alteração de rotina pausada não promete próximas execuções', async () => {
    const bot = await world.createBot();
    const total = LIST_ROUTINES_PAGE + 5;
    for (let index = 0; index < total; index += 1) await createRoutine(bot, `Rotina ${String(index).padStart(3, '0')}`);
    // Primeira página: a de tamanho padrão, com o total e o offset da seguinte (a mesma forma de doc_list e read_activity).
    const first = (await callTool(listRoutinesTool, bot.id, {})).result;
    expect(first).toContain(`Suas rotinas (${total}):`);
    expect(first).toContain('Nome: Rotina 000');
    expect(first).toContain(`Nome: Rotina ${String(LIST_ROUTINES_PAGE - 1).padStart(3, '0')}\n`);
    expect(first).not.toContain(`Nome: Rotina ${String(LIST_ROUTINES_PAGE).padStart(3, '0')}\n`);
    expect(first).toContain(`offset: 0 · limit: ${LIST_ROUTINES_PAGE} · total: ${total} · nextOffset: ${LIST_ROUTINES_PAGE}`);
    // Seguindo o nextOffset até null, cada rotina aparece uma vez, na ordem.
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: string = (await callTool(listRoutinesTool, bot.id, { offset, limit: 10 })).result;
      seen.push(...[...page.matchAll(/Nome: (Rotina \d{3})\n/g)].map((match) => match[1]!));
      const next = /nextOffset: (\d+|null)/.exec(page)?.[1];
      offset = next === undefined || next === 'null' ? null : Number(next);
    }
    expect(seen).toEqual(Array.from({ length: total }, (_, index) => `Rotina ${String(index).padStart(3, '0')}`));
    // Além do fim não há nada nem continuação; limit acima do teto é recusado com o envelope de argumentos.
    expect((await callTool(listRoutinesTool, bot.id, { offset: total })).result).toContain(`nextOffset: null`);
    expect(await failureOf(listRoutinesTool, bot.id, { limit: LIST_ROUTINES_LIMIT + 1 })).toMatch(/^Argumentos inválidos \(limit:/);
    expect(await failureOf(listRoutinesTool, bot.id, { offset: -1 })).toMatch(/^Argumentos inválidos \(offset:/);

    // Rotina pausada: o cartão de alteração de agenda não traz datas (ela continua pausada depois da alteração). Bot próprio: a listagem de
    // rotinas acima existem só para provar a paginação e, sem calibração de tokens no provedor falso, pesaria na janela de contexto da conversa (64k nos mundos de teste).
    const pausedBot = await world.createBot();
    const paused = await createRoutine(pausedBot, 'Pausada para propor');
    await world.routines.pause(paused.id, ORIGIN);
    await world.waitForStatus(await world.send(pausedBot, '[rotina-mudar:Pausada para propor|10:15]'), 'completed');
    const { card } = await changeCardOf(pausedBot);
    if (card.change.action !== 'update') throw new Error('esperava update');
    expect(card.change.after.schedule).toEqual({ type: 'daily', times: ['10:15'] });
    expect(card.change.nextRuns).toEqual([]);
    expect(await world.routines.get(paused.id)).toMatchObject({ status: 'paused', nextRunAt: null, schedule: { type: 'daily', times: ['10:15'] } });
  });
});

describe('alterar: aplicado na hora, com o antes e o depois no cartão e o estado anterior guardado (A14, C6)', () => {
  it('mudar aplica na hora, o cartão fica aplicado com os campos que mudaram, o resultado diz que já vale e a trilha guarda ids como system, sem a instrução', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot, 'Boletim', { instruction: 'Instrução antiga.' });

    const run = await world.send(bot, '[rotina-mudar:Boletim|09:30]');
    await world.waitForStatus(run, 'completed');
    const outcome = await activityOf(run, PROPOSE_ROUTINE_CHANGE_TOOL);
    expect(outcome.status).toBe('completed');
    expect(outcome.content).toContain('Alteração aplicada');
    expect(outcome.content).toContain('a rotina "Boletim" foi alterada (campos: instruction, schedule) e a mudança JÁ VALE, sem confirmação do dono');
    expect(outcome.content).toContain('recusar (a rotina volta a ser como era antes) ou editar pelo cartão');

    // O resultado chega ao modelo na etapa seguinte da própria execução (C6).
    expect(JSON.stringify(world.conversationRequests().at(-1)?.body)).toContain('JÁ VALE');

    const { card } = await changeCardOf(bot);
    expect(card).toMatchObject({ type: 'routine_change', routineId: routine.id, routineName: 'Boletim', status: 'applied' });
    if (card.change.action !== 'update') throw new Error('esperava update');
    expect(card.change.changed).toEqual(['instruction', 'schedule']);
    expect(card.change.before).toMatchObject({ instruction: 'Instrução antiga.', schedule: { type: 'daily', times: ['07:00'] } });
    expect(card.change.after).toMatchObject({ name: 'Boletim', instruction: 'Nova instrução de Boletim', schedule: { type: 'daily', times: ['09:30'] }, timezone: SP });
    expect(card.change.after.summary).toContain('09:30');
    expect(card.change.nextRuns).toHaveLength(5);

    // A rotina JÁ mudou (e o próximo horário foi recalculado), e o cartão (só do dono, `content` vazio) não vai ao contexto do modelo na próxima rodada.
    const now = await world.routines.get(routine.id);
    expect(now).toMatchObject({ instruction: 'Nova instrução de Boletim', schedule: { type: 'daily', times: ['09:30'] }, status: 'active' });
    expect(now.nextRunAt).toBe(card.change.nextRuns[0]);
    await world.waitForStatus(await world.send(bot, 'obrigado'), 'completed');
    // (Só o resultado da própria ferramenta e a chamada do bot ficam no contexto; nenhum turno de sistema fala do cartão.)
    const sent = (world.conversationRequests().at(-1)?.body as { messages: { role: string; content: string | null }[] }).messages;
    expect(sent.filter((turn) => typeof turn.content === 'string' && turn.content.startsWith('[Sistema]'))).toEqual([]);

    // D3: o bot grava `system`, com o bot, a execução e a origem; nunca a instrução.
    const audit = await world.pool.query<{ actor: string; ip: string | null; details: Record<string, unknown> }>("SELECT actor, ip, details FROM audit_log WHERE action = 'routine.update' AND target = $1", [routine.id]);
    expect(audit.rows).toEqual([{ actor: 'system', ip: null, details: { bot: bot.id, origin: 'bot', run } }]);
    expect(JSON.stringify(audit.rows)).not.toContain('Nova instrução');
  });

  it('pausar, retomar e excluir valem na hora: a fila é limpa pelas regras de sempre, o estado anterior fica guardado e a exclusão deixa o cartão sem rotina e sem expor o instantâneo', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot, 'Ciclo');

    await world.waitForStatus(await world.send(bot, '[rotina-pausar:Ciclo]'), 'completed');
    const pause = await changeCardOf(bot);
    expect(pause.card).toMatchObject({ change: { action: 'pause' }, status: 'applied', routineId: routine.id });
    expect(await world.routines.get(routine.id)).toMatchObject({ status: 'paused', nextRunAt: null });

    await world.waitForStatus(await world.send(bot, '[rotina-retomar:Ciclo]'), 'completed');
    const resume = await changeCardOf(bot);
    expect(resume.card).toMatchObject({ change: { action: 'resume' }, status: 'applied' });
    expect((await world.routines.get(routine.id)).status).toBe('active');
    // A pausa foi sobreposta pela retomada: o cartão dela já aparece como "mudou depois".
    const pauseNow = await world.pool.query<{ data: unknown }>('SELECT data FROM messages WHERE id = $1', [pause.id]);
    expect(routineChangeCardSchema.parse(pauseNow.rows[0]?.data).status).toBe('superseded');

    const run = await world.send(bot, '[rotina-excluir:Ciclo]');
    await world.waitForStatus(run, 'completed');
    expect((await activityOf(run, PROPOSE_ROUTINE_CHANGE_TOOL)).content).toContain('foi excluída (com o histórico) e a mudança JÁ VALE');
    expect(await codeOf(world.routines.get(routine.id))).toBe('ROUTINE_NOT_FOUND');
    const deleted = await changeCardOf(bot);
    expect(deleted.card).toMatchObject({ change: { action: 'delete' }, status: 'applied', routineId: null });
    // O instantâneo que a recusa usa fica só no servidor: está na linha, mas fora do contrato do cartão.
    const stored = (await world.pool.query<{ data: Record<string, unknown> }>('SELECT data FROM messages WHERE id = $1', [deleted.id])).rows[0]!.data;
    expect(stored.restore).toMatchObject({ routine: { id: routine.id, name: 'Ciclo' } });
    expect(deleted.card).not.toHaveProperty('restore');
    const audit = await world.pool.query<{ action: string; actor: string }>("SELECT action, actor FROM audit_log WHERE target = $1 AND action IN ('routine.pause', 'routine.resume', 'routine.delete') ORDER BY id", [routine.id]);
    expect(audit.rows).toEqual([{ action: 'routine.pause', actor: 'system' }, { action: 'routine.resume', actor: 'system' }, { action: 'routine.delete', actor: 'system' }]);
  });

  it('recusa com o motivo, sem gravar cartão: nada muda, ação com campos, update sem campos, agenda inválida, rotina que não está no estado certo e argumentos fora do contrato', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot, 'Rígida');
    const cardsBefore = Number((await world.pool.query<{ total: string }>("SELECT count(*) AS total FROM messages WHERE data->>'type' = 'routine_change'")).rows[0]?.total);
    const propose = (args: Record<string, unknown>) => failureOf(proposeRoutineChangeTool, bot.id, { routineId: routine.id, ...args });

    expect(await propose({ action: 'update' })).toContain('pelo menos um campo');
    expect(await propose({ action: 'update', name: 'Rígida', timezone: SP })).toBe('Nada mudaria: os valores enviados são iguais aos que a rotina já tem.');
    expect(await propose({ action: 'pause', name: 'Outro nome' })).toContain('só valem em "update"');
    expect(await propose({ action: 'update', schedule: { type: 'interval', every: 2, unit: 'minutes', window: null } })).toMatch(/^Agenda inválida: .*5 minutos.* Corrija e tente de novo\.$/);
    expect(await propose({ action: 'update', schedule: { type: 'once', at: '2020-01-01T10:00' } })).toMatch(/^Agenda inválida:/);
    expect(await propose({ action: 'update', timezone: 'Marte/Olimpo' })).toMatch(/^Agenda inválida:/);
    expect(await propose({ action: 'resume' })).toContain('só uma rotina pausada pode ser retomada');
    // A mensagem diz o que se esperava (valores do schema), sem ecoar o valor recusado.
    expect(await propose({ action: 'apagar' })).toBe('Argumentos inválidos (action: esperado um de update|pause|resume|delete).');
    expect(await propose({ action: 'update', botId: bot.id })).toBe('Argumentos inválidos (argumentos: campo não aceito: botId (aceitos: routineId, action, name, instruction, schedule, timezone, startsAt, endsAt, maxRuns)).');
    expect(await propose({ action: 'update', name: '' })).toBe('Argumentos inválidos (name: mínimo 1 caracteres).');
    expect(await propose({ action: 'update', maxRuns: 0 })).toBe('Argumentos inválidos (maxRuns: mínimo 1).');
    // Nada do que foi recusado mexeu na rotina.
    expect(await world.routines.get(routine.id)).toMatchObject({ name: 'Rígida', status: 'active', schedule: { type: 'daily', times: ['07:00'] }, updatedAt: routine.updatedAt });
    // Pausada, não há o que pausar de novo.
    await world.routines.pause(routine.id, ORIGIN);
    expect(await propose({ action: 'pause' })).toContain('já está pausada');

    const cardsAfter = Number((await world.pool.query<{ total: string }>("SELECT count(*) AS total FROM messages WHERE data->>'type' = 'routine_change'")).rows[0]?.total);
    expect(cardsAfter).toBe(cardsBefore);
    // A mesma lista de campos que o editor tem, sem nenhum a mais: o modelo não alcança `botId`, `status` nem `runCount`.
    expect([...ROUTINE_CHANGE_FIELDS]).toEqual(['name', 'instruction', 'schedule', 'timezone', 'startsAt', 'endsAt', 'maxRuns']);
  });
});

describe('proposta ANTIGA pendente: o dono ainda confirma, com as regras da edição (A15)', () => {
  it('alterar aplica só os campos da proposta, é idempotente, audita como o dono e recalcula o próximo horário', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot, 'Alvo');
    const id = await insertLegacyCard(bot, legacyUpdate(routine, { instruction: 'Nova instrução de Alvo', schedule: { type: 'daily', times: ['09:30'] }, summary: 'Todos os dias às 09:30' }));
    expect((await changeCardOf(bot)).card.status).toBe('pending');
    expect((await world.routines.get(routine.id)).instruction).toBe(routine.instruction); // a proposta antiga só vale depois do Confirmar

    const result = await world.routines.confirmChange(id, ORIGIN);
    expect(result.routine).toMatchObject({ id: routine.id, instruction: 'Nova instrução de Alvo', schedule: { type: 'daily', times: ['09:30'] }, status: 'active' });
    expect(result.routine?.nextRunAt).not.toBe(routine.nextRunAt);
    expect(result.routine?.nextRunAt).toMatch(/T12:30:00\.000Z$/); // 09:30 em Brasília
    expect((await changeCardOf(bot)).card.status).toBe('confirmed');
    // Confirmar de novo devolve o mesmo resultado e não reaplica.
    expect(await world.routines.confirmChange(id, ORIGIN)).toEqual(result);
    const audit = await world.pool.query<{ actor: string; details: Record<string, unknown> }>("SELECT actor, details FROM audit_log WHERE action = 'routine.change_confirmed' AND target = $1", [routine.id]);
    expect(audit.rows).toEqual([{ actor: 'owner', details: { action: 'update', proposal: id } }]);
    expect(JSON.stringify(audit.rows)).not.toContain('Nova instrução'); // a trilha guarda ids, não o texto
  });

  it('o que o dono mudou por fora e não faz parte da proposta é mantido; o que faz parte vira "desatualizada" e nada é aplicado', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot, 'Disputada');
    const edit = (patch: Partial<RoutineView>) =>
      world.routines.update(
        routine.id,
        { name: routine.name, botId: bot.id, instruction: routine.instruction, schedule: routine.schedule, timezone: routine.timezone, startsAt: null, endsAt: null, maxRuns: null, ...patch },
        ORIGIN,
      );

    // A proposta muda agenda e instrução; o dono, por fora, renomeia a rotina: aplicar mantém o nome novo.
    const first = await insertLegacyCard(bot, legacyUpdate(routine, { instruction: 'Nova instrução de Disputada', schedule: { type: 'daily', times: ['10:00'] }, summary: 'Todos os dias às 10:00' }));
    await edit({ name: 'Renomeada pelo dono' });
    const applied = await world.routines.confirmChange(first, ORIGIN);
    expect(applied.routine).toMatchObject({ name: 'Renomeada pelo dono', instruction: 'Nova instrução de Disputada', schedule: { type: 'daily', times: ['10:00'] } });

    // Agora a proposta nova mexe na instrução, e o dono muda a MESMA instrução antes de confirmar: ROUTINE_CHANGED, cartão desatualizado.
    const current = await world.routines.get(routine.id);
    const second = await insertLegacyCard(bot, legacyUpdate(current, { instruction: 'Nova instrução de Renomeada', schedule: { type: 'daily', times: ['11:00'] }, summary: 'Todos os dias às 11:00' }));
    await edit({ name: 'Renomeada pelo dono', instruction: 'Instrução do dono', schedule: { type: 'daily', times: ['10:00'] } });
    expect(await codeOf(world.routines.confirmChange(second, ORIGIN))).toBe('ROUTINE_CHANGED');
    expect((await changeCardOf(bot)).card.status).toBe('stale');
    expect(await world.routines.get(routine.id)).toMatchObject({ instruction: 'Instrução do dono', schedule: { type: 'daily', times: ['10:00'] } });
    // Uma vez desatualizada, continua recusada.
    expect(await codeOf(world.routines.confirmChange(second, ORIGIN))).toBe('ROUTINE_CHANGED');
  });

  it('pausar, retomar e excluir: a confirmação usa as regras de sempre (fila limpa, idempotência) e a exclusão deixa o cartão sem rotina', async () => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot, 'Ciclo');

    const pause = await insertLegacyCard(bot, legacySimple(routine, 'pause'));
    expect((await world.routines.get(routine.id)).status).toBe('active'); // ainda não
    expect((await world.routines.confirmChange(pause, ORIGIN)).routine).toMatchObject({ status: 'paused', nextRunAt: null });

    const resume = await insertLegacyCard(bot, legacySimple(routine, 'resume'));
    expect((await world.routines.confirmChange(resume, ORIGIN)).routine).toMatchObject({ status: 'active' });

    // Duas propostas de excluir a mesma rotina: a primeira exclui; a outra fica desatualizada (a rotina não existe mais).
    const first = await insertLegacyCard(bot, legacySimple(routine, 'delete'));
    const second = await insertLegacyCard(bot, legacySimple(routine, 'delete'));
    expect((await world.routines.confirmChange(first, ORIGIN)).routine).toBeNull();
    expect(await codeOf(world.routines.get(routine.id))).toBe('ROUTINE_NOT_FOUND');
    // Cada confirmação deixou um aviso para o bot (o cartão de alteração é só do dono). A irmã desatualizada não gera aviso. Excluída a rotina, todos os
    // cartões dela perdem o vínculo (R18), avisos inclusive.
    const notices = await world.pool.query<{ data: { action: string; routineId: string | null }; content: string }>(
      "SELECT m.data, m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1 AND m.data->>'type' = 'routine_confirmed' ORDER BY m.id", [bot.id]);
    expect(notices.rows.map((row) => [row.data.action, row.data.routineId])).toEqual([['pause', null], ['resume', null], ['delete', null]]);
    expect(notices.rows[2]!.content).toBe('O dono confirmou a sua proposta: a rotina "Ciclo" foi excluída e isso já está valendo.');
    // A proposta irmã, que nunca mais poderá ser aplicada, já aparece como desatualizada (sem esperar o clique do dono).
    const sibling = await world.pool.query<{ data: unknown }>('SELECT data FROM messages WHERE id = $1', [second]);
    expect(routineChangeCardSchema.parse(sibling.rows[0]?.data)).toMatchObject({ status: 'stale', routineId: null });
    // O cartão confirmado perde a rotina (como os demais cartões de rotina, R18), mas segue confirmado e legível.
    const confirmed = await world.pool.query<{ data: unknown }>('SELECT data FROM messages WHERE id = $1', [first]);
    expect(routineChangeCardSchema.parse(confirmed.rows[0]?.data)).toMatchObject({ status: 'confirmed', routineId: null });
    expect(await codeOf(world.routines.confirmChange(second, ORIGIN))).toBe('ROUTINE_CHANGED');
  });

  it('só confirma uma proposta antiga pendente: outra mensagem, id inexistente, cartão aplicado pelo bot e rotina que trocou de bot são recusados sem aplicar nada', async () => {
    const bot = await world.createBot();
    const stranger = await world.createBot();
    const routine = await createRoutine(bot, 'Migrante');
    const text = await world.send(bot, 'só uma mensagem');
    await world.waitForStatus(text, 'completed');
    const message = (await world.pool.query<{ id: string }>("SELECT id::text AS id FROM messages WHERE run_id = $1 AND kind = 'text' LIMIT 1", [text])).rows[0] as { id: string };
    expect(await codeOf(world.routines.confirmChange(message.id, ORIGIN))).toBe('NOT_FOUND');
    expect(await codeOf(world.routines.confirmChange('999999999', ORIGIN))).toBe('NOT_FOUND');

    // Um cartão aplicado pelo bot já vale: não há o que confirmar (e confirmar não reaplicaria nada).
    await world.waitForStatus(await world.send(bot, '[rotina-pausar:Migrante]'), 'completed');
    const applied = await changeCardOf(bot);
    expect(applied.card.status).toBe('applied');
    expect(await codeOf(world.routines.confirmChange(applied.id, ORIGIN))).toBe('NOT_FOUND');
    await world.routines.resume(routine.id, ORIGIN);

    // A proposta é do bot dono; se a rotina passou para outro bot por fora, a proposta já não vale.
    const proposal = await insertLegacyCard(bot, legacySimple(routine, 'pause'));
    await world.routines.update(routine.id, { name: routine.name, botId: stranger.id, instruction: routine.instruction, schedule: routine.schedule, timezone: routine.timezone, startsAt: null, endsAt: null, maxRuns: null }, ORIGIN);
    expect(await codeOf(world.routines.confirmChange(proposal, ORIGIN))).toBe('ROUTINE_CHANGED');
    expect((await world.routines.get(routine.id)).status).toBe('active');
  });

  it('um erro da própria alteração na hora de confirmar (a agenda deixou de ser válida) deixa o cartão pendente, sem aplicar nada', async () => {
    const bot = await world.createBot();
    // Uma rotina única no futuro; a proposta só renomeia. Depois a data passa (o relógio do serviço avança), e aplicar vira SCHEDULE_IN_PAST.
    const at = new Date(Date.now() + 3 * 60_000);
    const local = new Intl.DateTimeFormat('sv-SE', { timeZone: SP, dateStyle: 'short', timeStyle: 'short' }).format(at).replace(' ', 'T');
    const routine = await createRoutine(bot, 'Pontual', { schedule: { type: 'once', at: local } });
    const id = await insertLegacyCard(bot, legacyUpdate(routine, { name: 'Pontual 2' }));

    // Com o relógio do serviço 10 minutos à frente, a data única já passou: aplicar é recusado e o cartão continua pendente.
    const later = new RoutineService({ pool: world.pool, credentials: world.credentials, now: () => new Date(Date.now() + 10 * 60_000) });
    expect(await codeOf(later.confirmChange(id, ORIGIN))).toBe('SCHEDULE_IN_PAST');
    expect(routineChangeCardSchema.parse((await world.pool.query<{ data: unknown }>('SELECT data FROM messages WHERE id = $1', [id])).rows[0]?.data).status).toBe('pending');
    expect((await world.routines.get(routine.id)).name).toBe('Pontual');
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 15, passo 7 (Q7, Q8): agenda com um único esquema, tamanho das definições e repetição sem duplicar
// ---------------------------------------------------------------------------------------------

/** O contexto de uma execução REAL do bot (conversa e execução existentes), para provar o que grava cartão e rotina. */
async function liveContext(bot: Bot): Promise<ToolContext> {
  const runId = await world.send(bot, 'Olá');
  await world.waitForStatus(runId, 'completed');
  const row = await world.pool.query<{ conversation_id: string }>('SELECT conversation_id::text FROM runs WHERE id = $1', [runId]);
  return { pool: world.pool, botId: bot.id, conversationId: row.rows[0]!.conversation_id, runId, now: () => new Date(), signal: new AbortController().signal };
}

/** Bytes da definição inteira (nome, descrição e parâmetros) como o provedor a recebe no campo `tools`. */
const definitionBytes = (tool: { definition: unknown }): number => Buffer.byteLength(JSON.stringify(tool.definition));

describe('agenda: um único esquema e as mesmas recusas (Q7)', () => {
  it('phase-15:A18: o esquema aninhado da agenda é publicado uma vez e as definições de rotina não passam dos bytes medidos antes da phase', () => {
    const fullSchema = (tool: typeof proposeRoutineTool) => (tool.definition.parameters as { properties: { schedule: { oneOf: { additionalProperties?: boolean }[] } } }).properties.schedule.oneOf.every((branch) => branch.additionalProperties === false);
    const published = [proposeRoutineTool, proposeRoutineChangeTool].filter(fullSchema);
    expect(published.map((tool) => tool.definition.name)).toEqual(['propose_routine']);
    // O handler que só tem o contorno da agenda traz uma variante por tipo que o validador aceita, com os campos obrigatórios de cada uma (derivados do mesmo esquema).
    const outline = (proposeRoutineChangeTool.definition.parameters as { properties: { schedule: { oneOf: { properties: { type: { const: string } }; required: string[] }[] } } }).properties.schedule.oneOf;
    expect(outline.map((branch) => branch.properties.type.const)).toEqual(['once', 'interval', 'daily', 'weekly', 'monthly_day', 'monthly_business_day', 'monthly_position', 'yearly', 'cron']);
    expect([...outline.find((branch) => branch.properties.type.const === 'weekly')!.required].sort()).toEqual(['days', 'times', 'type']);
    // Teto: os bytes medidos na spec (propose_routine 5.259 e propose_routine_change 5.127); o relatório do passo traz o antes e o depois.
    expect(definitionBytes(proposeRoutineTool)).toBeLessThanOrEqual(5259);
    expect(definitionBytes(proposeRoutineChangeTool)).toBeLessThanOrEqual(5127);
    // O que saiu do esquema repetido foi mesmo: a alteração fica muito abaixo do teto, não apenas igual a ele.
    expect(definitionBytes(proposeRoutineChangeTool)).toBeLessThan(3600);
  });

  it.each([
    ['intervalo abaixo de 5 minutos', { type: 'interval', every: 2, unit: 'minutes', window: null }],
    ['janela com início depois do fim', { type: 'interval', every: 30, unit: 'minutes', window: { from: '18:00', to: '09:00' } }],
    ['data única no passado', { type: 'once', at: '2020-01-01T10:00' }],
    ['data que não existe no calendário', { type: 'once', at: '2027-02-31T09:00' }],
    ['cron inválido', { type: 'cron', expression: 'isto não é cron' }],
    ['horário fora do formato', { type: 'daily', times: ['9h'] }],
    ['horário repetido', { type: 'daily', times: ['09:00', '09:00'] }],
    ['agenda como texto livre', 'todo dia às 9'],
    ['campo que a agenda não tem', { type: 'daily', times: ['09:00'], weekday: 'MO' }],
    ['tipo que não existe', { type: 'hourly', every: 2 }],
  ])('phase-15:A18: %s é recusado do mesmo jeito ao criar e ao alterar', async (_label, schedule) => {
    const bot = await world.createBot();
    const routine = await createRoutine(bot, 'Alvo da agenda');
    const created = await failureOf(proposeRoutineTool, bot.id, { name: 'Nova', instruction: 'Fazer', schedule });
    const changed = await failureOf(proposeRoutineChangeTool, bot.id, { routineId: routine.id, action: 'update', schedule });
    expect(created).not.toBe('OK');
    expect(changed).toBe(created);
    // Recusada na criação, nenhuma rotina nasceu; recusada na alteração, a agenda antiga segue valendo.
    expect((await world.routines.list()).routines.filter((candidate) => candidate.bot.id === bot.id)).toHaveLength(1);
    expect((await world.routines.get(routine.id)).schedule).toEqual({ type: 'daily', times: ['07:00'] });
  });
});

describe('repetir a mesma chamada não duplica (Q8)', () => {
  const settings = { name: 'Resumo do dia', instruction: 'Resuma as novidades.', schedule: { type: 'daily', times: ['09:00'] } };
  const create = (context: ToolContext, args: Record<string, unknown> = settings) => proposeRoutineTool.prepare(JSON.stringify(args)).execute(context);
  const routinesOf = async (bot: Bot) => (await world.routines.list()).routines.filter((candidate) => candidate.bot.id === bot.id);
  const proposalCards = async (bot: Bot) =>
    Number((await world.pool.query<{ total: string }>(
      "SELECT count(*) AS total FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1 AND m.data->>'type' = 'routine_proposal'", [bot.id])).rows[0]?.total);

  it('phase-15:A19: propose_routine repetido (em sequência ou em chamadas simultâneas) devolve a rotina já criada, sem segunda rotina nem segundo cartão', async () => {
    const bot = await world.createBot();
    const context = await liveContext(bot);
    // Quatro chamadas ao mesmo tempo: o travamento da linha do bot no banco as serializa, então exatamente uma cria e as outras reencontram a rotina.
    const outcomes = await Promise.all([create(context), create(context), create(context), create(context)]);
    expect(outcomes.filter((outcome) => outcome.result.startsWith('Rotina criada e ATIVA'))).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.result.startsWith('Esta rotina já existe'))).toHaveLength(3);
    const [only] = await routinesOf(bot);
    expect(await routinesOf(bot)).toHaveLength(1);
    expect(await proposalCards(bot)).toBe(1);
    for (const outcome of outcomes) expect(outcome.result).toContain(only!.id);
    // Depois de uma queda do worker a execução recomeça e o bot repete a chamada: o resultado diz que já existe, com o estado atual.
    await world.routines.pause(only!.id, ORIGIN);
    const again = await create(context);
    expect(again.result).toContain('já existe');
    expect(again.result).toContain('Pausada');
    expect(await routinesOf(bot)).toHaveLength(1);
    expect(await proposalCards(bot)).toBe(1);
  });

  it('phase-15:A19: o que muda a configuração cria outra rotina, a mesma configuração em outro bot também, e a excluída não impede criar de novo', async () => {
    const bot = await world.createBot();
    const other = await world.createBot();
    const context = await liveContext(bot);
    await create(context);
    await create(context, { ...settings, name: 'Outro nome' });
    await create(context, { ...settings, instruction: 'Outra instrução.' });
    await create(context, { ...settings, schedule: { type: 'daily', times: ['10:00'] } });
    await create(context, { ...settings, timezone: 'UTC' });
    expect(await routinesOf(bot)).toHaveLength(5);
    await create(await liveContext(other));
    expect(await routinesOf(other)).toHaveLength(1);
    // Excluída a rotina, pedir de novo cria uma nova: a repetição só reencontra o que ainda existe.
    const [first] = (await routinesOf(bot)).filter((candidate) => candidate.name === settings.name && candidate.timezone === SP);
    await world.routines.remove(first!.id, ORIGIN);
    expect((await create(context)).result).toContain('Rotina criada e ATIVA');
  });
});
