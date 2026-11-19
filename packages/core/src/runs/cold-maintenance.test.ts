// Prova da manutenção fria (phase 11, T7; A9, A10, A11, A14, C4 e C5; spec F4 e F6, decisões 13 e 15 a 17 e 23). Mundo real: PostgreSQL embarcado, motor real e provedor falso,
// com um relógio do domínio que o teste move para esfriar a conversa sem esperar. Cada prova olha o que o provedor RECEBEU (os pedidos capturados) e o que ficou no banco:
// - A9: numa conversa fria, os resultados grandes fora das 2 rodadas mais recentes viram o marcador da decisão 15; mensagens do dono, respostas do bot, resultados curtos e as 2
//   rodadas recentes ficam como estão; no Chat geral vale só o caminho ativo; o banco conserva tudo e `read_activity` devolve o original;
// - A10 e C5: o pedido seguinte começa igual ao último pedido limpo e, com o cache quente, cada pedido é prefixo exato do próximo; o checkpoint existente continua válido;
// - A11 e C4: com a conversa quente (dentro de T, exatamente T, execução ativa ou na fila, mensagens depois da limpeza) nada é gravado e o pedido anterior segue prefixo exato;
//   a mesma limpeza nunca é gravada duas vezes;
// - A14: a execução aberta numa conversa fria que o laço ainda não tratou grava a mesma limpeza antes do primeiro pedido, sem chamada extra ao modelo.
// Compactação fria (phase 11, T8; A12, A13 e C6; spec F5, decisões 18 e 20 a 22), no fim do arquivo, com o mesmo mundo (motor real, provedor falso e relógio do domínio movível):
// - A12: a conversa fria que continua em 50% ou mais DEPOIS do mascaramento recebe o checkpoint gravado pelo worker com o Modelo do resumo, sem cartão, push nem bolinha; abaixo de
//   50% depois do mascaramento a execução encerra sem chamar o modelo; recusa registrada não gera nova chamada; falha não muda a conversa nem derruba execução;
// - A13 e C6: a mensagem enviada durante a compactação espera na fila e usa o checkpoint novo, e a mensagem seguinte não dispara chamada de resumo;
// - proteções do enfileiramento (quente, leve, sem chave, sem modelo validado, arquivado) e idempotência por revisão.
import { randomUUID } from 'node:crypto';
import type { Bot } from '@aion/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentService } from '../attachments/service';
import { readContextRevision } from '../conversation/context-state';
import { queueRun } from '../conversation/run-queue';
import type { SessionRef } from '../conversation/service';
import { GeneralChatService } from '../general-chat/service';
import type { Logger } from '../logging';
import type { ChatEvent, ChatRequest } from '../models/chat-protocols';
import { activityReadTool } from './activity-read';
import { COLD_AFTER_MS, COLD_COMPACTION_SHARE, COLD_OPENING_TOKENS, COLD_TRIGGER_TOKENS, ColdMaintenance, coldRequestId, coldTailTokens, coldTriggerTokens, enqueueColdCompaction, maskColdResults } from './cold-maintenance';
import { formatCount } from './context';
import { anchoredInputTokens, readContextAnchor } from './context-anchor';
import { COMPACTION_THRESHOLD, MAX_OUTPUT_TOKENS, contextEnvelope, estimateChatPayload } from './context-budget';
import { commitContextSummary, loadManagedContext, validCheckpoint } from './context-checkpoint';
import { mergeEvidence } from './evidence-provenance';
import { tableMarker } from '../testing/fake-upstreams';
import { readTokenCalibration } from './token-calibration';
import { ORIGIN, createRunsWorld, waitFor, type RunsWorld } from './test-support';
import type { ToolContext, ToolHandler } from './tools';

const BASE = new Date('2026-03-01T15:00:00Z');
const minutes = (count: number): number => count * 60_000;

/** Resultado grande da ferramenta de teste (acima do limiar de 1.000 caracteres da decisão 15, abaixo do teto de 12.000 do pedido): o texto vai ao modelo como foi gravado. */
const bigResult = (query: string): string => `${query}: ${'linha de dado gravada. '.repeat(90)}`;
/**
 * Resultado enorme (cerca de 7.900 caracteres, bem abaixo do teto de 12.000): três deles mais o piso levam o pedido quente a cerca de 35 mil tokens, entre os 50% (23.552) e os 90% (42.394) do
 * orçamento de 47.104 (phase 12), e mascarar dois deles o tira de cima dos 50% (compactação fria). Com 10.500 caracteres, o tamanho da phase 11 (orçamento de 55.296), a 4ª rodada passa dos
 * 90% do orçamento novo e dispara a compactação a quente, que invalida a premissa.
 */
const hugeResult = (query: string): string => `${query}: ${'linha enorme gravada. '.repeat(360)}`;

/**
 * No lugar de `search_history` (a ferramenta que o roteiro `[pesquisar:a|b]` do provedor falso chama): consulta que começa por "g" devolve o resultado grande, qualquer outra um curto
 * ("p1: curto"). Assim uma mesma etapa tem um resultado elegível e um que nunca é mascarado.
 */
const dataTool: ToolHandler = {
  definition: { name: 'search_history', description: 'Resultado sintético da prova: consulta com "g" devolve um resultado grande (acima do limiar de mascaramento), com "h" um enorme e as demais um curto.', parameters: { type: 'object' } },
  external: false,
  prepare: (raw) => {
    const query = String((JSON.parse(raw) as { query?: unknown }).query ?? '');
    return { label: `Buscar ${query}`, execute: async () => ({ result: query.startsWith('g') ? bigResult(query) : query.startsWith('h') ? hugeResult(query) : `${query}: curto` }) };
  },
};

/** Corpo (chat/completions) que o provedor falso recebeu. */
interface ModelBody {
  messages: { role: string; content?: string }[];
  tools?: unknown[];
}

/** Relógio do domínio dos mundos deste arquivo: o teste o move. */
function createClock() {
  let value = BASE;
  return {
    now: (): Date => value,
    set: (date: Date): void => { value = date; },
    advance: (count: number): void => { value = new Date(value.getTime() + minutes(count)); },
  };
}
type Clock = ReturnType<typeof createClock>;

const worlds: RunsWorld[] = [];
const extraEngines: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(extraEngines.splice(0).map((engine) => engine.stop().catch(() => undefined)));
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
});

/** Mundo com a ferramenta de teste, o relógio movível, o motor ligado e o laço da limpeza fria (sem `start()`: o teste o aciona com `tickOnce`). */
async function scenario({ realTools = false, contextWindow, coreCatalog = false }: { realTools?: boolean; contextWindow?: 'product'; coreCatalog?: boolean } = {}) {
  const clock = createClock();
  // `realTools`: as ferramentas internas de verdade do motor (`read_attachment` entre elas) no lugar da `search_history` sintética.
  // `coreCatalog`: o bot publica as "mais usadas" ao lado das portas (a lista que a conversa fria recalcula pelo uso, phase 15).
  const world = await createRunsWorld({ now: clock.now, ...(realTools ? {} : { tools: [dataTool] }), ...(contextWindow ? { contextWindow } : {}), ...(coreCatalog ? { coreCatalog } : {}) });
  worlds.push(world);
  world.engine.start();
  const sweeper = new ColdMaintenance({ pool: world.pool, logger: world.logger, now: clock.now });
  return { world, clock, sweeper };
}

