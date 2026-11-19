// Configuração alterada no meio da preparação da etapa (phase 9, T9, A15): provas no motor real (PostgreSQL embarcado, fila, executor e o provedor falso, só a resposta do
// modelo é roteirizada). O dono mexe na configuração NO MEIO da preparação (uma consulta do banco é interceptada e a troca acontece antes dela seguir), e cada jornada
// confere o desfecho pelo que vai ao provedor e pelo código gravado na execução:
//   modelo trocado     a etapa prepara de novo UMA vez e a chamada vai ao modelo vigente, também pela recarga que a recusa de contexto do provedor pede (sem recarga forçada
//                      para o modelo que já não é o da conversa);
//   janela trocada     o pedido é dimensionado de novo para a janela vigente (a medição gravada é a dela);
//   segunda troca      na mesma etapa encerra com `CONTEXT_CONFIGURATION_CHANGED`: sem laço, sem chamada ao provedor, com a mensagem segura do registro;
//   resumo em curso   janela ou effort trocados durante a chamada paga de resumo: o resumo pronto é descartado e a etapa prepara de novo em vez de falhar;
//   compactação manual o "Compactar agora" também prepara de novo e resume com o modelo vigente;
//   evidência ausente  encerra com `CONTEXT_EVIDENCE_UNAVAILABLE` (a guarda é defensiva: `loadContext` sempre define as fontes, então o teste simula a falta); fonte
//                      removida ou revogada depois da preparação (`reserveModelSources`, `TextWriter`) usa o mesmo código, inclusive no "Compactar agora" (`context_maintenance.error_code`).
// Nenhum caminho emite `CONTEXT_COMPACTION_FAILED`, que fica restrito à compactação (provas em `compaction.test.ts`).
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, contextFailureMessage } from '@aion/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocService } from '../docs';
import { DomainError } from '../errors';
import { ChatRejected, type ChatEvent } from '../models/chat-protocols';
import { SUMMARY_SECTIONS } from './compaction';
import * as checkpoints from './context-checkpoint';
import * as evidenceProvenance from './evidence-provenance';
import { createRunsWorld, type RunsWorld } from './test-support';

afterEach(() => { vi.restoreAllMocks(); });

/** Janela de 64k fixada pelas provas (a menor opção desde a phase 11); a troca de janela vai para 128k. */
const WINDOW = 65536;
const NEXT_WINDOW = 131072;
/** Primeira leitura do perfil do modelo (`RunExecutor.modelProfile`): acontece uma vez por preparação, logo DEPOIS de a etapa resolver o modelo da conversa. */
const PROFILE_READ = 'SELECT test_status, test_protocol, effort_levels, accepts_images FROM model_profiles';
/** Leitura da janela vigente: `loadContext` a lê para a configuração da preparação e `modelStep` de novo ao dimensionar o pedido. */
const WINDOW_READ = 'SELECT c.bot_id, b.context_window_tokens FROM conversations c';

/** Mundo com dois modelos testados (`opencode/glm-5.1` por chat/completions e `opencode/kimi-k2.7-code` por messages), antes de o provedor ser roteirizado. */
async function newWorld(contextWindow?: typeof WINDOW): Promise<RunsWorld> {
  const world = await createRunsWorld(contextWindow ? { contextWindow } : {});
  await world.models.test('opencode/glm-5.1');
  await world.models.test('opencode/kimi-k2.7-code');
  return world;
}

/** O que chegou ao provedor: o modelo, o protocolo e se era a chamada de resumo (e não a principal), na ordem. */
interface Sent { model: string; protocol: string; summary: boolean }

/** Checkpoint válido (as sete seções) que o modelo falso devolve ao resumir. */
const CHECKPOINT = SUMMARY_SECTIONS.map((title, index) => `## ${title}\n${index === 0 ? 'RESUMO_DE_TESTE' : 'Nada.'}`).join('\n\n');

/**
 * Provedor roteirizado: responde um texto curto a cada chamada principal e um checkpoint válido a cada resumo. `beforeAnswer` roda quando a chamada de índice `index`
 * chega e pode lançar (a recusa de contexto, por exemplo), simulando o dono mexendo ou o provedor recusando naquele instante.
 */
