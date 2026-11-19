// Prova do complemento durante a execução (phase 4, F5, CONV-03; A8 a A11) contra PostgreSQL real, o motor de verdade e o provedor falso: enviar
// com execução ativa cria complemento sem interromper a ferramenta lenta nem o streaming; ele entra antes da próxima chamada ao modelo sem abrir
// rodada (também na retomada de uma aprovação, depois da chamada aprovada); o desfecho com pendentes os promove a UMA execução na mesma
// transação, sem perda nem duplicação mesmo com envios correndo contra o fim; parar e "Cancelar" devolvem texto e anexos como rascunho, entregue
// uma vez só; e os tetos (20 pendentes, rate limit somado ao envio) valem. A manutenção de contexto fria (phase 11, T8, A13) não é execução "ativa" do dono: a mensagem enviada
// durante ela entra na fila atrás dela, nunca como complemento.
import { randomUUID } from 'node:crypto';
import type { Bot, ComplementView, SendResult } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentService } from '../attachments/service';
import { withTransaction } from '../db/pool';
import { DomainError } from '../errors';
import { GeneralChatService } from '../general-chat/service';
import { createRunsWorld, waitFor, type RunsWorld } from '../runs/test-support';
import type { ToolHandler } from '../runs/tools';
import { purgeExpiredDrafts, readDraft } from './complements';
import { queueContextMaintenance } from './run-queue';

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `INESPERADO:${String(error)}`;
  }
};

/** O envio criou complemento (e não execução): devolve a visão dele. */
function complementOf(result: SendResult): ComplementView {
  if (result.kind !== 'complement') throw new Error(`esperava complemento, veio ${result.kind}`);
  return result;
}

/**
 * `search_history` lenta e controlada pelo teste: a chamada fica "executando" até `release()`, como uma ferramenta demorada de verdade. Prova que
 * o complemento não aborta a ferramenta em curso.
 */
function gatedSearch() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const handler: ToolHandler = {
    definition: { name: 'search_history', description: 'busca lenta de teste', parameters: { type: 'object' } },
    external: false,
    prepare: () => ({
      label: 'Busca lenta',
      execute: async () => {
        await gate;
        return { result: 'resultado da busca lenta' };
      },
    }),
  };
  return { handler, release: () => release() };
}

/** Linhas da conversa do bot com o que as afirmações precisam (inclusive a marca de complemento e a abertura de rodada). */
async function rows(world: RunsWorld, bot: Bot) {
  const found = await world.pool.query<{ id: string; run_id: string | null; role: string; kind: string; status: string; opens_round: boolean; content: string; complement: boolean }>(
    `SELECT m.id::text AS id, m.run_id::text AS run_id, m.role, m.kind, m.status, m.opens_round, m.content, coalesce((m.data->>'complement')::boolean, false) AS complement
     FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1 ORDER BY m.id`,
    [bot.id],
  );
  return found.rows;
}