const bodiesSince = (world: RunsWorld, since: number): ModelBody[] => world.conversationRequests().slice(since).map((request) => request.body as unknown as ModelBody);
/** O pedido anterior é prefixo exato do seguinte (mensagens e ferramentas): o que o cache de prefixo do provedor exige. */
function expectPrefix(previous: ModelBody, next: ModelBody): void {
  expect(next.messages.length).toBeGreaterThan(previous.messages.length);
  expect(next.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
  expect(next.tools).toEqual(previous.tools);
}

/** Envia uma mensagem e espera a execução concluir; devolve o id da execução. Aceita bot ou sessão do Chat geral. */
async function say(world: RunsWorld, target: Bot | SessionRef, text: string): Promise<string> {
  const id = 'sessionId' in target ? (await world.conversations.send(target, text)).id : await world.send(target, text);
  await world.waitForStatus(id, 'completed');
  return id;
}

/** Sessão nova do Chat geral com modelo escolhido. */
async function openSession(world: RunsWorld): Promise<SessionRef> {
  const session = await new GeneralChatService({ pool: world.pool }).create();
  await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
  return { sessionId: session.id };
}

const conversationOf = async (world: RunsWorld, target: Bot | SessionRef): Promise<string> => ('sessionId' in target ? target.sessionId : world.conversations.conversationIdOf(target.id));

/**
 * Quatro rodadas, a um minuto uma da outra (a conversa fica quente): a 1ª com um resultado grande (g1) e um curto (p1), a 2ª e a 3ª com um grande cada (g2 e g3) e a 4ª sem
 * ferramenta. As duas rodadas mais recentes são a 3ª e a 4ª, então os elegíveis ao mascaramento são g1 e g2.
 */
async function converse(world: RunsWorld, clock: Clock, target: Bot | SessionRef): Promise<void> {
  for (const text of ['[pesquisar:g1|p1] primeira', '[pesquisar:g2] segunda', '[pesquisar:g3] terceira', 'quarta']) {
    await say(world, target, text);
    clock.advance(1);
  }
}

interface ActivityRow { id: string; runId: string; content: string }
/** Os resultados de ferramenta da conversa, na ordem (g1, p1, g2, g3 depois de `converse`). */
async function activities(world: RunsWorld, conversationId: string): Promise<ActivityRow[]> {
  return (await world.pool.query<ActivityRow>("SELECT id::text AS id, run_id::text AS \"runId\", content FROM messages WHERE conversation_id = $1 AND kind = 'activity' ORDER BY messages.id", [conversationId])).rows;
}
const queryOf = (row: ActivityRow): string => row.content.split(':')[0]!;

/** O marcador da decisão 15 para um resultado: ferramenta, tamanho gravado em PT-BR, id da linha e a dica de releitura. */
const markerOf = (row: ActivityRow): string => `[resultado de search_history, ${formatCount(row.content.length)} caracteres, #${row.id}; releia com read_activity]`;

/** Todas as linhas da conversa como estão no banco (a prova de que nada gravado muda). */
async function snapshot(world: RunsWorld, conversationId: string): Promise<unknown[]> {
  return (await world.pool.query('SELECT to_jsonb(m) AS row FROM messages m WHERE conversation_id = $1 ORDER BY id', [conversationId])).rows;
}

const maskedRows = async (world: RunsWorld): Promise<{ id: string; at: Date }[]> =>
  (await world.pool.query<{ id: string; at: Date }>('SELECT message_id::text AS id, masked_at AS at FROM context_cold_masks ORDER BY message_id')).rows;

/** O instante da última chamada ao modelo da conversa (a base da frieza). */
async function lastCall(world: RunsWorld, conversationId: string): Promise<Date> {
  return (await world.pool.query<{ at: Date }>('SELECT max(created_at) AS at FROM model_call_usage WHERE conversation_id = $1', [conversationId])).rows[0]!.at;
}
const after = (base: Date, count: number): Date => new Date(base.getTime() + minutes(count));

/** O pedido anterior com os resultados mascarados trocados pelo marcador: o pedido que o provedor deve receber depois da limpeza (só os turnos `tool` mudam). */
function withMarkers(prior: ModelBody, masked: ActivityRow[]): ModelBody['messages'] {
  const markers = new Map(masked.map((row) => [row.content, markerOf(row)]));
  return prior.messages.map((turn) => (turn.role === 'tool' && markers.has(turn.content ?? '') ? { ...turn, content: markers.get(turn.content!)! } : turn));
}

describe('conversa fria de um bot (A9, A10, C5)', () => {
  it('só os resultados grandes fora das 2 rodadas recentes viram marcador; nada gravado muda, o pedido seguinte começa igual ao último pedido limpo e cada pedido é prefixo do próximo', async () => {
    const { world, clock, sweeper } = await scenario();
    const bot = await world.createBot();
    const conversationId = await conversationOf(world, bot);
    await converse(world, clock, bot);
    const prior = bodiesSince(world, 0).at(-1)!; // o pedido da rodada 4, o último antes da limpeza
    const [g1, p1, g2, g3] = await activities(world, conversationId) as [ActivityRow, ActivityRow, ActivityRow, ActivityRow];
    expect([g1, p1, g2, g3].map(queryOf)).toEqual(['g1', 'p1', 'g2', 'g3']);
    expect(p1.content.length).toBeLessThan(1000);
    const stored = await snapshot(world, conversationId);
    const measured = await world.conversations.contextState(bot.id);
    expect(measured.measurement?.stale).toBe(false);

    // Esfria: mais de T sem nenhuma chamada ao modelo. Um ciclo grava a limpeza dos dois resultados elegíveis (g1 e g2), uma vez.
    const cold = after(await lastCall(world, conversationId), 41);
    clock.set(cold);
    expect(await sweeper.tickOnce()).toBe(1);
    const masks = await maskedRows(world);
    expect(masks.map((mask) => mask.id)).toEqual([g1.id, g2.id]);
    expect(masks.every((mask) => mask.at.getTime() === cold.getTime())).toBe(true);
    // O que está gravado não muda (a limpeza é só uma marca), e o original continua legível por `read_activity`, inteiro.
    expect(await snapshot(world, conversationId)).toEqual(stored);
    const context: ToolContext = { pool: world.pool, conversationId, botId: bot.id, runId: '0', signal: new AbortController().signal, now: clock.now };
    const read = await activityReadTool.prepare(JSON.stringify({ messageId: g1.id })).execute(context);
    expect(read.result).toContain('linha de dado gravada.');
    expect(read.result).toContain(`"totalChars":${g1.content.length}`);
    // O painel de contexto sabe que a medição ficou desatualizada: o pedido mudou sem mudar nenhuma mensagem.
    expect((await world.conversations.contextState(bot.id)).measurement?.stale).toBe(true);

    // O pedido seguinte (duas etapas: a ferramenta e a resposta) começa EXATAMENTE como o último pedido limpo: só g1 e g2 viraram marcador, e todo o resto (mensagens do dono com
    // o `# Dados` delas, respostas, o resultado curto e as duas rodadas recentes) é idêntico ao que o provedor recebeu antes.
    const since = world.conversationRequests().length;
    await say(world, bot, '[pesquisar:g5] quinta');
    const [first, second] = bodiesSince(world, since) as [ModelBody, ModelBody];
    const expectedPrior = withMarkers(prior, [g1, g2]);
    expect(expectedPrior.filter((turn, index) => turn !== prior.messages[index])).toHaveLength(2);
    expect(first.messages.slice(0, prior.messages.length)).toEqual(expectedPrior);
    expect(first.tools).toEqual(prior.tools);
    const toolTexts = first.messages.filter((turn) => turn.role === 'tool').map((turn) => turn.content);
    expect(toolTexts.slice(0, 4)).toEqual([markerOf(g1), p1.content, markerOf(g2), g3.content]);
    expectPrefix(first, second);
    // Com a conversa quente de novo, nada novo foi gravado.
    expect((await maskedRows(world)).map((mask) => mask.id)).toEqual([g1.id, g2.id]);
  });

  it('com o cache quente depois da limpeza, mais rodadas com resultados grandes não mascaram nada e todo pedido é prefixo exato do seguinte (A11, C4)', async () => {
    const { world, clock, sweeper } = await scenario();
    const bot = await world.createBot();
    const conversationId = await conversationOf(world, bot);
    await converse(world, clock, bot);
    clock.set(after(await lastCall(world, conversationId), 41));
    expect(await sweeper.tickOnce()).toBe(1);
    const [g1, , g2, g3] = await activities(world, conversationId) as [ActivityRow, ActivityRow, ActivityRow, ActivityRow];

    // Três mensagens seguidas, a um minuto uma da outra: a 3ª rodada sai do grupo das 2 recentes, mas a conversa está quente e ela não é mascarada.
    const since = world.conversationRequests().length;
    for (const text of ['[pesquisar:g5] quinta', '[pesquisar:g6] sexta', 'setima']) {
      await say(world, bot, text);
      clock.advance(1);
      expect(await sweeper.tickOnce()).toBe(0);
    }
    const requests = bodiesSince(world, since);
    expect(requests).toHaveLength(5);
    for (let index = 1; index < requests.length; index += 1) expectPrefix(requests[index - 1]!, requests[index]!);
    expect((await maskedRows(world)).map((mask) => mask.id)).toEqual([g1.id, g2.id]);
    const toolTexts = requests.at(-1)!.messages.filter((turn) => turn.role === 'tool').map((turn) => turn.content);
    expect(toolTexts).toContain(g3.content); // a 3ª rodada, fora das 2 recentes, segue inteira
    expect(toolTexts).toContain(markerOf(g1));
    expect(toolTexts).toContain(markerOf(g2));
  });

  it('a mesma limpeza não é gravada duas vezes: o laço repetido, a abertura e a chamada direta não acrescentam nem atualizam nada (idempotente)', async () => {
    const { world, clock, sweeper } = await scenario();
    const bot = await world.createBot();
    const conversationId = await conversationOf(world, bot);
    await converse(world, clock, bot);
    clock.set(after(await lastCall(world, conversationId), 41));
    expect(await sweeper.tickOnce()).toBe(1);
    const written = await maskedRows(world);
    expect(written).toHaveLength(2);

    clock.advance(10); // continua fria (nenhuma chamada nova) e o instante do domínio avançou
    expect(await sweeper.tickOnce()).toBe(0);
    expect(await maskColdResults(world.pool, { conversationId, now: clock.now(), origin: 'sweep', logger: world.logger })).toBe(0);
    expect(await maskedRows(world)).toEqual(written); // nada acrescentado e o `masked_at` original preservado
  });
});

describe('conversa quente (A11, C4)', () => {
  it('nada é gravado dentro de T, em exatamente T, nem com execução ativa ou na fila; passado T e livre, a limpeza é gravada', async () => {
    const { world, clock, sweeper } = await scenario();
    const bot = await world.createBot();
    const conversationId = await conversationOf(world, bot);
    await converse(world, clock, bot);
    const last = await lastCall(world, conversationId);

    clock.set(after(last, 5));
    expect(await sweeper.tickOnce()).toBe(0);
    clock.set(new Date(last.getTime() + COLD_AFTER_MS)); // exatamente T: ainda quente (a frieza é "há MAIS de T")
    expect(await sweeper.tickOnce()).toBe(0);
    expect(await maskedRows(world)).toEqual([]);

    // Passado T, mas com uma execução em cada estado que conta (sem motor ligado, ninguém as reivindica): a conversa não está fria e nada é gravado.
    await world.engine.stop();
    clock.set(new Date(last.getTime() + COLD_AFTER_MS + 1));
    const blockers: { status: string; columns: string }[] = [
      { status: 'waiting_approval', columns: '' },
      { status: 'running', columns: ", lease_until = now() + interval '1 hour'" },
      { status: 'queued', columns: '' },
    ];
    for (const { status, columns } of blockers) {
      const run = (await world.pool.query<{ id: string }>('INSERT INTO runs (conversation_id, bot_id, input, created_at) VALUES ($1, $2, $3, now()) RETURNING id', [conversationId, bot.id, 'bloqueio'])).rows[0]!.id;
      if (status !== 'queued') await world.pool.query(`UPDATE runs SET status = $2, started_at = now() ${columns} WHERE id = $1`, [run, status]);
      expect(await sweeper.tickOnce(), status).toBe(0);
      expect(await maskedRows(world), status).toEqual([]);
      await world.pool.query('DELETE FROM runs WHERE id = $1', [run]);
    }
    // Sem nenhuma execução ativa ou na fila e passado T: agora sim.
    expect(await sweeper.tickOnce()).toBe(1);
    expect(await maskedRows(world)).toHaveLength(2);
  });

  it('uma conversa sem nenhuma chamada registrada nunca é fria', async () => {
    const { world, clock, sweeper } = await scenario();
    const bot = await world.createBot();
    const conversationId = await conversationOf(world, bot);
    await converse(world, clock, bot);
    await world.pool.query('DELETE FROM model_call_usage WHERE conversation_id = $1', [conversationId]);
    clock.advance(24 * 60);
    expect(await sweeper.tickOnce()).toBe(0);
    expect(await maskedRows(world)).toEqual([]);
  });
});

describe('checkpoint existente', () => {
  it('continua válido depois da limpeza (o conteúdo coberto não muda) e o pedido segue com o resumo e o marcador só do que ainda está no pedido', async () => {
    const { world, clock, sweeper } = await scenario();
    const bot = await world.createBot();
    const conversationId = await conversationOf(world, bot);
    await converse(world, clock, bot);
    const [g1, , g2] = await activities(world, conversationId) as [ActivityRow, ActivityRow, ActivityRow];

    // Um checkpoint que cobre a rodada 1 inteira (g1 e p1 entre as linhas cobertas); g2, da rodada 2, segue visível.
    const managed = await loadManagedContext(world.pool, conversationId);
    const secondOpening = managed.rows.filter((row) => row.opens_round)[1]!.id!;
    const covered = managed.rows.filter((row) => BigInt(row.id!) < BigInt(secondOpening));
    expect(await commitContextSummary(world.pool, conversationId, managed.checkpoint.revision, 'Checkpoint da rodada 1: o dono pediu a primeira consulta.', covered, mergeEvidence(), clock.now())).toBe(true);
    const before = await loadManagedContext(world.pool, conversationId);
    expect(await validCheckpoint(world.pool, conversationId, bot.id, before.checkpoint, before.rows)).toBe(true);

    clock.set(after(await lastCall(world, conversationId), 41));
    expect(await sweeper.tickOnce()).toBe(1);
    const next = await loadManagedContext(world.pool, conversationId);
    expect(next.rows.filter((row) => row.cold_masked).map((row) => row.id)).toEqual([g1.id, g2.id]);
    // A revisão e a impressão do checkpoint não mudaram, e ele continua valendo.
    expect(next.checkpoint).toEqual(before.checkpoint);
    expect(next.checkpoint.revision).toBe(1);
    expect(await validCheckpoint(world.pool, conversationId, bot.id, next.checkpoint, next.rows)).toBe(true);

    const since = world.conversationRequests().length;
    await say(world, bot, 'quinta');
    const [request] = bodiesSince(world, since) as [ModelBody];
    const users = request.messages.filter((turn) => turn.role === 'user').map((turn) => turn.content ?? '');
    expect(users.some((text) => text.includes('# Resumo derivado') && text.includes('Checkpoint da rodada 1'))).toBe(true);
    const toolTexts = request.messages.filter((turn) => turn.role === 'tool').map((turn) => turn.content);
    expect(toolTexts).toContain(markerOf(g2)); // visível e mascarado
    expect(JSON.stringify(request.messages)).not.toContain(`#${g1.id};`); // coberto pelo checkpoint: nem o marcador entra
    expect((await world.pool.query('SELECT revision FROM conversation_context WHERE conversation_id = $1', [conversationId])).rows).toEqual([{ revision: 1 }]);
  });
});

// A25 (phase 15, passo 12): a limpeza fria troca o esquema devolvido por abrir_grupo (acima de 1.000 caracteres) pelo marcador de releitura. O modelo volta ao esquema abrindo o MESMO caminho de novo
// (a porta não tem estado: devolve os mesmos esquemas como resultados novos, no fim do histórico) e a chamada pela porta use_tool termina com o efeito esperado; reler pelo marcador (read_activity) também serve.
describe('A25: a abertura de um grupo mascarada pela conversa fria (phase 15, passo 12)', () => {
  it('depois da limpeza fria o esquema sai do pedido e fica o marcador; abrir o caminho de novo devolve o esquema e use_tool grava a memória; a releitura da abertura pelo marcador devolve os esquemas', async () => {
    const { world, clock, sweeper } = await scenario({ realTools: true });
    const bot = await world.createBot();
    const conversationId = await conversationOf(world, bot);
    const open = tableMarker('abrir_grupo', { path: 'ferramentas/memoria' });
    await say(world, bot, open);
    clock.advance(1);
    for (const text of ['segunda', 'terceira', 'quarta']) { await say(world, bot, text); clock.advance(1); } // a abertura fica fora das 2 rodadas mais recentes
    const [opening] = await activities(world, conversationId) as [ActivityRow];
    const schemaIn = (body: ModelBody): boolean => body.messages.some((turn) => turn.role === 'tool' && (turn.content ?? '').includes('"name":"edit_memory"') && (turn.content ?? '').includes('"parameters"'));
    const toolTexts = (body: ModelBody): string[] => body.messages.filter((turn) => turn.role === 'tool').map((turn) => turn.content ?? '');

    // Antes da limpeza (conversa quente) o esquema está no pedido; passado T, a limpeza grava o marcador no lugar dele.
    let since = world.conversationRequests().length;
    await say(world, bot, 'quinta');
    expect(schemaIn(bodiesSince(world, since)[0]!)).toBe(true);
    clock.set(after(await lastCall(world, conversationId), 41));
    expect(await sweeper.tickOnce()).toBe(1);
    expect((await maskedRows(world)).map((row) => row.id)).toEqual([opening.id]);
    const marker = `[resultado de abrir_grupo, ${formatCount(opening.content.length)} caracteres, #${opening.id}; releia com read_activity]`;
    since = world.conversationRequests().length;
    await say(world, bot, 'sexta');
    const [masked] = bodiesSince(world, since) as [ModelBody];
    expect(toolTexts(masked)).toContain(marker);
    expect(schemaIn(masked)).toBe(false);

    // O modelo precisa da ferramenta: abre o mesmo caminho de novo e o esquema volta, em resultado novo (A25).
    since = world.conversationRequests().length;
    await say(world, bot, open);
    const [beforeOpening, afterOpening] = bodiesSince(world, since) as [ModelBody, ModelBody];
    expect(schemaIn(beforeOpening)).toBe(false);
    expect(schemaIn(afterOpening)).toBe(true);
    expect(toolTexts(afterOpening)).toContain(marker); // a abertura antiga segue mascarada: o esquema vem da abertura nova
    // E chama pela porta: a chamada termina com o efeito esperado (a memória do bot recebe a nota).
    const note = 'ZQ-A25-conversa-fria';
    await say(world, bot, tableMarker('use_tool', { name: 'edit_memory', arguments: { operation: 'append', content: note } }));
    expect((await world.pool.query<{ content: string }>('SELECT content FROM bot_memories WHERE bot_id = $1', [bot.id])).rows[0]!.content).toContain(note);

    // O caminho do marcador: reler a abertura mascarada por read_activity devolve os esquemas gravados (o original íntegro segue no banco).
    since = world.conversationRequests().length;
    await say(world, bot, tableMarker('read_activity', { messageId: opening.id, part: 'result' }));
    const [, afterReading] = bodiesSince(world, since) as [ModelBody, ModelBody];
    expect(toolTexts(afterReading).some((text) => text.includes('"name":"edit_memory"') && text.includes('"parameters"'))).toBe(true);
    expect((await activities(world, conversationId))[0]!.content).toBe(opening.content);
  });
});

describe('bot em anthropic/ com a conversa fria (phase 17, A19)', () => {
  it('A19: depois da limpeza fria, o pedido ao Claude leva o marcador no tool_result, nenhum bloco thinking volta em pedido algum e a execução conclui sem 400 do falso', async () => {
    const { world, clock, sweeper } = await scenario();
    await world.connectAnthropic();
    const bot = await world.createBot({ model: 'anthropic/claude-haiku-5-5' });
    const conversationId = await conversationOf(world, bot);
    const since = world.upstreams.requests.length;
    await converse(world, clock, bot);
    const [g1, p1, g2, g3] = await activities(world, conversationId) as [ActivityRow, ActivityRow, ActivityRow, ActivityRow];

    // Esfria e grava a limpeza dos dois resultados grandes fora das 2 rodadas recentes.
    clock.set(after(await lastCall(world, conversationId), 41));
    expect(await sweeper.tickOnce()).toBe(1);
    expect((await maskedRows(world)).map((mask) => mask.id)).toEqual([g1.id, g2.id]);

    // A mensagem seguinte (uma ferramenta e a resposta) vai ao Claude com os resultados mascarados no formato do messages.
    const marker = world.upstreams.requests.length;
    await say(world, bot, '[pesquisar:g5] quinta');
    const chats = (from: number) => world.upstreams.requests.slice(from).filter((request) => request.service === 'anthropic' && request.method === 'POST' && request.body !== undefined && Array.isArray(request.body.system));
    const afterCold = chats(marker);
    expect(afterCold).toHaveLength(2);
    const blocks = (body: Record<string, unknown>) => (body.messages as { content: { type: string; content?: unknown }[] }[]).flatMap((message) => message.content);
    expect(blocks(afterCold[0]!.body!).filter((block) => block.type === 'tool_result').map((block) => block.content).slice(0, 4)).toEqual([markerOf(g1), p1.content, markerOf(g2), g3.content]);

    // Em NENHUM pedido da conversa inteira (antes e depois da limpeza) volta thinking, e cada etapa respondeu (o falso recusaria com 400 um pedido com bloco de raciocínio).
    const all = chats(since);
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const chat of all) expect(blocks(chat.body!).map((block) => block.type), 'thinking reenviado').not.toEqual(expect.arrayContaining(['thinking']));
    for (const chat of all) expect(blocks(chat.body!).some((block) => block.type === 'redacted_thinking')).toBe(false);
    expect((await world.pool.query<{ status: string }>('SELECT DISTINCT status FROM runs WHERE conversation_id = $1', [conversationId])).rows).toEqual([{ status: 'completed' }]);
  });
});