function scriptProvider(world: RunsWorld, beforeAnswer?: (index: number) => Promise<void>): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, protocol, request): AsyncGenerator<ChatEvent> {
    const index = sent.length;
    const summary = request.turns[0]?.role === 'system' && request.turns[0].text.startsWith('Você produz o checkpoint do histórico');
    sent.push({ model: request.model, protocol, summary });
    await beforeAnswer?.(index);
    yield { type: 'text', text: summary ? CHECKPOINT : 'Concluído.' };
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: summary ? 200 : 5 } };
    yield { type: 'done', reason: 'stop' };
  });
  return sent;
}

/**
 * O dono mexendo no meio da preparação: `plans[n]` roda quando a n-ésima consulta que contém `match` chega ao banco, e a consulta só segue depois da troca. Só o `pool`
 * do executor é interceptado (as transações dele não passam por aqui), e `restore` devolve o original.
 */
function interleave(world: RunsWorld, match: string, plans: Record<number, () => Promise<unknown>>): { hits: () => number; restore: () => void } {
  const original = world.pool.query.bind(world.pool) as unknown;
  let hits = 0;
  world.pool.query = (async (sql: unknown, values?: unknown) => {
    if (typeof sql === 'string' && sql.includes(match)) {
      hits += 1;
      await plans[hits]?.();
    }
    return (original as (sql: unknown, values?: unknown) => Promise<unknown>)(sql, values);
  }) as unknown as typeof world.pool.query;
  return { hits: () => hits, restore: () => { world.pool.query = original as typeof world.pool.query; } };
}

/**
 * Histórico antigo semeado direto no banco: `count` mensagens do dono de `chars` caracteres, cada uma sua própria unidade. A cobertura nasce ANTES do histórico para a
 * conversa começar do zero (a primeira cobertura de uma conversa que já tem mensagens herda só as últimas cinco rodadas, `loadManagedContext`).
 */
async function seedHistory(world: RunsWorld, conversationId: string, count: number, chars: number): Promise<void> {
  await checkpoints.loadManagedContext(world.pool, conversationId);
  for (let index = 0; index < count; index += 1) {
    await world.pool.query("INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,$2,now())", [conversationId, `Histórico ${index}: ${'a'.repeat(chars)}`]);
  }
}

const prefer = (world: RunsWorld, botId: string, model: string) => (): Promise<unknown> => world.conversations.setPreference(botId, model, null);
const failureCodes = async (world: RunsWorld) => (await world.pool.query('SELECT id::text, failure_code FROM runs WHERE failure_code IS NOT NULL')).rows;