describe('complemento durante ferramenta lenta e streaming (A8, A9)', () => {
  const slow = gatedSearch();
  let world: RunsWorld;
  beforeAll(async () => {
    world = await createRunsWorld({ tools: [slow.handler] });
  });
  afterAll(async () => {
    await world.cleanup();
  });

  it('chega durante a ferramenta lenta, não a aborta e entra antes da próxima chamada ao modelo sem abrir rodada', async () => {
    const bot = await world.createBot();
    const runId = await world.send(bot, '[pesquisar:contrato] busque');
    world.engine.start();
    await waitFor('ferramenta lenta executando', async () => (await rows(world, bot)).find((row) => row.kind === 'activity' && row.status === 'running'));

    const complement = complementOf(await world.conversations.send(bot.id, 'e considere o anexo de ontem'));
    // Pendente: fora da linha do tempo, dentro da execução ativa (a bolha "Complemento · aguardando").
    const pending = await world.conversations.snapshot(bot.id);
    expect(pending.runs).toMatchObject([{ id: runId, status: 'running', complements: [{ id: complement.id, content: 'e considere o anexo de ontem', attachments: [] }] }]);
    expect(pending.items.some((item) => item.kind === 'text' && item.content === 'e considere o anexo de ontem')).toBe(false);
    expect((await world.runRow(runId)).status).toBe('running');

    slow.release();
    await world.waitForStatus(runId, 'completed');
    const timeline = await rows(world, bot);
    expect(timeline.map((row) => `${row.kind}:${row.role}:${row.status}:${row.opens_round}:${row.complement}`)).toEqual([
      'text:user:done:true:false', // abre a rodada
      'activity:assistant:completed:false:false', // a ferramenta terminou com o resultado (não foi abortada)
      'text:user:done:false:true', // o complemento, lido na fronteira, sem abrir rodada
      'text:assistant:done:false:false',
    ]);
    expect(timeline[1]?.content).toBe('resultado da busca lenta');
    expect(timeline.every((row) => row.run_id === runId)).toBe(true);
    // O modelo respondeu ao complemento, e só a abertura da rodada levou o bloco `# Dados` (o gravado pela execução, igual nas duas etapas, PERF-01 da phase 10).
    expect(timeline[3]?.content).toBe('Resposta: e considere o anexo de ontem');
    type Body = { messages: { role: string; content: unknown }[] };
    const ownerTurns = (body: Body) => body.messages.filter((message) => message.role === 'user' && !(typeof message.content === 'string' && message.content.startsWith('# Objetivo do bot ('))).map((message) => JSON.stringify(typeof message.content === 'string' ? message.content.replace(/\[Evidência do dono: messageId=\d+\]\n\n/g, '') : message.content));
    const [firstRequest, second] = world.conversationRequests().slice(-2).map((request) => request.body as Body);
    const users = ownerTurns(second!);
    expect(users).toHaveLength(2);
    expect(users[0]).toContain('# Dados');
    expect(users[0]).toBe(ownerTurns(firstRequest!)[0]); // o complemento entra depois, sem mexer no bloco da abertura
    expect(users[1]).toBe(JSON.stringify('e considere o anexo de ontem'));
    expect((await world.conversations.snapshot(bot.id)).items.find((item) => item.kind === 'text' && item.role === 'user' && item.content.startsWith('e considere'))).toMatchObject({ complement: true });
    expect((await world.pool.query('SELECT count(*)::int AS total FROM complements')).rows[0]?.total).toBe(0);
  });

  it('chega durante o streaming de uma etapa que ainda chama ferramenta: o texto termina inteiro e o complemento entra antes da chamada seguinte', async () => {
    const bot = await world.createBot();
    const runId = await world.send(bot, '[lento-pesquisar:x] escreva e pesquise');
    await waitFor('texto parcial', async () => (await rows(world, bot)).find((row) => row.role === 'assistant' && row.content.startsWith('parte1')));
    expect(complementOf(await world.conversations.send(bot.id, 'no meio do texto')).content).toBe('no meio do texto');
    slow.release(); // a busca (lenta neste mundo) já foi liberada no teste anterior; aqui ela responde na hora
    await world.waitForStatus(runId, 'completed');
    expect((await rows(world, bot)).map((row) => `${row.kind}:${row.role}:${row.complement}:${row.kind === 'text' ? row.content : ''}`)).toEqual([
      'text:user:false:[lento-pesquisar:x] escreva e pesquise',
      'text:assistant:false:parte1 parte2 parte3 parte4 parte5 parte6 parte7 parte8 ', // o streaming não foi cortado
      'activity:assistant:false:',
      'text:user:true:no meio do texto',
      'text:assistant:false:Resposta: no meio do texto',
    ]);
    expect((await world.pool.query('SELECT count(*)::int AS total FROM runs WHERE bot_id = $1', [bot.id])).rows[0]?.total).toBe(1); // nenhuma execução nova
  });

  it('chega durante o streaming da resposta final: o texto termina inteiro e o complemento vira UMA execução nova com ele', async () => {
    const bot = await world.createBot();
    const runId = await world.send(bot, '[lento] conte até oito');
    await waitFor('texto parcial', async () => (await rows(world, bot)).find((row) => row.role === 'assistant' && row.content.startsWith('parte1')));
    const first = complementOf(await world.conversations.send(bot.id, 'primeiro complemento'));
    const second = complementOf(await world.conversations.send(bot.id, 'segundo complemento'));
    expect(Number(second.id)).toBeGreaterThan(Number(first.id));
    await world.waitForStatus(runId, 'completed');

    const promoted = await world.pool.query<{ id: string; input: string }>("SELECT id::text AS id, input FROM runs WHERE conversation_id = (SELECT id FROM conversations WHERE bot_id = $1) AND id > $2", [bot.id, runId]);
    expect(promoted.rows).toEqual([{ id: expect.any(String), input: 'primeiro complemento\n\nsegundo complemento' }]);
    await world.waitForStatus(promoted.rows[0]!.id, 'completed');
    expect((await rows(world, bot)).map((row) => `${row.role}:${row.opens_round}:${row.complement}:${row.content}`)).toEqual([
      'user:true:false:[lento] conte até oito',
      'assistant:false:false:parte1 parte2 parte3 parte4 parte5 parte6 parte7 parte8 ',
      'user:true:false:primeiro complemento\n\nsegundo complemento',
      'assistant:false:false:Resposta: primeiro complemento\n\nsegundo complemento',
    ]);
  });
});