describe('Chat geral (A9)', () => {
  it('só o caminho ativo é mascarado: o resultado da versão de resposta que saiu do caminho fica como está e nunca entra no pedido', async () => {
    const { world, clock, sweeper } = await scenario();
    const ref = await openSession(world);
    const conversationId = ref.sessionId;
    const first = await say(world, ref, '[pesquisar:g1|p1] primeira');
    clock.advance(1);
    const regenerated = await world.conversations.regenerate(ref, first); // a resposta gerada agora é a em vigor; a primeira sai do caminho
    await world.waitForStatus(regenerated.id, 'completed');
    clock.advance(1);
    for (const text of ['[pesquisar:g2] segunda', '[pesquisar:g3] terceira', 'quarta']) {
      await say(world, ref, text);
      clock.advance(1);
    }
    // O "Novo chat aberto" sai do pedido na 5ª mensagem da sessão por regra própria do Chat geral (nada a ver com a limpeza); o resto do pedido anterior tem de continuar igual.
    const prior = bodiesSince(world, 0).at(-1)!;
    prior.messages = prior.messages.filter((turn) => turn.content !== '[Sistema] Novo chat aberto.');
    const all = await activities(world, conversationId);
    const offPath = all.filter((row) => row.runId === first);
    const onPath = all.filter((row) => row.runId !== first);
    expect(offPath.map(queryOf)).toEqual(['g1', 'p1']);
    expect(onPath.map(queryOf)).toEqual(['g1', 'p1', 'g2', 'g3']);
    const [g1, , g2] = onPath as [ActivityRow, ActivityRow, ActivityRow];

    clock.set(after(await lastCall(world, conversationId), 41));
    expect(await sweeper.tickOnce()).toBe(1);
    expect((await maskedRows(world)).map((mask) => mask.id)).toEqual([g1.id, g2.id]); // nenhum resultado da versão fora do caminho

    const since = world.conversationRequests().length;
    await say(world, ref, 'quinta');
    const [request] = bodiesSince(world, since) as [ModelBody];
    expect(request.messages.slice(0, prior.messages.length)).toEqual(withMarkers(prior, [g1, g2]));
    const text = JSON.stringify(request.messages);
    expect(text).toContain(markerOf(g1));
    expect(text).toContain(markerOf(g2));
    for (const row of offPath) expect(text).not.toContain(`#${row.id};`);
  });
});