describe('modelo trocado durante a preparação (A15)', () => {
  it('a etapa prepara de novo UMA vez e a chamada vai ao modelo vigente, sem falhar a execução', async () => {
    const world = await newWorld(WINDOW);
    let probe: ReturnType<typeof interleave> | undefined;
    try {
      const bot = await world.createBot();
      const sent = scriptProvider(world);
      // O dono troca o modelo logo depois de a preparação resolver o modelo da conversa (glm-5.1) e antes de ela montar o contexto.
      probe = interleave(world, PROFILE_READ, { 1: prefer(world, bot.id, 'opencode/kimi-k2.7-code') });
      world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed');
      expect(probe.hits()).toBe(2); // a preparação inicial e UMA nova: sem laço
      expect(sent).toEqual([{ model: 'opencode/kimi-k2.7-code', protocol: 'messages', summary: false }]); // o pedido pronto para o modelo antigo nunca foi enviado
      expect(await world.runRow(run)).toMatchObject({ status: 'completed', failure_code: null });
      expect((await world.pool.query('SELECT last_model FROM runs WHERE id = $1', [run])).rows).toEqual([{ last_model: 'opencode/kimi-k2.7-code' }]);
      expect(await failureCodes(world)).toEqual([]);
    } finally { probe?.restore(); await world.cleanup(); }
  }, 60_000);

  it('uma segunda troca na mesma etapa encerra com CONTEXT_CONFIGURATION_CHANGED: sem laço, sem chamar o provedor e com a mensagem segura do registro', async () => {
    const world = await newWorld(WINDOW);
    let probe: ReturnType<typeof interleave> | undefined;
    try {
      const bot = await world.createBot();
      const sent = scriptProvider(world);
      // Glm -> kimi na primeira preparação e kimi -> glm na nova: a configuração segue mudando e a etapa desiste.
      probe = interleave(world, PROFILE_READ, { 1: prefer(world, bot.id, 'opencode/kimi-k2.7-code'), 2: prefer(world, bot.id, 'opencode/glm-5.1') });
      world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'failed');
      expect(probe.hits()).toBe(2); // não há uma terceira preparação
      expect(sent).toEqual([]);
      expect(await world.runRow(run)).toMatchObject({ status: 'failed', failure_code: 'CONTEXT_CONFIGURATION_CHANGED' });
      const card = (await world.timeline(bot)).find((entry) => entry.kind === 'card');
      expect(card).toMatchObject({ data: { type: 'run_failed', code: 'CONTEXT_CONFIGURATION_CHANGED' }, content: ERROR_CODES.CONTEXT_CONFIGURATION_CHANGED.message });
      expect(await failureCodes(world)).toEqual([{ id: run, failure_code: 'CONTEXT_CONFIGURATION_CHANGED' }]);
    } finally { probe?.restore(); await world.cleanup(); }
  }, 60_000);

  it('a recarga pedida por uma recusa de contexto, com o modelo trocado antes dela, prepara do zero para o modelo vigente (a recusa era de outro modelo)', async () => {
    const world = await newWorld(WINDOW);
    try {
      const bot = await world.createBot();
      // A primeira chamada (glm-5.1) é recusada por tamanho e, no mesmo instante, o dono troca o modelo: a recarga já nasce com o modelo errado.
      const sent = scriptProvider(world, async (index) => {
        if (index !== 0) return;
        await world.conversations.setPreference(bot.id, 'opencode/kimi-k2.7-code', null);
        throw new ChatRejected(400, false, true);
      });
      world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed');
      expect(sent.map((call) => call.model)).toEqual(['opencode/glm-5.1', 'opencode/kimi-k2.7-code']);
      expect(await world.runRow(run)).toMatchObject({ status: 'completed', failure_code: null });
      expect(await failureCodes(world)).toEqual([]); // nem CONTEXT_TOO_LARGE nem CONTEXT_COMPACTION_FAILED
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('janela trocada durante a preparação (A15)', () => {
  it('o pedido é dimensionado de novo para a janela vigente: a medição gravada é a da janela nova', async () => {
    const world = await newWorld(WINDOW);
    let probe: ReturnType<typeof interleave> | undefined;
    try {
      const bot = await world.createBot();
      const sent = scriptProvider(world);
      // A segunda leitura da janela é a de `modelStep` ao dimensionar o pedido, depois de `loadContext` ter fixado a configuração com a janela antiga.
      probe = interleave(world, WINDOW_READ, { 2: () => world.pool.query('UPDATE app_settings SET bot_context_window_tokens = $1', [NEXT_WINDOW]) });
      world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed');
      expect(probe.hits()).toBeGreaterThanOrEqual(4); // duas leituras por preparação: a inicial e UMA nova
      expect(sent).toHaveLength(1);
      expect(await failureCodes(world)).toEqual([]);
      const measurement = (await world.pool.query<{ measurement: { inputBudget: number } }>('SELECT measurement FROM conversation_context')).rows[0]!.measurement;
      // Orçamento de 128k pela regra da spec (A1), escrito à mão: reserva de saída de 25% da janela (32.768) e margem de 2.048.
      expect(measurement.inputBudget).toBe(96_256);
    } finally { probe?.restore(); await world.cleanup(); }
  }, 60_000);
});

describe('janela ou effort trocados durante a chamada paga de resumo (A15)', () => {
  it.each([['a janela', 'janela'], ['o effort', 'effort']] as const)('trocar %s no meio do resumo descarta o resumo pronto (nada é aplicado, o custo fica incerto) e a etapa prepara de novo e conclui', async (_label, change) => {
    const world = await newWorld(WINDOW);
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), 18, 4000); // ~72 mil bytes: passa do limiar do orçamento de 64k (47.104; 90% = 42.394) e cabe no de 128k (96.256)
      // O dono mexe na configuração enquanto a chamada paga está no ar: a janela do contexto ou o effort do bot.
      const sent = scriptProvider(world, async (index) => {
        if (index !== 0) return;
        if (change === 'janela') await world.pool.query('UPDATE app_settings SET bot_context_window_tokens = $1', [NEXT_WINDOW]);
        else await world.pool.query("UPDATE bots SET effort = 'high'");
      });
      world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed');
      // O resumo pronto era da configuração antiga e foi descartado; a execução não paga outro (`summaryGivenUp`) e a chamada principal vai uma única vez, já com a vigente.
      expect(sent.map((call) => call.summary)).toEqual([true, false]);
      expect(await world.runRow(run)).toMatchObject({ status: 'completed', failure_code: null });
      expect((await world.pool.query('SELECT revision, summary FROM conversation_context')).rows).toEqual([{ revision: 0, summary: '' }]);
      expect((await world.pool.query("SELECT state, input_tokens::text FROM model_call_usage WHERE purpose = 'summary'")).rows).toEqual([{ state: 'unknown', input_tokens: '100' }]);
      expect(await failureCodes(world)).toEqual([]);
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('compactação manual com o modelo trocado durante a preparação (A15)', () => {
  it('"Compactar agora" prepara de novo e resume com o modelo vigente: a operação conclui e nenhum código de falha é gravado', async () => {
    const world = await newWorld(WINDOW); // janela de 64k fixada (com o padrão de 256k o trecho final íntegro, 25% do orçamento, cobriria tudo): cinco mensagens de ~4.000 caracteres deixam o lote a cobrir fora do trecho final do resumo manual
    let probe: ReturnType<typeof interleave> | undefined;
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      await seedHistory(world, conversationId, 5, 4000);
      const sent = scriptProvider(world);
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Pedido anterior'), 'completed');
      await world.waitForStatus(await world.send(bot, 'Pedido atual'), 'completed');
      const before = sent.length;
      const state = await world.conversations.contextState(bot.id);
      // A troca acontece na preparação da própria manutenção (a primeira leitura do perfil depois do pedido do dono).
      probe = interleave(world, PROFILE_READ, { 1: prefer(world, bot.id, 'opencode/kimi-k2.7-code') });
      const requestId = randomUUID();
      await world.conversations.maintainContext(bot.id, { requestId, mode: 'summarize', expectedRevision: state.revision }, randomUUID());
      const run = (await world.pool.query<{ id: string }>('SELECT id::text FROM runs WHERE context_operation_id = $1', [requestId])).rows[0]!.id;
      await world.waitForStatus(run, 'completed');
      expect(probe.hits()).toBe(2); // a preparação inicial e UMA nova
      expect(sent.slice(before)).toEqual([{ model: 'opencode/kimi-k2.7-code', protocol: 'messages', summary: true }]);
      expect((await world.conversations.contextState(bot.id)).operation).toMatchObject({ status: 'completed', errorCode: null, result: { changed: true } });
      expect((await world.pool.query("SELECT model, state, summary_outcome FROM model_call_usage WHERE run_id = $1 AND purpose = 'summary'", [run])).rows).toEqual([{ model: 'opencode/kimi-k2.7-code', state: 'completed', summary_outcome: 'applied' }]);
      expect(await failureCodes(world)).toEqual([]);
    } finally { probe?.restore(); await world.cleanup(); }
  }, 60_000);
});

describe('evidência das fontes ausente ou revogada (A15)', () => {
  it('encerra com CONTEXT_EVIDENCE_UNAVAILABLE e a mensagem do registro, sem chamar o provedor nem emitir CONTEXT_COMPACTION_FAILED', async () => {
    const world = await newWorld(WINDOW);
    try {
      const bot = await world.createBot();
      const sent = scriptProvider(world);
      // `loadContext` define as fontes com `mergeEvidence`; sem elas a medição e a reserva da chamada não têm o que registrar.
      vi.spyOn(evidenceProvenance, 'mergeEvidence').mockImplementationOnce(() => undefined as never);
      world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'failed');
      expect(sent).toEqual([]);
      expect(await world.runRow(run)).toMatchObject({ status: 'failed', failure_code: 'CONTEXT_EVIDENCE_UNAVAILABLE' });
      const card = (await world.timeline(bot)).find((entry) => entry.kind === 'card');
      expect(card).toMatchObject({ data: { type: 'run_failed', code: 'CONTEXT_EVIDENCE_UNAVAILABLE' }, content: ERROR_CODES.CONTEXT_EVIDENCE_UNAVAILABLE.message });
      expect(await failureCodes(world)).toEqual([{ id: run, failure_code: 'CONTEXT_EVIDENCE_UNAVAILABLE' }]);
    } finally { await world.cleanup(); }
  }, 60_000);

  it('fonte removida ou revogada depois da preparação: a reserva da chamada recusa com CONTEXT_EVIDENCE_UNAVAILABLE (não com o código do resumo)', async () => {
    const world = await newWorld(WINDOW);
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      // Um anexo que não existe na conversa: a evidência não valida e a reserva (que protege a chamada principal e a de resumo) recusa antes de qualquer envio.
      await expect(checkpoints.reserveModelSources(world.pool, conversationId, bot.id, { attachments: ['999999'], tables: [], docs: [] })).rejects.toMatchObject({ code: 'CONTEXT_EVIDENCE_UNAVAILABLE' });
      await expect(checkpoints.reserveModelSources(world.pool, conversationId, bot.id, { attachments: [], tables: [], docs: [] })).resolves.toBeUndefined();
      // Doc lido pelo bot (phase 14, A33): a reserva trava a linha do doc como a da tabela e recusa a leitura cujo acesso foi revogado depois da preparação.
      const docs = new DocService({ pool: world.pool });
      const doc = await docs.create({ title: 'Plano', content: 'x', botIds: [bot.id], operationId: randomUUID() }, { kind: 'owner' });
      const read = { attachments: [], tables: [], docs: [{ docId: doc.id, botId: bot.id, accessVersion: 1 }] };
      await expect(checkpoints.reserveModelSources(world.pool, conversationId, bot.id, read)).resolves.toBeUndefined();
      await docs.share(doc.id, { botIds: [], expectedAccessVersion: 1, operationId: randomUUID() }, { kind: 'owner' });
      await expect(checkpoints.reserveModelSources(world.pool, conversationId, bot.id, read)).rejects.toMatchObject({ code: 'CONTEXT_EVIDENCE_UNAVAILABLE' });
    } finally { await world.cleanup(); }
  }, 60_000);

  it('no "Compactar agora", a reserva recusada grava CONTEXT_EVIDENCE_UNAVAILABLE na operação, com o motivo próprio no painel e sem chamar o provedor de resumo', async () => {
    const world = await newWorld(WINDOW); // janela de 64k fixada, como na jornada manual acima
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), 5, 4000);
      const sent = scriptProvider(world);
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Pedido anterior'), 'completed');
      await world.waitForStatus(await world.send(bot, 'Pedido atual'), 'completed');
      const before = sent.length;
      const state = await world.conversations.contextState(bot.id);
      // A reserva da chamada de resumo recusa (a fonte foi revogada depois da preparação): a próxima reserva, se houvesse, passaria.
      const reserve = vi.spyOn(checkpoints, 'reserveModelSources').mockImplementationOnce(async () => { throw new DomainError('CONTEXT_EVIDENCE_UNAVAILABLE'); });
      const requestId = randomUUID();
      await world.conversations.maintainContext(bot.id, { requestId, mode: 'summarize', expectedRevision: state.revision }, randomUUID());
      const run = (await world.pool.query<{ id: string }>('SELECT id::text FROM runs WHERE context_operation_id = $1', [requestId])).rows[0]!.id;
      await world.waitForStatus(run, 'failed');
      expect(reserve).toHaveBeenCalled();
      expect(sent.slice(before)).toEqual([]);
      expect(await world.runRow(run)).toMatchObject({ status: 'failed', failure_code: 'CONTEXT_EVIDENCE_UNAVAILABLE' });
      const operation = (await world.conversations.contextState(bot.id)).operation;
      expect(operation).toMatchObject({ status: 'failed', errorCode: 'CONTEXT_EVIDENCE_UNAVAILABLE' });
      expect(contextFailureMessage(operation!.errorCode)).toBe('Não foi possível confirmar as fontes do contexto. Tente de novo.');
      expect(await failureCodes(world)).toEqual([{ id: run, failure_code: 'CONTEXT_EVIDENCE_UNAVAILABLE' }]);
    } finally { await world.cleanup(); }
  }, 60_000);
});