describe('complemento na retomada após aprovação (A9)', () => {
  let world: RunsWorld;
  beforeAll(async () => {
    world = await createRunsWorld();
    await world.connectComposio();
  });
  afterAll(async () => {
    await world.cleanup();
  });

  it('entra depois da chamada aprovada e antes da chamada seguinte ao modelo; a ação executa uma vez só', async () => {
    const bot = await world.createBot();
    await world.releaseConnectorAccounts(bot);
    const runId = await world.send(bot, '[gmail] envie o relatório');
    world.engine.start();
    await world.waitForStatus(runId, 'waiting_approval');
    const before = world.composioExecutions().length;
    complementOf(await world.conversations.send(bot.id, 'e copie a diretoria'));
    const approval = (await world.approvalOf(runId))!;
    await world.approvals.respond(approval.id, 'allow_once', { ip: '127.0.0.1', userAgent: 'teste' });
    await world.waitForStatus(runId, 'completed');

    expect(world.composioExecutions().length - before).toBe(1);
    const timeline = await rows(world, bot);
    expect(timeline.map((row) => `${row.kind}:${row.role}:${row.complement}`)).toEqual([
      'text:user:false',
      'activity:assistant:false', // a chamada aprovada roda primeiro
      'card:system:false', // o cartão do pedido de aprovação (nasceu na pausa)
      'text:user:true', // o complemento, só depois dela
      'text:assistant:false',
    ]);
    expect(timeline.at(-1)?.content).toBe('Resposta: e copie a diretoria');
  });
});