describe('abertura da execução numa conversa fria (A14)', () => {
  it('sem passagem do laço, a abertura grava a mesma limpeza antes do primeiro pedido e sem chamada extra ao modelo; a conversa quente não é tocada', async () => {
    const { world, clock } = await scenario();
    const swept = await world.createBot();
    const opened = await world.createBot();
    const [sweptId, openedId] = [await conversationOf(world, swept), await conversationOf(world, opened)];
    await converse(world, clock, swept);
    await converse(world, clock, opened);
    const cold = after(new Date(Math.max((await lastCall(world, sweptId)).getTime(), (await lastCall(world, openedId)).getTime())), 41);
    clock.set(cold);

    // Referência: a limpeza que o laço grava ANTES de o dono escrever (a mesma função que a abertura usa).
    expect(await maskColdResults(world.pool, { conversationId: sweptId, now: cold, origin: 'sweep', logger: world.logger })).toBe(2);
    expect(await maskedRows(world)).toHaveLength(2);

    // Abertura: nenhuma limpeza gravada para a conversa; o laço nunca passou por ela.
    const before = await world.conversationRequests().length;
    const usageBefore = (await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM model_call_usage WHERE conversation_id = $1', [openedId])).rows[0]!.total;
    const openedRows = await activities(world, openedId);
    const run = await say(world, opened, 'quinta');
    const [request, ...others] = bodiesSince(world, before) as [ModelBody];
    expect(others).toEqual([]); // uma única chamada ao modelo: a da etapa. A limpeza não chamou o modelo
    const calls = await world.pool.query<{ purpose: string }>('SELECT purpose FROM model_call_usage WHERE run_id = $1', [run]);
    expect(calls.rows).toEqual([{ purpose: 'main' }]);
    expect(Number((await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM model_call_usage WHERE conversation_id = $1', [openedId])).rows[0]!.total)).toBe(Number(usageBefore) + 1);

    // Gravada antes do primeiro pedido: o próprio pedido já leva os marcadores de g1 e g2 e os demais resultados como estão.
    const [g1, p1, g2, g3] = openedRows as [ActivityRow, ActivityRow, ActivityRow, ActivityRow];
    const toolTexts = request.messages.filter((turn) => turn.role === 'tool').map((turn) => turn.content);
    expect(toolTexts).toEqual([markerOf(g1), p1.content, markerOf(g2), g3.content]);
    const mine = (await maskedRows(world)).filter((mask) => openedRows.some((row) => row.id === mask.id));
    expect(mine.map((mask) => mask.id)).toEqual([g1.id, g2.id]);
    expect(mine.every((mask) => mask.at.getTime() === cold.getTime())).toBe(true);

    // É o mesmo mascaramento: os mesmos resultados (pela ordem) e a mesma forma do pedido que a referência, tirando os ids.
    const sweptRows = await activities(world, sweptId);
    const sweptMasked = new Set((await maskedRows(world)).map((mask) => mask.id).filter((id) => sweptRows.some((row) => row.id === id)));
    expect(sweptRows.map((row) => sweptMasked.has(row.id))).toEqual(openedRows.map((row) => mine.some((mask) => mask.id === row.id)));
    const sweptBefore = world.conversationRequests().length;
    await say(world, swept, 'quinta');
    const [reference] = bodiesSince(world, sweptBefore) as [ModelBody];
    const shape = (body: ModelBody): (string | undefined)[] => body.messages.filter((turn) => turn.role === 'tool').map((turn) => turn.content?.replace(/#\d+;/, '#ID;'));
    expect(shape(request)).toEqual(shape(reference));

    // A conversa quente não muda: uma abertura logo depois (menos de T) não grava nada.
    const warmBefore = (await maskedRows(world)).length;
    clock.advance(1);
    await say(world, opened, '[pesquisar:g7] sexta');
    expect(await maskedRows(world)).toHaveLength(warmBefore);
  });
});

describe('âncora de ocupação (CTX-08, decisão 17)', () => {
  it('a limpeza fria descarta a âncora, tanto a gravada pelo laço antes da mensagem quanto a gravada pela abertura: a medição da chamada seguinte é a estimativa calibrada, não o usage antigo mais o acréscimo', async () => {
    const { world, clock } = await scenario();
    await world.models.test('opencode/glm-5.1'); // o teste do modelo usa o provedor: acontece antes de o usage ser trocado
    // O provedor falso segue roteando os cenários, mas o usage informado passa a ser realista (30% da estimativa crua do pedido): só assim existe uma âncora plausível.
    const real = world.provider.streamChat.bind(world.provider);
    const measuredAtCall: { conversationId: string; request: Parameters<typeof real>[2]; measured: number }[] = [];
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (...args): AsyncGenerator<ChatEvent> {
      const request = args[2];
      // A medição já foi gravada quando o provedor é chamado: é o número que o gatilho acabou de usar.
      const stored = await world.pool.query<{ measurement: { inputTokens: number } }>('SELECT measurement FROM conversation_context WHERE conversation_id = $1', [request.sessionId ?? null]);
      if (stored.rows[0]) measuredAtCall.push({ conversationId: request.sessionId!, request, measured: stored.rows[0].measurement.inputTokens });
      for await (const event of real(...args)) {
        yield event.type === 'usage' ? { type: 'usage', usage: { ...event.usage, inputTokens: Math.round(estimateChatPayload(request, 'chat_completions').textTokens * 0.3) } } : event;
      }
    });
    const [viaSweep, viaOpening] = [await world.createBot(), await world.createBot()];
    const [sweepConversation, openingConversation] = [await conversationOf(world, viaSweep), await conversationOf(world, viaOpening)];
    await converse(world, clock, viaSweep);
    await converse(world, clock, viaOpening);
    const cold = after(new Date(Math.max((await lastCall(world, sweepConversation)).getTime(), (await lastCall(world, openingConversation)).getTime())), 41);
    clock.set(cold);

    // Antes da limpeza as duas conversas têm âncora (o usage da última chamada principal).
    expect(await readContextAnchor(world.pool, sweepConversation, 'opencode/glm-5.1')).not.toBeNull();
    const anchorBeforeOpening = (await readContextAnchor(world.pool, openingConversation, 'opencode/glm-5.1'))!;
    expect(anchorBeforeOpening).not.toBeNull();
    expect(await maskColdResults(world.pool, { conversationId: sweepConversation, now: cold, origin: 'sweep', logger: world.logger })).toBe(2);
    expect(await readContextAnchor(world.pool, sweepConversation, 'opencode/glm-5.1')).toBeNull(); // o laço descartou a dela

    for (const [bot, conversationId, anchor] of [[viaSweep, sweepConversation, null], [viaOpening, openingConversation, anchorBeforeOpening]] as const) {
      const { scale } = await readTokenCalibration(world.pool, 'opencode/glm-5.1');
      const callsBefore = measuredAtCall.length;
      await say(world, bot, 'quinta');
      const call = measuredAtCall.slice(callsBefore).find((entry) => entry.conversationId === conversationId)!;
      const calibrated = estimateChatPayload(call.request, 'chat_completions', undefined, scale);
      expect(call.measured).toBe(calibrated.estimatedInputTokens);
      // A conta que valeria com a âncora antiga é outra: o pedido encolheu, e a âncora (o usage do pedido de antes) a daria diferente. O que a abertura gravou a descartou a tempo.
      if (anchor) expect(call.measured).not.toBe(anchoredInputTokens(anchor, calibrated, scale));
    }
    expect(await maskedRows(world)).toHaveLength(4);
  });
});

describe('anexo lido por read_attachment (decisão 15; a deduplicação da mensagem do dono)', () => {
  it('a página inicial lida (fonte da deduplicação) nunca vira marcador e o texto segue no pedido; outra página do mesmo anexo vira marcador', async () => {
    const { world, clock, sweeper } = await scenario({ realTools: true, contextWindow: 'product' });
    const bot = await world.createBot();
    const conversationId = await conversationOf(world, bot);
    const service = new AttachmentService({ pool: world.pool, conversations: world.conversations });
    const document = (label: string, lines: number): string => Array.from({ length: lines }, (_, index) => `${label} linha ${index}: conteúdo sintético do documento.`).join('\n');
    // Um documento que cabe numa página (a mensagem do dono o traz inline até a leitura o repetir) e um com mais de uma página (4.096 bytes cada).
    const small = await service.upload(bot.id, 'pequeno.txt', Buffer.from(document('A', 35)));
    const wide = await service.upload(bot.id, 'largo.txt', Buffer.from(document('B', 130)));
    const send = async (text: string, attachments: string[] = []): Promise<void> => {
      await world.waitForStatus((await world.conversations.send(bot.id, text, attachments)).id, 'completed');
      clock.advance(1);
    };
    await send(`[anexo-ler:${small.id}]`, [small.id]); // rodada 1: lê a página inicial do pequeno (a mensagem do dono deixa de repetir o texto)
    await send(`[anexo-ler:${wide.id}]`, [wide.id]); // rodada 2: lê a página inicial do largo
    await send(`[anexo-ler:${wide.id}|4000]`); // rodada 3: outra página do largo
    await send('quarta');
    await send('quinta');

    const reads = (await world.pool.query<{ id: string; content: string; offset: string }>(
      "SELECT id::text AS id, content, data->'detail'->>'offset' AS \"offset\" FROM messages WHERE conversation_id = $1 AND kind = 'activity' ORDER BY messages.id", [conversationId])).rows;
    const [firstPage, widePage, otherPage] = reads as [(typeof reads)[number], (typeof reads)[number], (typeof reads)[number]];
    expect(reads.map((read) => read.offset)).toEqual(['0', '0', '4000']);
    for (const read of reads) expect(read.content.length).toBeGreaterThan(1000); // as três são grandes o bastante: só a regra da página inicial protege as duas primeiras
    const prior = bodiesSince(world, 0).at(-1)!;
    const dedup = 'Página inicial íntegra já disponível no resultado read_attachment desta rodada';
    expect(JSON.stringify(prior.messages)).toContain(dedup); // a mensagem do dono da rodada 1 já não repete o texto: ele está na leitura

    clock.set(after(await lastCall(world, conversationId), 41));
    expect(await sweeper.tickOnce()).toBe(1);
    expect((await maskedRows(world)).map((mask) => mask.id)).toEqual([otherPage.id]); // só a página fora da inicial

    const since = world.conversationRequests().length;
    await send('sexta');
    const [request] = bodiesSince(world, since) as [ModelBody];
    const marker = `[resultado de read_attachment, ${formatCount(otherPage.content.length)} caracteres, #${otherPage.id}; releia com read_activity]`;
    const expectedPrior = prior.messages.map((turn) => (turn.role === 'tool' && turn.content === otherPage.content ? { ...turn, content: marker } : turn));
    expect(expectedPrior.filter((turn, index) => turn !== prior.messages[index])).toHaveLength(1);
    expect(request.messages.slice(0, prior.messages.length)).toEqual(expectedPrior);
    const toolTexts = request.messages.filter((turn) => turn.role === 'tool').map((turn) => turn.content);
    expect(toolTexts).toEqual([firstPage.content, widePage.content, marker]); // o texto das páginas iniciais continua no pedido
    expect(JSON.stringify(request.messages)).toContain(dedup); // e a mensagem do dono segue sem repeti-lo, como antes da limpeza
  });
});

describe('trava da fila (concorrência)', () => {
  it.each(['bot', 'sessão'] as const)('%s: com uma transação segurando a trava de queueRun a limpeza desiste sem gravar; solta a trava, a passagem seguinte grava', async (kind) => {
    const { world, clock, sweeper } = await scenario();
    const target = kind === 'bot' ? await world.createBot() : await openSession(world);
    const conversationId = await conversationOf(world, target);
    await converse(world, clock, target);
    const cold = after(await lastCall(world, conversationId), 41);
    clock.set(cold);

    const holder = await world.pool.connect();
    try {
      // Um envio em andamento: a mesma trava e inserção de `queueRun`, ainda sem commit (a execução enfileirada não existe para quem lê de fora).
      await holder.query('BEGIN');
      await queueRun(holder, { botId: 'sessionId' in target ? null : target.id, conversationId, input: 'envio em andamento', at: cold, enforceLimit: true });
      expect(await maskColdResults(world.pool, { conversationId, now: cold, origin: 'sweep', logger: world.logger })).toBe(0);
      expect(await sweeper.tickOnce()).toBe(0);
      expect(await maskedRows(world)).toEqual([]);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    expect(await sweeper.tickOnce()).toBe(1);
    expect(await maskedRows(world)).toHaveLength(2);
  });
});

describe('falha na limpeza', () => {
  /** Faz todo INSERT em `context_cold_masks` da conversa falhar (erro de banco simulado, código P0001) ou desfaz isso. O id vem do banco (uuid), nunca de fora. */
  const breakMasks = (world: RunsWorld, conversationId: string) => world.pool.query(
    `CREATE OR REPLACE FUNCTION fail_cold_mask() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha simulada da limpeza fria'; END $$;
     CREATE TRIGGER fail_cold_mask BEFORE INSERT ON context_cold_masks FOR EACH ROW WHEN (NEW.conversation_id = '${conversationId}') EXECUTE FUNCTION fail_cold_mask()`);
  const repairMasks = (world: RunsWorld) => world.pool.query('DROP TRIGGER fail_cold_mask ON context_cold_masks');

  it('o laço registra a falha só com identificador e código padronizado, não lança e segue com as demais conversas; a passagem seguinte, já sem o erro, trata a que falhou', async () => {
    const { world, clock, sweeper } = await scenario();
    const [broken, fine] = [await world.createBot(), await world.createBot()];
    const [brokenId, fineId] = [await conversationOf(world, broken), await conversationOf(world, fine)];
    await converse(world, clock, broken);
    await converse(world, clock, fine);
    clock.set(after(new Date(Math.max((await lastCall(world, brokenId)).getTime(), (await lastCall(world, fineId)).getTime())), 41));
    await breakMasks(world, brokenId);
    const errors = vi.spyOn(world.logger, 'error');

    await expect(sweeper.tickOnce()).resolves.toBe(1); // só a conversa sã recebeu a limpeza; a falha não derrubou o ciclo
    const masked = async (id: string) => Number((await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM context_cold_masks WHERE conversation_id = $1', [id])).rows[0]!.total);
    expect([await masked(brokenId), await masked(fineId)]).toEqual([0, 2]);
    const [logged] = errors.mock.calls.filter((call) => typeof call[1] === 'string' && call[1].includes('limpeza fria da conversa')) as unknown as [[Record<string, unknown>, string]];
    expect(logged[0]).toEqual({ conversationId: brokenId, err: { type: 'DatabaseError', code: 'P0001' } });
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/falha simulada|linha de dado gravada/); // nem a mensagem do banco nem conteúdo da conversa vão ao log

    await repairMasks(world);
    expect(await sweeper.tickOnce()).toBe(1);
    expect(await masked(brokenId)).toBe(2);
  });

  it('o laço de fundo sobrevive a um ciclo que falha por inteiro: registra e tenta de novo no ciclo seguinte', async () => {
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    let attempts = 0;
    const pool = { query: () => { attempts += 1; throw Object.assign(new Error('banco fora do ar'), { code: 'ECONNREFUSED' }); } } as unknown as ConstructorParameters<typeof ColdMaintenance>[0]['pool'];
    const loop = new ColdMaintenance({ pool, logger, config: { pollMs: 10 } });
    loop.start();
    for (let index = 0; index < 200 && attempts < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await loop.stop();
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(logger.error).toHaveBeenCalledWith({ err: { type: 'DatabaseError', code: 'ECONNREFUSED' } }, 'falha na limpeza fria das conversas');
  });

  it('na abertura, a falha da limpeza só gera log: a execução conclui, o pedido segue sem a limpeza e nada é gravado', async () => {
    const { world, clock } = await scenario();
    const bot = await world.createBot();
    const conversationId = await conversationOf(world, bot);
    await converse(world, clock, bot);
    const originals = (await activities(world, conversationId)).map((row) => row.content);
    clock.set(after(await lastCall(world, conversationId), 41));
    await breakMasks(world, conversationId);
    const warnings = vi.spyOn(world.logger, 'warn');

    const since = world.conversationRequests().length;
    const run = await say(world, bot, 'quinta'); // `say` só retorna com a execução `completed`
    expect((await world.runRow(run)).status).toBe('completed');
    const [request] = bodiesSince(world, since) as [ModelBody];
    expect(request.messages.filter((turn) => turn.role === 'tool').map((turn) => turn.content)).toEqual(originals); // sem marcador: o pedido é o de sempre
    expect(await maskedRows(world)).toEqual([]);
    const [logged] = warnings.mock.calls.filter((call) => typeof call[1] === 'string' && call[1].includes('limpeza fria na abertura')) as unknown as [[Record<string, unknown>, string]];
    expect(logged[0]).toMatchObject({ runId: run, conversationId, err: { type: 'DatabaseError', code: 'P0001' } });
    expect(JSON.stringify(warnings.mock.calls)).not.toMatch(/falha simulada|linha de dado gravada/);
  });
});

describe('execução de manutenção', () => {
  it('"Compactar agora" numa conversa fria não grava a limpeza na abertura (a compactação esquenta a conversa; a fria é da T8, depois do laço)', async () => {
    const { world, clock } = await scenario();
    const bot = await world.createBot();
    await world.models.test('opencode/glm-5.1');
    const conversationId = await conversationOf(world, bot);
    await converse(world, clock, bot);
    clock.set(after(await lastCall(world, conversationId), 41));
    const state = await world.conversations.contextState(bot.id);
    const requestId = randomUUID();
    await world.conversations.maintainContext(bot.id, { requestId, mode: 'summarize', expectedRevision: state.revision }, randomUUID());
    const maintenance = (await world.pool.query<{ id: string }>('SELECT id::text FROM runs WHERE context_operation_id = $1', [requestId])).rows[0]!.id;
    await world.waitForStatus(maintenance, 'completed');
    expect(await maskedRows(world)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Compactação fria em segundo plano (phase 11, T8; F5; A12, A13 e C6)
// ---------------------------------------------------------------------------------------------

/** Orçamento de entrada dos mundos deste arquivo (janela de 65.536, saída de 16.384, 25% da janela na phase 12, e margem de 2.048 = 47.104): os 50% da compactação fria caem em 23.552 tokens e os 90% do gatilho de sempre em 42.394. */
const BUDGET = contextEnvelope(65_536, MAX_OUTPUT_TOKENS).inputBudget;

/** Começo do turno de sistema da chamada de resumo (`summaryPrompt`, `runs/compaction.ts`): é o que distingue o resumo de uma conversa comum. */
const SUMMARY_SYSTEM = 'Você produz o checkpoint do histórico';
const isSummary = (request: ChatRequest): boolean => request.turns[0]?.role === 'system' && request.turns[0].text.startsWith(SUMMARY_SYSTEM);
const isSummaryBody = (body: ModelBody): boolean => body.messages[0]?.role === 'system' && (body.messages[0].content ?? '').startsWith(SUMMARY_SYSTEM);

/**
 * O que o provedor falso faz com o resumo: `valid` o deixa responder um checkpoint válido; `empty` devolve saída vazia (recusa definitiva); `hold` segura a chamada até o teste liberar;
 * `afterPaid` roda quando o provedor já respondeu e informou o uso (o fim do stream) e ANTES de o motor gravar o checkpoint, o instante entre pagar o resumo e aplicá-lo.
 */
interface SummaryScript { mode: 'valid' | 'empty'; hold: Promise<void> | null; afterPaid: (() => Promise<void>) | null; summaries: ChatRequest[] }

/** Observa e, se o teste pede, controla as chamadas de resumo; as demais chamadas seguem para o provedor falso de verdade (roteiros `[pesquisar:...]` incluídos). */
function watchSummaries(world: RunsWorld, script: Partial<Pick<SummaryScript, 'mode' | 'hold' | 'afterPaid'>> = {}): SummaryScript {
  const state: SummaryScript = { mode: script.mode ?? 'valid', hold: script.hold ?? null, afterPaid: script.afterPaid ?? null, summaries: [] };
  const real = world.provider.streamChat.bind(world.provider);
  vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (...args): AsyncGenerator<ChatEvent> {
    const request = args[2];
    if (!isSummary(request)) { yield* real(...args); return; }
    state.summaries.push(request);
    if (state.hold) await state.hold;
    if (state.mode === 'empty') {
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } };
      yield { type: 'done', reason: 'stop' };
      return;
    }
    for await (const event of real(...args)) {
      if (event.type === 'done' && state.afterPaid) await state.afterPaid();
      yield event;
    }
  });
  return state;
}

/**
 * Histórico antigo semeado ANTES das rodadas (a cobertura começa do zero, `loadManagedContext`): `count` mensagens do dono de `chars` caracteres, cada uma a sua unidade. O piso do
 * pedido (sistema, `# Dados` e ferramentas) e as quatro rodadas de `converse` pesam JUNTOS cerca de 18 mil tokens estimados (sem calibração, 1 byte por token; medido com o guia de uso do
 * Aion da phase 14, que inclui a linha de docs: o turno de sistema cresce com cada linha nova do guia, e foi isso que recalibrou esta fixture): três mensagens de 7.500 levam o pedido a cerca de
 * 40 mil tokens, entre os 50% (23.552) e os 90% (42.394) do orçamento de 47.104 (reserva de saída de 16.384 da phase 12), então nenhum resumo roda enquanto a conversa está quente.
 * O trecho final da compactação (até 25%, 11.776) guarda as rodadas (cerca de 5 mil tokens depois do mascaramento) e SÓ CABERIA mais uma mensagem se ela tivesse menos de cerca de 6.800: com
 * 7.500 o trecho final guarda só as rodadas, e o resto (as três mensagens) é o lote coberto. O pedido compactado (piso + rodadas + o checkpoint típico de 4.000 que a compactação supõe,
 * `CHECKPOINT_TYPICAL_BYTES`) fica em cerca de 18 mil tokens, bem abaixo dos 50% (23.552), com uma folga de cerca de 5 mil que absorve linhas novas no guia. Com quatro mensagens de 6.000 (a
 * forma de antes) a última mensagem entrava no trecho final e o pedido compactado ficava a cerca de 200 tokens dos 50%: uma linha a mais no guia o deixava acima, e a compactação era dispensada.
 */
async function seedHistory(world: RunsWorld, conversationId: string, count = 3, chars = 7500): Promise<void> {
  await loadManagedContext(world.pool, conversationId);
  for (let index = 0; index < count; index += 1) {
    await world.pool.query("INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, created_at) VALUES ($1, 'user', 'text', 'done', true, $2, now())", [conversationId, `Histórico ${index}: ${'a'.repeat(chars)}`]);
  }
}

/** Um bot com a conversa pesada (histórico semeado e as quatro rodadas de `converse`, com g1 e g2 elegíveis ao mascaramento). */
async function heavyBot(world: RunsWorld, clock: Clock) {
  const bot = await world.createBot();
  const conversationId = await conversationOf(world, bot);
  await seedHistory(world, conversationId);
  await converse(world, clock, bot);
  return { bot, conversationId };
}

/** Uma sessão do Chat geral com sete rodadas de 4.000 caracteres: com o piso de cerca de 8 mil tokens o pedido fica em cerca de 36 mil tokens, entre os 50% e os 90% do orçamento. */
async function heavySession(world: RunsWorld, clock: Clock): Promise<SessionRef> {
  const ref = await openSession(world);
  for (let index = 0; index < 7; index += 1) {
    await say(world, ref, `Rodada ${index}: ${'a'.repeat(4000)}`);
    clock.advance(1);
  }
  return ref;
}

/** A manutenção de contexto SEM sessão do dono (a fria, migration 0048) de uma conversa, com o desfecho da execução e o recibo. */
interface ColdOperation {
  requestId: string; runId: string; runStatus: string; failureCode: string | null; outcome: string | null; errorCode: string | null;
  result: { changed: boolean; beforeInputTokens: number | null; afterInputTokens: number | null; summaryUsage: { calls: number } | null } | null;
}
const coldOperations = async (world: RunsWorld, conversationId: string): Promise<ColdOperation[]> => (await world.pool.query<ColdOperation>(
  `SELECT m.request_id AS "requestId", m.run_id::text AS "runId", r.status AS "runStatus", r.failure_code AS "failureCode", m.outcome, m.error_code AS "errorCode", m.result
   FROM context_maintenance m JOIN runs r ON r.id = m.run_id WHERE m.conversation_id = $1 AND m.session_id IS NULL ORDER BY m.run_id`, [conversationId])).rows;
/** Espera `count` compactações frias do worker terminadas: a execução fria sempre termina concluída para o dono, qualquer que seja o recibo. */
const settledCold = (world: RunsWorld, conversationId: string, count = 1): Promise<ColdOperation[]> =>
  waitFor('compactação fria terminada', async () => {
    const found = await coldOperations(world, conversationId);
    return found.length === count && found.every((operation) => operation.runStatus === 'completed') ? found : null;
  });

const checkpointOf = async (world: RunsWorld, conversationId: string) =>
  (await world.pool.query<{ revision: number; summary: string; covered: string[] }>('SELECT revision, summary, covered_message_ids::text[] AS covered FROM conversation_context WHERE conversation_id = $1', [conversationId])).rows[0]!;
const pushCount = async (world: RunsWorld): Promise<number> => Number((await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM push_events')).rows[0]!.total);
/** O dono viu tudo até agora: a bolinha de não lido nasce apagada, para a prova poder dizer que a manutenção fria não a acendeu. */
const markRead = (world: RunsWorld, conversationId: string) =>
  world.pool.query('UPDATE conversations SET read_through_message_id = (SELECT max(id) FROM messages WHERE conversation_id = $1) WHERE id = $1', [conversationId]);
const botFacts = async (world: RunsWorld, botId: string) => {
  const item = (await world.bots.list()).find((entry) => entry.id === botId)!;
  return { unread: item.unread, preview: item.preview, runState: item.runState };
};
const summaryText = 'Resumo de teste do histórico anterior.';

describe('compactação fria em segundo plano (A12, A13, C6)', () => {
  it('a conversa fria que continua em 50% ou mais depois do mascaramento recebe o checkpoint gravado pelo worker com o Modelo do resumo, sem cartão, push nem bolinha; a mensagem seguinte não chama resumo', async () => {
    const { world, clock, sweeper } = await scenario();
    await world.models.test('opencode/glm-5.3-flash');
    await world.pool.query('UPDATE app_settings SET summary_model = $1', ['opencode/glm-5.3-flash']);
    const script = watchSummaries(world);
    const { bot, conversationId } = await heavyBot(world, clock);
    const [g1, , g2] = await activities(world, conversationId) as [ActivityRow, ActivityRow, ActivityRow];

    // Premissas: a conversa quente ficou entre 50% e 90% do orçamento, então nenhum resumo foi pago enquanto ela estava em uso.
    const warm = await world.conversations.contextState(bot.id);
    expect(warm.measurement!.inputTokens).toBeGreaterThanOrEqual(COLD_COMPACTION_SHARE * BUDGET);
    expect(warm.measurement!.inputTokens).toBeLessThan(COMPACTION_THRESHOLD * BUDGET);
    expect(script.summaries).toHaveLength(0);
    await markRead(world, conversationId);
    const stored = await snapshot(world, conversationId);
    const pushes = await pushCount(world);
    const facts = await botFacts(world, bot.id);
    expect(facts.unread).toBe(false);

    // Esfria: o ciclo grava a limpeza (g1 e g2) e, depois dela, enfileira a compactação, que o motor executa.
    clock.set(after(await lastCall(world, conversationId), 41));
    expect(await sweeper.tickOnce()).toBe(1);
    const [operation] = await settledCold(world, conversationId);
    expect((await maskedRows(world)).map((mask) => mask.id)).toEqual([g1.id, g2.id]);

    // Um único resumo, no Modelo do resumo (não o da conversa), cobrindo o histórico antigo.
    expect(script.summaries).toHaveLength(1);
    expect(script.summaries[0]!.model).toBe('opencode/glm-5.3-flash');
    expect(script.summaries[0]!.turns.map((turn) => turn.text).join('\n')).toContain('Histórico 0:');
    // O recibo é de uma manutenção sem sessão do dono, concluída, com o resultado verdadeiro: o pedido já enxuto pelo mascaramento (antes do resumo) continuava em 50% ou mais, e depois dele ficou abaixo.
    expect(operation).toMatchObject({ runStatus: 'completed', failureCode: null, outcome: 'completed', errorCode: null, result: { changed: true, summaryUsage: { calls: 1 } } });
    expect(operation!.result!.beforeInputTokens!).toBeGreaterThanOrEqual(COLD_COMPACTION_SHARE * BUDGET);
    expect(operation!.result!.beforeInputTokens!).toBeLessThan(warm.measurement!.inputTokens - 3_000); // g1 e g2 (~4 mil caracteres) já tinham saído do pedido
    expect(operation!.result!.afterInputTokens!).toBeLessThan(COLD_COMPACTION_SHARE * BUDGET);
    expect((await world.pool.query('SELECT purpose, model, summary_outcome FROM model_call_usage WHERE run_id = $1', [operation!.runId])).rows).toEqual([{ purpose: 'summary', model: 'opencode/glm-5.3-flash', summary_outcome: 'applied' }]);
    const checkpoint = await checkpointOf(world, conversationId);
    expect(checkpoint.revision).toBe(1);
    expect(checkpoint.summary).toContain(summaryText);
    expect(checkpoint.covered.length).toBeGreaterThan(0);
    // A auditoria diz que foi o sistema, e por qual gatilho.
    const audited = (await world.pool.query<{ actor: string; outcome: string; details: Record<string, unknown> }>("SELECT actor, outcome, details FROM audit_log WHERE action = 'context.maintenance_requested' AND target = $1", [conversationId])).rows;
    expect(audited).toEqual([{ actor: 'system', outcome: 'success', details: { requestId: operation!.requestId, mode: 'summarize', trigger: 'cold' } }]);

    // Nada aparece: nenhuma mensagem nem cartão na conversa, nenhum push, a bolinha segue apagada, o bot não muda de aparência e o painel não mostra operação do dono.
    expect(await snapshot(world, conversationId)).toEqual(stored);
    expect(await pushCount(world)).toBe(pushes);
    expect(await botFacts(world, bot.id)).toEqual(facts);
    const state = await world.conversations.contextState(bot.id);
    expect(state.operation).toBeNull();
    expect(state.phase).toBe('ready');
    expect(state.measurement).toMatchObject({ stale: false, compaction: { elision: false, summary: false, index: false } });
    expect(state.measurement!.inputTokens).toBeLessThan(COLD_COMPACTION_SHARE * BUDGET);

    // C6: a próxima mensagem do dono usa o checkpoint (e a limpeza, que continua nos resultados do trecho final) e não espera resumo algum; a conversa leve de agora não é compactada de novo.
    const since = world.conversationRequests().length;
    await say(world, bot, 'depois da compactação fria');
    const requests = bodiesSince(world, since);
    expect(requests.filter(isSummaryBody)).toHaveLength(0);
    expect(script.summaries).toHaveLength(1);
    const [request] = requests as [ModelBody];
    expect(request.messages.filter((turn) => turn.role === 'user').some((turn) => (turn.content ?? '').includes('# Resumo derivado') && (turn.content ?? '').includes(summaryText))).toBe(true);
    const toolTexts = request.messages.filter((turn) => turn.role === 'tool').map((turn) => turn.content);
    expect(toolTexts).toContain(markerOf(g1));
    expect(toolTexts).toContain(markerOf(g2));
    // A conversa esfria de novo: a limpeza segue (g3 saiu das 2 rodadas recentes com a mensagem nova), mas nada é compactado outra vez (a medição está em dia e abaixo de 50%).
    clock.advance(41);
    expect(await sweeper.tickOnce()).toBe(1);
    expect((await maskedRows(world)).map((mask) => mask.id)).toHaveLength(3);
    expect(await coldOperations(world, conversationId)).toHaveLength(1);
    expect(script.summaries).toHaveLength(1);
  }, 60_000);

  it('a mensagem do dono enviada durante a compactação espera na fila (não vira complemento), prepara o pedido com o checkpoint novo e não dispara outro resumo; a seguinte também não (A13, C6)', async () => {
    const { world, clock, sweeper } = await scenario();
    let release = (): void => undefined;
    const script = watchSummaries(world, { hold: new Promise<void>((resolve) => { release = resolve; }) });
    const { bot, conversationId } = await heavyBot(world, clock);
    clock.set(after(await lastCall(world, conversationId), 41));
    await sweeper.tickOnce();
    await waitFor('resumo frio em andamento', async () => script.summaries.length === 1);
    const [operation] = await coldOperations(world, conversationId);
    expect((await world.runRow(operation!.runId)).status).toBe('running');

    // Durante a compactação: a mensagem entra na fila atrás dela (a manutenção não é uma execução "ativa" para o complemento), e a conversa ainda não mudou.
    const sent = await world.conversations.send(bot.id, 'mensagem durante a compactação');
    expect(sent.kind).toBe('run');
    expect(await world.runRow(sent.id)).toMatchObject({ status: 'queued' });
    expect((await world.pool.query('SELECT 1 FROM complements')).rowCount).toBe(0);
    expect(await checkpointOf(world, conversationId)).toMatchObject({ revision: 0, summary: '' });

    // O resumo pago termina e é aplicado (nunca descartado); só então a execução do dono começa, e o pedido dela já traz o checkpoint.
    const since = world.conversationRequests().length;
    release();
    await world.waitForStatus(operation!.runId, 'completed');
    await world.waitForStatus(sent.id, 'completed');
    expect((await checkpointOf(world, conversationId)).summary).toContain(summaryText);
    const owner = bodiesSince(world, since).filter((body) => !isSummaryBody(body));
    expect(owner).toHaveLength(1);
    expect(owner[0]!.messages.filter((turn) => turn.role === 'user').some((turn) => (turn.content ?? '').includes('# Resumo derivado') && (turn.content ?? '').includes(summaryText))).toBe(true);
    expect(script.summaries).toHaveLength(1);

    // C6: a mensagem seguinte não paga resumo.
    await say(world, bot, 'e a seguinte');
    expect(script.summaries).toHaveLength(1);
    expect(Number((await world.pool.query<{ total: string }>("SELECT count(*) AS total FROM model_call_usage WHERE conversation_id = $1 AND purpose = 'summary'", [conversationId])).rows[0]!.total)).toBe(1);
  }, 60_000);

  it('se o resumo passa do limite de tempo da execução, a chamada incerta não é repetida, a execução termina concluída e a mensagem que esperava na fila roda (o dono espera no máximo o limite de hoje)', async () => {
    const { world, clock, sweeper } = await scenario();
    let release = (): void => undefined;
    const script = watchSummaries(world, { hold: new Promise<void>((resolve) => { release = resolve; }) });
    const { bot, conversationId } = await heavyBot(world, clock);
    // Motor com o limite de tempo curto só para a compactação: o resumo fica preso e o prazo da execução o interrompe.
    await world.engine.stop();
    const short = world.createEngine({ maxActiveMs: 800 });
    extraEngines.push(short);
    short.start();
    clock.set(after(await lastCall(world, conversationId), 41));
    await sweeper.tickOnce();
    await waitFor('resumo frio em andamento', async () => script.summaries.length === 1);
    const sent = await world.conversations.send(bot.id, 'mensagem durante a compactação');
    expect(sent.kind).toBe('run');

    const [timedOut] = await settledCold(world, conversationId);
    expect(timedOut).toMatchObject({ runStatus: 'completed', failureCode: null, outcome: 'failed', errorCode: 'CONTEXT_COMPACTION_FAILED' });
    expect((await world.pool.query('SELECT state FROM model_call_usage WHERE run_id = $1', [timedOut!.runId])).rows).toEqual([{ state: 'unknown' }]); // chamada paga incerta: nunca repetida
    expect(await checkpointOf(world, conversationId)).toMatchObject({ revision: 0, summary: '' });
    release();
    await world.waitForStatus(sent.id, 'completed'); // a mensagem esperou na fila só até o fim da execução fria e depois rodou normal
    expect(script.summaries).toHaveLength(1);
  }, 60_000);

  it('se o mascaramento tira o pedido de baixo de 50%, a execução fria mede de novo e encerra sem chamar o modelo, a medição fica em dia e a passagem seguinte não enfileira nada', async () => {
    const { world, clock, sweeper } = await scenario();
    const script = watchSummaries(world);
    const bot = await world.createBot();
    const conversationId = await conversationOf(world, bot);
    // Cada resultado "h" tem cerca de 7.900 caracteres e o piso do pedido cerca de 8 mil tokens: no fim das quatro rodadas o pedido tem cerca de 35 mil tokens (medido: 34.751, entre os 50% e os
    // 90% do orçamento de 47.104, sem disparar resumo a quente). h1 e h2 saem do grupo das 2 rodadas recentes e são mascarados, e a conversa cai para cerca de 19 mil tokens (medido: 19.123,
    // abaixo de 50%); h3 e a 4ª rodada ficam inteiras.
    for (const text of ['[pesquisar:h1] primeira', '[pesquisar:h2] segunda', '[pesquisar:h3] terceira', 'quarta']) {
      await say(world, bot, text);
      clock.advance(1);
    }
    const warm = await world.conversations.contextState(bot.id);
    expect(warm.measurement!.inputTokens).toBeGreaterThanOrEqual(COLD_COMPACTION_SHARE * BUDGET);
    expect(warm.measurement!.inputTokens).toBeLessThan(COMPACTION_THRESHOLD * BUDGET);

    clock.set(after(await lastCall(world, conversationId), 41));
    expect(await sweeper.tickOnce()).toBe(1);
    expect(await maskedRows(world)).toHaveLength(2);
    const [operation] = await settledCold(world, conversationId);
    expect(operation).toMatchObject({ outcome: 'completed', errorCode: null, result: { changed: false, summaryUsage: { calls: 0 } } });
    expect(operation!.result!.beforeInputTokens!).toBeLessThan(COLD_COMPACTION_SHARE * BUDGET); // depois do mascaramento já estava abaixo de 50%
    expect(script.summaries).toHaveLength(0);
    expect(await checkpointOf(world, conversationId)).toMatchObject({ revision: 0, summary: '' });
    expect((await world.pool.query('SELECT 1 FROM model_call_usage WHERE run_id = $1', [operation!.runId])).rowCount).toBe(0);
    // A execução mediu o pedido enxuto: o painel fica em dia, e a passagem seguinte nem enfileira.
    const state = await world.conversations.contextState(bot.id);
    expect(state.measurement).toMatchObject({ stale: false });
    expect(state.measurement!.inputTokens).toBeLessThan(COLD_COMPACTION_SHARE * BUDGET);
    clock.advance(41);
    expect(await sweeper.tickOnce()).toBe(0);
    expect(await coldOperations(world, conversationId)).toHaveLength(1);
  }, 60_000);

  it('a falha do resumo não muda a conversa nem derruba execução, e a recusa registrada não gera nova chamada em outra passagem sobre o mesmo conjunto', async () => {
    const { world, clock, sweeper } = await scenario();
    const script = watchSummaries(world, { mode: 'empty' });
    const { bot, conversationId } = await heavyBot(world, clock);
    const stored = await snapshot(world, conversationId);
    const pushes = await pushCount(world);
    const cold = after(await lastCall(world, conversationId), 41);
    clock.set(cold);
    expect(await sweeper.tickOnce()).toBe(1);
    const [failed] = await settledCold(world, conversationId);
    // A execução fria termina concluída para o dono (um `failed` sujaria o estado do bot); a verdade fica só no recibo.
    expect(failed).toMatchObject({ runStatus: 'completed', failureCode: null, outcome: 'failed', errorCode: 'CONTEXT_COMPACTION_FAILED' });
    const calls = script.summaries.length;
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(await checkpointOf(world, conversationId)).toMatchObject({ revision: 0, summary: '' });
    expect(await snapshot(world, conversationId)).toEqual(stored);
    expect(await pushCount(world)).toBe(pushes);
    expect((await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM context_summary_refusals WHERE conversation_id = $1', [conversationId])).rows[0]!.total).toBe('1');
    expect((await botFacts(world, bot.id)).runState).not.toBe('error');
    const state = await world.conversations.contextState(bot.id);
    expect(state.operation).toBeNull(); // nenhuma falha mostrada ao dono
    expect(state.phase).toBe('ready');

    // Mesma revisão (nada mudou) e a conversa fria de novo: a passagem não repete a tentativa que falhou (idempotência por revisão) e desiste em silêncio, sem esbarrar no índice único da execução.
    const errors = vi.spyOn(world.logger, 'error');
    clock.set(after(cold, 41));
    expect(await sweeper.tickOnce()).toBe(0);
    expect(await coldOperations(world, conversationId)).toHaveLength(1);
    expect(script.summaries).toHaveLength(calls);
    expect(errors).not.toHaveBeenCalled();

    // Outra passagem sobre o MESMO conjunto: outra revisão (o dono editou as instruções do bot, o que não muda nenhuma linha coberta). A recusa registrada vale: nenhuma chamada.
    await world.pool.query("UPDATE bots SET instructions = 'Responda com objetividade.' WHERE id = $1", [bot.id]);
    await sweeper.tickOnce();
    const [, second] = await settledCold(world, conversationId, 2);
    expect(second).toMatchObject({ runStatus: 'completed', outcome: 'completed', result: { changed: false, summaryUsage: { calls: 0 } } });
    expect(script.summaries).toHaveLength(calls);

    // A falha nunca derrubou execução: a mensagem seguinte do dono roda normal, e o pedido segue como sempre (abaixo de 90%, sem resumo).
    const run = await say(world, bot, 'depois da falha');
    expect(await world.runRow(run)).toMatchObject({ status: 'completed', failure_code: null });
    expect(script.summaries).toHaveLength(calls);
  }, 60_000);

  it('se o contexto mudou entre o enfileiramento e a execução, a compactação fria encerra sem efeito e sem chamar o modelo; a passagem seguinte decide pela revisão nova', async () => {
    const { world, clock, sweeper } = await scenario();
    const script = watchSummaries(world);
    const { bot, conversationId } = await heavyBot(world, clock);
    await world.engine.stop(); // nada executa: a compactação fica na fila enquanto o contexto muda
    clock.set(after(await lastCall(world, conversationId), 41));
    await sweeper.tickOnce();
    const [queued] = await coldOperations(world, conversationId);
    expect(queued).toMatchObject({ runStatus: 'queued', outcome: null });
    expect(queued!.requestId).toBe(coldRequestId(conversationId, await readContextRevision(world.pool, conversationId))); // a identidade é a da revisão em que foi enfileirada
    await world.pool.query("UPDATE bots SET instructions = 'Mudou depois de enfileirar.' WHERE id = $1", [bot.id]);
    expect(queued!.requestId).not.toBe(coldRequestId(conversationId, await readContextRevision(world.pool, conversationId)));

    const resumed = world.createEngine();
    extraEngines.push(resumed);
    resumed.start();
    await world.waitForStatus(queued!.runId, 'completed');
    expect(script.summaries).toHaveLength(0);
    expect((await coldOperations(world, conversationId))[0]).toMatchObject({ outcome: 'completed', errorCode: null, result: null });
    expect(await checkpointOf(world, conversationId)).toMatchObject({ revision: 0, summary: '' });

    // A conversa continua fria e a revisão agora é outra: a próxima passagem decide de novo, e desta vez compacta.
    await sweeper.tickOnce();
    const [, second] = await settledCold(world, conversationId, 2);
    expect(second).toMatchObject({ outcome: 'completed', result: { changed: true, summaryUsage: { calls: 1 } } });
    expect(script.summaries).toHaveLength(1);
  }, 60_000);

  it('só enfileira com o que o resumo pago exige (chave, modelo validado, bot ativo) e uma única vez por revisão do contexto', async () => {
    const { world, clock } = await scenario();
    watchSummaries(world);
    const { bot, conversationId } = await heavyBot(world, clock);
    await world.engine.stop(); // nada executa: o que importa aqui é o que entra na fila
    const cold = after(await lastCall(world, conversationId), 41);
    clock.set(cold);
    const enqueue = (): Promise<boolean> => enqueueColdCompaction(world.pool, { conversationId, now: cold, logger: world.logger });

    await world.credentials.disconnect('provider', ORIGIN);
    expect(await enqueue()).toBe(false); // sem a chave do provedor
    await world.credentials.save('provider', 'valid-key-1111', ORIGIN);
    await world.pool.query('UPDATE bots SET archived_at = now() WHERE id = $1', [bot.id]);
    expect(await enqueue()).toBe(false); // bot arquivado
    await world.pool.query('UPDATE bots SET archived_at = NULL WHERE id = $1', [bot.id]);
    const protocol = (await world.pool.query<{ test_protocol: string }>("SELECT test_protocol FROM model_profiles WHERE model_id = 'opencode/glm-5.1'")).rows[0]!.test_protocol;
    await world.pool.query("UPDATE model_profiles SET test_protocol = NULL WHERE model_id = 'opencode/glm-5.1'");
    expect(await enqueue()).toBe(false); // modelo sem protocolo validado
    await world.pool.query("UPDATE model_profiles SET test_protocol = $1 WHERE model_id = 'opencode/glm-5.1'", [protocol]);
    expect(await coldOperations(world, conversationId)).toEqual([]);
    expect((await world.pool.query('SELECT 1 FROM runs WHERE context_operation_id IS NOT NULL')).rowCount).toBe(0);

    // Com tudo em ordem enfileira, e só uma vez por revisão: a segunda chamada (a execução fria na fila já impede a conversa de ser fria) e a de outra revisão também não enfileiram.
    expect(await enqueue()).toBe(true);
    expect(await enqueue()).toBe(false);
    const [operation] = await coldOperations(world, conversationId);
    expect(operation).toMatchObject({ runStatus: 'queued', outcome: null });
    expect(operation!.requestId).toBe(coldRequestId(conversationId, await readContextRevision(world.pool, conversationId)));
    await world.pool.query("UPDATE bots SET instructions = 'Outra revisão.' WHERE id = $1", [bot.id]);
    expect(await enqueue()).toBe(false);
    expect(await coldOperations(world, conversationId)).toHaveLength(1);
  }, 60_000);

  it('com a conversa quente ou leve nada é enfileirado, mesmo passando de T com resultados a mascarar', async () => {
    const { world, clock, sweeper } = await scenario();
    const script = watchSummaries(world);
    const heavy = await heavyBot(world, clock);
    const light = await world.createBot();
    const lightId = await conversationOf(world, light);
    await converse(world, clock, light); // cerca de 8 mil tokens: bem abaixo dos 50%
    const last = new Date(Math.max((await lastCall(world, heavy.conversationId)).getTime(), (await lastCall(world, lightId)).getTime()));
    expect((await world.conversations.contextState(light.id)).measurement!.inputTokens).toBeLessThan(COLD_COMPACTION_SHARE * BUDGET);

    // Quente: dentro de T e em exatamente T (a frieza é "há MAIS de T") para a conversa que parou primeiro; a outra, que parou depois, está ainda mais quente.
    const first = new Date(Math.min((await lastCall(world, heavy.conversationId)).getTime(), (await lastCall(world, lightId)).getTime()));
    for (const instant of [after(first, 5), new Date(first.getTime() + COLD_AFTER_MS)]) {
      clock.set(instant);
      expect(await sweeper.tickOnce()).toBe(0);
    }
    expect((await world.pool.query('SELECT 1 FROM context_maintenance')).rowCount).toBe(0);
    // Fria: a pesada é compactada; a leve só recebe a limpeza e continua sem manutenção.
    clock.set(after(last, 41));
    expect(await sweeper.tickOnce()).toBe(2);
    await settledCold(world, heavy.conversationId);
    expect(await coldOperations(world, lightId)).toEqual([]);
    expect(script.summaries).toHaveLength(1);
  }, 60_000);

  it('enquanto roda a compactação fria é invisível no painel (sem operação, sem fase, motivo genérico), o dono não a alcança pelo id dela e o cancelamento dele não a para; o resumo pago é aplicado', async () => {
    const { world, clock, sweeper } = await scenario();
    let release = (): void => undefined;
    const script = watchSummaries(world, { hold: new Promise<void>((resolve) => { release = resolve; }) });
    const { bot, conversationId } = await heavyBot(world, clock);
    clock.set(after(await lastCall(world, conversationId), 41));
    await sweeper.tickOnce();
    await waitFor('resumo frio em andamento', async () => script.summaries.length === 1);
    const [operation] = await coldOperations(world, conversationId);
    expect((await world.runRow(operation!.runId)).status).toBe('running');

    // Invisível (decisão 22): nenhuma operação do dono, nenhuma fase `summarizing` e o motivo é o genérico de execução aberta, que também desabilita "Compactar agora".
    const generic = 'Há trabalho na fila ou em execução.';
    const state = await world.conversations.contextState(bot.id);
    expect(state.operation).toBeNull();
    expect(state.phase).toBe('ready');
    expect(state.eligibility).toMatchObject({ enabled: false, reason: generic, summarizeEnabled: false, summarizeReason: generic });
    // O id da fria não é de nenhum pedido do dono: cancelar responde NOT_FOUND, repetir como pedido dele é conflito, e a execução segue sem parada pedida.
    await expect(world.conversations.cancelContextMaintenance(bot.id, operation!.requestId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(world.conversations.maintainContext(bot.id, { requestId: operation!.requestId, mode: 'summarize', expectedRevision: state.revision }, randomUUID())).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
    expect((await world.pool.query('SELECT stop_requested_at FROM runs WHERE id = $1', [operation!.runId])).rows).toEqual([{ stop_requested_at: null }]);

    release();
    const [done] = await settledCold(world, conversationId);
    expect(done).toMatchObject({ outcome: 'completed', result: { changed: true, summaryUsage: { calls: 1 } } });
    expect((await checkpointOf(world, conversationId)).summary).toContain(summaryText);
    expect((await world.conversations.contextState(bot.id)).operation).toBeNull();
  }, 60_000);

  it('a parada do dono sem runId, e com o id da fria, enquanto a compactação fria roda não a alcança: responde RUN_NOT_ACTIVE, o resumo pago é aplicado e a mesma revisão não paga de novo (spec, decisão 20: o resumo pago nunca é descartado)', async () => {
    const { world, clock, sweeper } = await scenario();
    const stops: unknown[] = [];
    const hooks = { stop: async (): Promise<void> => undefined };
    const script = watchSummaries(world, { afterPaid: () => hooks.stop() });
    const { bot, conversationId } = await heavyBot(world, clock);
    // As duas formas de parada chegam quando o provedor já respondeu e informou o uso, e o motor ainda não gravou o checkpoint: o instante em que a parada descartava o resumo pago. A fria
    // não é do dono (ele nem a vê), então nenhuma das duas a alcança, nem pelo id dela (a gravação do checkpoint confere a parada sob a posse, na mesma transação, e não encontra nenhuma).
    hooks.stop = async () => {
      const [cold] = await coldOperations(world, conversationId);
      for (const runId of [undefined, cold!.runId]) stops.push(await world.conversations.stop(bot.id, runId).then(() => 'stopped', (error: { code?: string }) => error.code));
    };
    const stored = await snapshot(world, conversationId);
    clock.set(after(await lastCall(world, conversationId), 41));
    await sweeper.tickOnce();
    const [operation] = await settledCold(world, conversationId);

    expect(stops).toEqual(['RUN_NOT_ACTIVE', 'RUN_NOT_ACTIVE']);
    expect((await world.pool.query('SELECT stop_requested_at FROM runs WHERE id = $1', [operation!.runId])).rows).toEqual([{ stop_requested_at: null }]);
    // O resumo pago foi aplicado: execução concluída, recibo concluído, checkpoint gravado e o custo no ledger como chamada aplicada.
    expect(script.summaries).toHaveLength(1);
    expect(operation).toMatchObject({ runStatus: 'completed', failureCode: null, outcome: 'completed', errorCode: null, result: { changed: true, summaryUsage: { calls: 1 } } });
    const checkpoint = await checkpointOf(world, conversationId);
    expect(checkpoint.revision).toBe(1);
    expect(checkpoint.summary).toContain(summaryText);
    expect((await world.pool.query('SELECT purpose, state, summary_outcome FROM model_call_usage WHERE run_id = $1', [operation!.runId])).rows).toEqual([{ purpose: 'summary', state: 'completed', summary_outcome: 'applied' }]);
    expect(await snapshot(world, conversationId)).toEqual(stored);
    expect((await world.conversations.contextState(bot.id)).operation).toBeNull();

    // A mesma revisão não paga outro resumo (o recibo da tentativa existe), e a conversa segue normal para o dono.
    const errors = vi.spyOn(world.logger, 'error');
    hooks.stop = async () => undefined;
    clock.advance(41);
    await sweeper.tickOnce();
    expect(await coldOperations(world, conversationId)).toHaveLength(1);
    expect(script.summaries).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    await say(world, bot, 'depois da parada');
    expect(script.summaries).toHaveLength(1);
  }, 60_000);

  it('no Chat geral a compactação fria vale para o caminho ativo da sessão, sem nada a mascarar', async () => {
    const { world, clock, sweeper } = await scenario();
    const script = watchSummaries(world);
    const ref = await openSession(world);
    const conversationId = ref.sessionId;
    // Sete rodadas de 4.000 caracteres: com o piso de cerca de 8 mil tokens o pedido fica em cerca de 36 mil tokens, entre os 50% e os 90% do orçamento.
    for (let index = 0; index < 7; index += 1) {
      await say(world, ref, `Rodada ${index}: ${'a'.repeat(4000)}`);
      clock.advance(1);
    }
    const warm = await world.conversations.contextState(ref);
    expect(warm.measurement!.inputTokens).toBeGreaterThanOrEqual(COLD_COMPACTION_SHARE * BUDGET);
    expect(warm.measurement!.inputTokens).toBeLessThan(COMPACTION_THRESHOLD * BUDGET);

    clock.set(after(await lastCall(world, conversationId), 41));
    expect(await sweeper.tickOnce()).toBe(0); // nenhum resultado de ferramenta a mascarar
    const [operation] = await settledCold(world, conversationId);
    expect(operation).toMatchObject({ outcome: 'completed', result: { changed: true, summaryUsage: { calls: 1 } } });
    expect(script.summaries).toHaveLength(1);
    expect(await checkpointOf(world, conversationId)).toMatchObject({ revision: 1 });
    expect((await world.conversations.contextState(ref)).operation).toBeNull();

    const since = world.conversationRequests().length;
    await say(world, ref, 'depois da compactação fria');
    const requests = bodiesSince(world, since);
    expect(requests.filter(isSummaryBody)).toHaveLength(0);
    expect((requests[0] as ModelBody).messages.filter((turn) => turn.role === 'user').some((turn) => (turn.content ?? '').includes('# Resumo derivado'))).toBe(true);
    expect(script.summaries).toHaveLength(1);
  }, 60_000);
});

describe('trava da fila na compactação fria (concorrência)', () => {
  it.each(['bot', 'sessão'] as const)('%s: com uma transação segurando a trava de queueRun a compactação fria desiste sem enfileirar; solta a trava, a passagem seguinte enfileira', async (kind) => {
    const { world, clock, sweeper } = await scenario();
    watchSummaries(world);
    const target = kind === 'bot' ? (await heavyBot(world, clock)).bot : await heavySession(world, clock);
    const conversationId = await conversationOf(world, target);
    await world.engine.stop(); // nada executa: o que importa é o que entra na fila
    const cold = after(await lastCall(world, conversationId), 41);
    clock.set(cold);
    const enqueue = (): Promise<boolean> => enqueueColdCompaction(world.pool, { conversationId, now: cold, logger: world.logger });

    const holder = await world.pool.connect();
    try {
      // Um envio em andamento: a mesma trava e inserção de `queueRun`, ainda sem commit (a execução enfileirada não existe para quem lê de fora, então a conversa ainda parece fria).
      await holder.query('BEGIN');
      await queueRun(holder, { botId: 'sessionId' in target ? null : target.id, conversationId, input: 'envio em andamento', at: cold, enforceLimit: true });
      expect(await enqueue()).toBe(false);
      await sweeper.tickOnce();
      expect(await coldOperations(world, conversationId)).toEqual([]);
      expect(await maskedRows(world)).toEqual([]);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    // Trava solta: a passagem seguinte grava a limpeza (só o bot tem resultado a mascarar) e enfileira a compactação.
    await sweeper.tickOnce();
    expect(await coldOperations(world, conversationId)).toHaveLength(1);
    expect(await maskedRows(world)).toHaveLength(kind === 'bot' ? 2 : 0);
  }, 60_000);
});

describe('gatilho e abertura da compactação fria (phase 15, passo 8a; decisões 2 e 13)', () => {
  it('o gatilho é de 40 mil tokens, limitado a 50% do orçamento (janela de 64k continua em 23.552), e a abertura procurada é de 30 mil, menos o piso e o checkpoint', () => {
    expect(COLD_TRIGGER_TOKENS).toBe(40_000);
    expect(COLD_OPENING_TOKENS).toBe(30_000);
    expect(coldTriggerTokens(contextEnvelope(65_536, MAX_OUTPUT_TOKENS).inputBudget)).toBe(COLD_COMPACTION_SHARE * 47_104);
    expect(coldTriggerTokens(contextEnvelope(131_072, MAX_OUTPUT_TOKENS).inputBudget)).toBe(40_000);
    expect(coldTriggerTokens(contextEnvelope(262_144, MAX_OUTPUT_TOKENS).inputBudget)).toBe(40_000);
    expect(coldTailTokens(12_000, 1_500)).toBe(16_500);
    expect(coldTailTokens(29_000, 4_000)).toBe(0); // piso grande: só ficam as mensagens que o corte sempre protege
  });

  it('phase-15:A8: na janela padrão a conversa fria de 55 mil tokens (abaixo dos 50% de 113 mil) é compactada, o pedido volta para menos de 30 mil e a mensagem seguinte usa o checkpoint e mantém a última mensagem do dono', async () => {
    const { world, clock, sweeper } = await scenario({ contextWindow: 'product' });
    await world.models.test('opencode/glm-5.3-flash');
    await world.pool.query('UPDATE app_settings SET summary_model = $1', ['opencode/glm-5.3-flash']);
    const script = watchSummaries(world);
    const bot = await world.createBot();
    const conversationId = await conversationOf(world, bot);
    await seedHistory(world, conversationId, 5);
    await converse(world, clock, bot);
    const budget = contextEnvelope(262_144, MAX_OUTPUT_TOKENS).inputBudget;
    const warm = await world.conversations.contextState(bot.id);
    // Premissas: a conversa quente está entre o gatilho novo e os 50% do orçamento, onde antes nada acontecia.
    expect(warm.measurement!.inputBudget).toBe(budget);
    expect(warm.measurement!.inputTokens).toBeGreaterThanOrEqual(COLD_TRIGGER_TOKENS);
    expect(warm.measurement!.inputTokens).toBeLessThan(COLD_COMPACTION_SHARE * budget);

    clock.set(after(await lastCall(world, conversationId), 41));
    await sweeper.tickOnce();
    const [operation] = await settledCold(world, conversationId);
    expect(script.summaries).toHaveLength(1);
    expect(operation).toMatchObject({ runStatus: 'completed', outcome: 'completed', result: { changed: true } });
    expect(operation!.result!.beforeInputTokens!).toBeGreaterThanOrEqual(COLD_TRIGGER_TOKENS);
    expect(operation!.result!.afterInputTokens!).toBeLessThan(COLD_OPENING_TOKENS);
    expect((await checkpointOf(world, conversationId)).covered.length).toBeGreaterThan(0);

    const since = world.conversationRequests().length;
    await say(world, bot, 'depois da compactação fria');
    const requests = bodiesSince(world, since);
    expect(requests.filter(isSummaryBody)).toHaveLength(0);
    const users = (requests[0] as ModelBody).messages.filter((turn) => turn.role === 'user').map((turn) => turn.content ?? '');
    expect(users.some((text) => text.includes('# Resumo derivado'))).toBe(true);
    expect(users.some((text) => text.includes('quarta'))).toBe(true); // a mensagem do dono da rodada mais recente não virou só resumo
  }, 90_000);
});

// A lista das "mais usadas" do bot é recalculada quando a conversa esfria (phase 15, passo 12, correção do checkpoint 2; decisão 24, A42 e A43). O instante do recálculo é a execução que encontrou a conversa fria,
// lido do que está gravado (`readMostUsedAnchor`), e não do laço do worker nem da limpeza: com ou sem limpeza gravada antes, pelo laço ou pela abertura, a lista é a mesma.
describe('a lista das mais usadas na conversa fria é a mesma pelo laço do worker e pela abertura da execução (A42, A14)', () => {
  /** Nomes das ferramentas do corpo (chat/completions) de um pedido. */
  const toolNamesOf = (body: ModelBody): string[] => (body.tools as { function: { name: string } }[] | undefined ?? []).map((tool) => tool.function.name);
  const PORTS = ['abrir_grupo', 'use_tool', 'read_activity'];

  it('a conversa quente publica só as portas por mais uso que haja; esfriada, o laço grava a limpeza e a mensagem traz a lista do uso, e a abertura da execução sozinha traz exatamente a mesma', async () => {
    const { world, clock } = await scenario({ coreCatalog: true });
    const swept = await world.createBot();
    const opened = await world.createBot();
    const sweptId = await conversationOf(world, swept);
    const openedId = await conversationOf(world, opened);
    const since = world.conversationRequests().length;
    await converse(world, clock, swept);
    await converse(world, clock, opened);
    // Quente: `search_history` foi usada quatro vezes em cada conversa e a lista não se mexeu em nenhum pedido (A43); o bot sem ferramenta usada na lista padrão publica só as portas.
    for (const body of bodiesSince(world, since)) expect(toolNamesOf(body)).toEqual(PORTS);

    clock.advance(180);
    // Uma conversa passa pelo laço do worker antes da mensagem (a limpeza fica gravada), a outra só pela rede de segurança da abertura.
    expect(await maskColdResults(world.pool, { conversationId: sweptId, now: clock.now(), origin: 'sweep', logger: world.logger })).toBeGreaterThan(0);
    const sweptFrom = world.conversationRequests().length;
    await say(world, swept, 'depois do laço');
    const openedFrom = world.conversationRequests().length;
    await say(world, opened, 'direto na abertura');
    const [sweptBody] = bodiesSince(world, sweptFrom);
    const [openedBody] = bodiesSince(world, openedFrom);
    // As duas ficaram com a limpeza gravada (uma pelo laço, a outra pela abertura) e a lista nasceu do uso, igual nas duas.
    for (const conversationId of [sweptId, openedId]) expect((await world.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM context_cold_masks WHERE conversation_id = $1', [conversationId])).rows[0]!.n).toBeGreaterThan(0);
    expect(toolNamesOf(sweptBody!)).toEqual([...PORTS, 'search_history']);
    expect(toolNamesOf(openedBody!)).toEqual(toolNamesOf(sweptBody!));
    expect(JSON.stringify(openedBody!.tools)).toBe(JSON.stringify(sweptBody!.tools));
  }, 90_000);
});