describe('corrida entre o desfecho e o complemento (A10)', () => {
  let world: RunsWorld;
  beforeAll(async () => {
    world = await createRunsWorld();
  });
  afterAll(async () => {
    await world.cleanup();
  });

  it('envios disparados em volta do fim: cada texto aparece exatamente uma vez e nada fica pendente nem devolvido', async () => {
    const bot = await world.createBot();
    const runId = await world.send(bot, '[lento] base');
    world.engine.start();
    await waitFor('texto parcial', async () => (await rows(world, bot)).find((row) => row.role === 'assistant' && row.content.startsWith('parte1')));
    // Envios em rajada até bem depois do fim: uns caem como complemento da execução, outros correm contra o desfecho, outros viram fila.
    // 16 envios a cada 150 ms cobrem ~2,4 s: o fim da execução de ~2 s cai no meio deles, abaixo do teto de 20 pendentes.
    const texts = Array.from({ length: 16 }, (_, index) => `c${String(index).padStart(2, '0')}`);
    const results: SendResult[] = [];
    for (const text of texts) {
      results.push(await world.conversations.send(bot.id, text));
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await world.waitForStatus(runId, 'completed');
    expect(results.some((result) => result.kind === 'complement')).toBe(true);
    await waitFor('tudo processado', async () => {
      const open = await world.pool.query("SELECT 1 FROM runs WHERE bot_id = $1 AND status IN ('queued', 'running', 'waiting_approval')", [bot.id]);
      return open.rowCount === 0;
    }, 30_000);

    const said = (await rows(world, bot)).filter((row) => row.role === 'user').flatMap((row) => row.content.split('\n\n'));
    for (const text of texts) expect(said.filter((value) => value === text), text).toHaveLength(1);
    expect((await world.pool.query('SELECT count(*)::int AS total FROM complements')).rows[0]?.total).toBe(0);
  });

  it('dois complementos pendentes no desfecho, enviados em paralelo, viram exatamente uma execução com os dois', async () => {
    const bot = await world.createBot();
    const runId = await world.send(bot, '[lento] outra base');
    await waitFor('texto parcial', async () => (await rows(world, bot)).find((row) => row.role === 'assistant' && row.content.startsWith('parte1')));
    const sent = await Promise.all(['paralelo A', 'paralelo B'].map((text) => world.conversations.send(bot.id, text)));
    expect(sent.map((result) => result.kind)).toEqual(['complement', 'complement']);
    await world.waitForStatus(runId, 'completed');
    const promoted = await world.pool.query<{ input: string }>('SELECT input FROM runs WHERE bot_id = $1 AND id > $2', [bot.id, runId]);
    expect(promoted.rows).toHaveLength(1);
    expect(promoted.rows[0]!.input.split('\n\n').sort()).toEqual(['paralelo A', 'paralelo B']);
  });
});

describe('parar e "Cancelar" devolvem o complemento (A11) e os tetos', () => {
  let world: RunsWorld;
  let files: AttachmentService;
  beforeAll(async () => {
    world = await createRunsWorld();
    files = new AttachmentService({ pool: world.pool, conversations: world.conversations });
    world.engine.start();
  });
  afterAll(async () => {
    await world.cleanup();
  });

  it('"Cancelar" devolve texto e anexo como rascunho; dois aparelhos o pedem e só um o recebe; o arquivo volta a ser pendente', async () => {
    const chat = new GeneralChatService({ pool: world.pool });
    const session = await chat.create();
    const ref = { sessionId: session.id };
    await world.conversations.setPreference(ref, 'opencode/glm-5.1', null);
    const sent = await world.conversations.send(ref, '[demorar] não termino');
    await waitFor('rodando', async () => (await world.runRow(sent.id)).status === 'running');

    const file = await files.upload(ref, 'nota.txt', Buffer.from('nota do complemento'));
    const complement = complementOf(await world.conversations.send(ref, 'complemento com anexo', [file.id]));
    expect(complement.attachments).toEqual([{ id: file.id, name: 'nota.txt', kind: 'document', sizeBytes: file.originalBytes, removed: false }]);
    // Ligado ao complemento: não é pendente do composer (não descarta) e está em uso (não exclui em Arquivos).
    expect(await codeOf(files.discard(ref, file.id))).toBe('ATTACHMENT_NOT_FOUND');
    expect(await codeOf(files.remove(file.id, { ip: '127.0.0.1', userAgent: 'teste' }))).toBe('ATTACHMENT_IN_USE');

    const draft = await world.conversations.cancelComplement(ref, complement.id);
    expect(draft).toMatchObject({ content: 'complemento com anexo', attachments: [{ id: file.id }] });
    expect(await codeOf(world.conversations.cancelComplement(ref, complement.id))).toBe('COMPLEMENT_NOT_FOUND');
    const snapshot = await world.conversations.snapshot(ref);
    expect(snapshot.draft).toEqual(draft);
    expect(snapshot.runs[0]?.complements).toEqual([]);
    // O evento `draft` traz o rascunho; o consumo o troca por `draft: null`.
    const conversationId = await world.conversations.conversationIdOf(ref);
    const drafted = (await world.conversations.updatesSince(conversationId, '0')).updates.filter((update) => update.event === 'draft');
    expect(drafted.map((update) => update.data)).toEqual([{ id: draft.id, draft }]);

    const [one, two] = await Promise.allSettled([world.conversations.consumeDraft(ref, draft.id), world.conversations.consumeDraft(ref, draft.id)]);
    const delivered = [one, two].filter((outcome) => outcome.status === 'fulfilled');
    expect(delivered).toHaveLength(1);
    expect((delivered[0] as PromiseFulfilledResult<unknown>).value).toEqual(draft);
    expect([one, two].map((outcome) => (outcome.status === 'rejected' ? (outcome.reason as DomainError).code : 'OK')).sort()).toEqual(['DRAFT_NOT_FOUND', 'OK']);
    expect((await world.conversations.snapshot(ref)).draft).toBeNull();
    const after = (await world.conversations.updatesSince(conversationId, snapshot.lastEventId)).updates.filter((update) => update.event === 'draft');
    expect(after.map((update) => update.data)).toEqual([{ id: draft.id, draft: null }]);
    // Pendente de novo: o próximo envio pode levá-lo (aqui, de novo como complemento da execução que segue ativa).
    expect(complementOf(await world.conversations.send(ref, 'reenviado', [file.id])).attachments).toHaveLength(1);
    await world.conversations.stop(ref);
    await world.waitForStatus(sent.id, 'interrupted');
  });

  it('parar devolve os pendentes sem executá-los e sem promover; o rascunho vence em 24 horas com os anexos', async () => {
    const bot = await world.createBot();
    const runId = await world.send(bot, '[demorar] sem fim');
    await waitFor('rodando', async () => (await world.runRow(runId)).status === 'running');
    const file = await files.upload(bot.id, 'extra.txt', Buffer.from('extra'));
    complementOf(await world.conversations.send(bot.id, 'um', [file.id]));
    complementOf(await world.conversations.send(bot.id, 'dois'));
    await world.conversations.stop(bot.id);
    await world.waitForStatus(runId, 'interrupted');
    // Nenhuma execução nova: o complemento não roda; o rascunho junta os dois com o anexo.
    expect((await world.pool.query('SELECT count(*)::int AS total FROM runs WHERE bot_id = $1', [bot.id])).rows[0]?.total).toBe(1);
    expect((await rows(world, bot)).some((row) => row.role === 'user' && row.content === 'um')).toBe(false);
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    const draft = (await world.conversations.snapshot(bot.id)).draft!;
    expect(draft).toMatchObject({ content: 'um\n\ndois', attachments: [{ id: file.id }] });

    const later = new Date(Date.now() + 25 * 3600_000);
    expect(await readDraft(world.pool, conversationId, later)).toBeNull();
    expect(await purgeExpiredDrafts(world.pool, later)).toBeGreaterThanOrEqual(1);
    expect((await world.pool.query('SELECT 1 FROM attachments WHERE id = $1', [file.id])).rowCount).toBe(0);
    expect((await world.conversations.snapshot(bot.id)).draft).toBeNull();
  });

  it('recusa o 21º complemento pendente com COMPLEMENT_LIMIT_REACHED', async () => {
    const bot = await world.createBot();
    const runId = await world.send(bot, '[demorar] segura');
    await waitFor('rodando', async () => (await world.runRow(runId)).status === 'running');
    for (let index = 1; index <= 20; index += 1) complementOf(await world.conversations.send(bot.id, `pendente ${index}`));
    expect(await codeOf(world.conversations.send(bot.id, 'pendente 21'))).toBe('COMPLEMENT_LIMIT_REACHED');
    await world.conversations.stop(bot.id);
    await world.waitForStatus(runId, 'interrupted');
    expect((await world.conversations.snapshot(bot.id)).draft?.content.split('\n\n')).toHaveLength(20);
  });
});

describe('manutenção de contexto fria em andamento (A13)', () => {
  let world: RunsWorld;
  beforeAll(async () => {
    world = await createRunsWorld();
  });
  afterAll(async () => {
    await world.cleanup();
  });

  it('a mensagem do dono enviada durante a compactação fria entra na fila atrás dela, não vira complemento, "Compactar agora" espera, e a mensagem segue quando ela termina', async () => {
    const bot = await world.createBot();
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    // A compactação fria como o worker a enfileira (manutenção SEM sessão do dono, migration 0048), já em execução: sem o motor ligado ninguém a conclui.
    const cold = await withTransaction(world.pool, (tx) => queueContextMaintenance(tx, { botId: bot.id, conversationId, requestId: randomUUID(), mode: 'summarize', expectedRevision: 0, sessionId: null, at: new Date() }));
    await world.pool.query("UPDATE runs SET status = 'running', started_at = now(), lease_until = now() + interval '1 hour', lease_owner = gen_random_uuid() WHERE id = $1", [cold.id]);

    const sent = await world.conversations.send(bot.id, 'mensagem durante a compactação fria');
    expect(sent.kind).toBe('run');
    expect(await world.runRow(sent.id)).toMatchObject({ status: 'queued' });
    expect((await world.pool.query('SELECT 1 FROM complements')).rowCount).toBe(0);
    // O painel não mostra operação do dono (a fria é do worker, invisível) e dá o motivo genérico de execução aberta; "Compactar agora" também espera.
    const state = await world.conversations.contextState(bot.id);
    expect(state.operation).toBeNull();
    expect(state.eligibility).toMatchObject({ enabled: false, reason: 'Há trabalho na fila ou em execução.' });
    expect(await codeOf(world.conversations.maintainContext(bot.id, { requestId: randomUUID(), mode: 'summarize', expectedRevision: state.revision }, randomUUID()))).toBe('CONTEXT_BUSY');

    // A compactação termina: a mensagem do dono, que esperou na fila, roda e aparece na conversa como sempre.
    await world.pool.query("UPDATE runs SET status = 'completed', finished_at = now(), lease_until = NULL, lease_owner = NULL WHERE id = $1", [cold.id]);
    world.engine.start();
    await world.waitForStatus(sent.id, 'completed');
    expect((await rows(world, bot)).filter((row) => row.opens_round).map((row) => row.content)).toEqual(['mensagem durante a compactação fria']);
  });
});

describe('rate limit somado: envios e complementos', () => {
  let clock = new Date('2026-03-01T12:00:00Z');
  let world: RunsWorld;
  beforeAll(async () => {
    world = await createRunsWorld({ now: () => clock });
  });
  afterAll(async () => {
    await world.cleanup();
  });

  it('a 61ª mensagem do minuto é recusada mesmo quando parte delas foi complemento', async () => {
    const busy = await world.createBot();
    const runId = await world.send(busy, '[demorar] ocupado');
    world.engine.start();
    await waitFor('rodando', async () => (await world.runRow(runId)).status === 'running');
    for (let index = 0; index < 19; index += 1) complementOf(await world.conversations.send(busy.id, `complemento ${index}`));
    const others = await Promise.all([1, 2].map(() => world.createBot()));
    // 1 + 19 complementos + 40 envios = 60 no minuto; o motor para para nada mais rodar e virar complemento por acaso.
    await world.engine.stop();
    for (const bot of others) for (let index = 0; index < 20; index += 1) await world.send(bot, `fila ${index}`);
    expect(await codeOf(world.conversations.send(others[0]!.id, 'passou'))).toBe('RATE_LIMITED');
    clock = new Date(clock.getTime() + 61_000);
    expect(await codeOf(world.conversations.send((await world.createBot()).id, 'janela nova'))).toBe('OK');
  });
});
