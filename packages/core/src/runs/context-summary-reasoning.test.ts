// Regressão do "Não foi possível compactar." do resumo manual ("Compactar agora") em conversa pesada com modelo que RACIOCINA (deepseek-v4.1-flash, phase 8, 13/10/2026).
//
// O que aconteceu em produção: o dono travou uma conversa em 32k, subiu para 64k, a elisão manual funcionou e o resumo manual falhou; subiu para 128k e o
// indicador seguiu alto. A causa não era estado herdado: a chamada de resumo pedia no máximo 2.048 tokens de saída (texto E raciocínio contam no mesmo
// limite do provedor) e o deepseek gastava todo o limite pensando, devolvendo `finish_reason=length` sem nenhum texto (`output_limit`), o que a manutenção
// grava como CONTEXT_COMPACTION_FAILED. Sonda real contra o provedor, entrada de 33 a 108 KB: sem effort o raciocínio gastou 2,3 a 4,1 mil tokens (2.048
// estourava quase sempre), com effort baixo 1,3 a 2,8 mil (estourava em metade das chamadas) e com effort máximo 4,7 mil.
//
// Phase 9: a elisão manual saiu do produto (D4) e o resumo virou a compactação do F3. O contrato da chamada continua o mesmo (sem ferramentas, effort mais baixo
// que o modelo aceita, limite de saída que comporta raciocínio e texto), a janela e o resto da configuração deixaram de invalidar o checkpoint (CTX-09), e uma
// recusa do resumo agora é uma ESCADA de entradas menores antes de falhar.
//
// Aqui o motor, a fila, o PostgreSQL e o provedor falso são os reais; só o modelo é roteirizado, e a chamada de resumo é reconhecida pelo turno de sistema
// (não pelo limite de saída, que é exatamente o que a correção mudou). O modelo simulado "raciocina": gasta tokens de saída conforme o effort recebido e
// devolve `length` sem texto quando o limite não comporta o raciocínio mais o resumo.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { contextFailureMessage } from '@aion/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest } from '../models/chat-protocols';
import { SUMMARY_SECTIONS } from './compaction';
import { SUMMARY_MAX_OUTPUT_TOKENS, estimateChatPayload, lowestEffort } from './context-budget';
import { loadManagedContext } from './context-checkpoint';
import { createRunsWorld, waitFor, type RunsWorld } from './test-support';
import { defineTool } from './tools';
import { ABRIR_GRUPO, DISCOVER_TOOLS } from './tool-discovery';
import { searchHistoryTool } from './search-history';
import { readAttachmentTool } from './read-attachment';
import { editMemoryTool } from './edit-memory';
import { updateObjectiveTool } from './update-objective';
import { proposeRoutineTool } from './propose-routine';
import { getRoutineTool, listRoutinesTool, proposeRoutineChangeTool } from './routine-tools';
import { tableTools } from './table-tools';

afterEach(() => { vi.restoreAllMocks(); });

const MODEL = 'opencode/deepseek-v4.1-flash';

/** Página de esquemas como a do conector (~10 mil caracteres): a rodada pesada da conversa real foi feita de buscas assim. */
const schemaPage = (n: number): string => JSON.stringify({ page: n, items: Array.from({ length: 30 }, (_, index) => ({ slug: `APP_ACTION_${n}_${index}`, description: 'Ação do conector com parâmetros extensos. '.repeat(3), input_parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] } })), end: `FIM_PAGINA_${n}` });
const schemaSearch = defineTool({
  definition: { name: 'schema_search', description: 'Busca esquemas de ações do conector.', parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } },
  argsSchema: z.strictObject({ q: z.string() }), resultLimitBytes: 32 * 1024, label: () => 'Buscar esquemas', execute: async ({ q }) => ({ result: schemaPage(Number(q)) }),
});

/** O catálogo interno completo do motor mais a busca volumosa: com `coreCatalog` ligado (como em produção) o catálogo base pesa dezenas de milhares de bytes. */
const FULL_TOOLS = [searchHistoryTool, readAttachmentTool, editMemoryTool, updateObjectiveTool, proposeRoutineTool, listRoutinesTool, getRoutineTool, proposeRoutineChangeTool, ...tableTools, schemaSearch];

/** Tokens de raciocínio por effort do modelo simulado (ordem de grandeza da sonda real; "padrão" é o raciocínio sem effort informado). */
const REASONING: Record<string, number> = { low: 1_500, medium: 3_000, high: 4_000, xhigh: 5_000, max: 5_500, default: 3_500 };
const SUMMARY_TEXT_TOKENS = 300;
/** Razão tokens/byte que o provedor simulado informa no usage das chamadas principais (calibra o orçamento, como o provedor real). */
const USAGE_RATIO = 0.3;

/** Checkpoint bem formado (as sete seções), o que um resumo que presta devolve. */
const CHECKPOINT = SUMMARY_SECTIONS.map((title, index) => `## ${title}\n${index === 0 ? 'Resumo derivado: o dono pediu o levantamento de esquemas dos apps; ids dos resultados preservados.' : 'Nada.'}`).join('\n\n');

interface Script {
  phase: 'heavy' | 'plain';
  /** Chamadas de resumo recebidas, na ordem. */
  summaries: ChatRequest[];
  /** Quantas das próximas chamadas de resumo terminam sem raciocinar e sem texto, no limite de saída (estado ruim deixado por uma tentativa anterior). */
  forcedFailures: number;
}

const isSummary = (request: ChatRequest): boolean => request.turns[0]?.role === 'system' && request.turns[0].text.startsWith('Você produz o checkpoint do histórico');

/** Primeiro passo dos roteiros: o bot abre um grupo da árvore (a lista `tools` dele é fixa, phase 15), o Chat geral seleciona a ferramenta por `discover_tools`. */
const openingCall = (request: ChatRequest, tool: string): ChatEvent => (request.tools?.some((entry) => entry.name === ABRIR_GRUPO)
  ? { type: 'tool_call', id: randomUUID(), name: ABRIR_GRUPO, arguments: JSON.stringify({ path: 'ferramentas/memoria' }) }
  : { type: 'tool_call', id: randomUUID(), name: DISCOVER_TOOLS, arguments: JSON.stringify({ names: [tool] }) });

/** Modelo roteirizado: a rodada pesada (36 buscas) e depois respostas simples; o resumo raciocina e pode estourar o limite de saída. */
function scriptModel(world: RunsWorld, script: Script): void {
  let calls = 0;
  vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, protocol, request): AsyncGenerator<ChatEvent> {
    if (isSummary(request)) {
      script.summaries.push(request);
      const reasoning = script.forcedFailures > 0 ? Number.MAX_SAFE_INTEGER : REASONING[request.effort ?? 'default']!;
      if (script.forcedFailures > 0) script.forcedFailures--;
      if (reasoning + SUMMARY_TEXT_TOKENS > request.maxTokens) {
        yield { type: 'usage', usage: { inputTokens: 5_000, outputTokens: request.maxTokens } };
        yield { type: 'done', reason: 'output_limit' };
        return;
      }
      yield { type: 'text', text: CHECKPOINT };
      yield { type: 'usage', usage: { inputTokens: 5_000, outputTokens: reasoning + SUMMARY_TEXT_TOKENS } };
      yield { type: 'done', reason: 'stop' };
      return;
    }
    const call = calls++;
    if (script.phase === 'heavy' && call === 0) yield openingCall(request, 'schema_search');
    else if (script.phase === 'heavy' && call <= 18) {
      for (let index = 0; index < 2; index++) yield { type: 'tool_call', id: randomUUID(), name: 'schema_search', arguments: JSON.stringify({ q: String(call * 10 + index) }) };
    } else yield { type: 'text', text: script.phase === 'heavy' ? 'Levantamento concluído.' : 'Resposta normal.' };
    yield { type: 'usage', usage: { inputTokens: Math.round(estimateChatPayload(request, protocol).textTokens * USAGE_RATIO), outputTokens: 20 } };
    yield { type: 'done', reason: 'stop' };
  });
}

/** "Compactar agora" (o clique do painel): enfileira com a revisão lida agora, espera a execução terminar e devolve o estado público. */
async function compactNow(world: RunsWorld, botId: string) {
  const state = await world.conversations.contextState(botId), requestId = randomUUID();
  await world.conversations.maintainContext(botId, { requestId, mode: 'summarize', expectedRevision: state.revision }, randomUUID());
  const run = (await world.pool.query<{ id: string }>('SELECT id::text FROM runs WHERE context_operation_id=$1', [requestId])).rows[0]!.id;
  await waitFor('manutenção summarize', async () => ['completed', 'failed'].includes((await world.runRow(run)).status), 30_000);
  return { run, state: await world.conversations.contextState(botId) };
}

/** Troca a janela global (bots e Chat geral); só as opções válidas desde a phase 11 (64k, 128k, 256k). */
const setWindow = (world: RunsWorld, tokens: 65536 | 131072 | 262144) => world.pool.query('UPDATE app_settings SET bot_context_window_tokens=$1, general_chat_context_window_tokens=$1', [tokens]);
const contextFailures = async (world: RunsWorld) => (await world.pool.query("SELECT id::text, failure_code FROM runs WHERE failure_code IS NOT NULL")).rows;

describe('resumo manual com modelo que raciocina', () => {
  // Com o catálogo core ligado (produção) e desligado (padrão dos mundos de teste): o piso do pedido muda, o caminho do resumo não.
  it.each([false, true])('a conversa do dono (catálogo core %s): rodada pesada travada em 64k, 128k com "Compactar agora", 256k sem perder o checkpoint e a mensagem seguinte', async (coreCatalog) => {
    const world = await createRunsWorld({ tools: coreCatalog ? FULL_TOOLS : [schemaSearch], coreCatalog, contextWindow: 65536 });
    try {
      await world.models.test(MODEL);
      // Effort alto no bot: o resumo precisa continuar saindo, porque o raciocínio profundo não ajuda a resumir e estourava o limite sozinho.
      const bot = await world.createBot({ model: MODEL, effort: 'high', stepLimit: 100 });
      // O resumo da própria rodada falha (o deepseek estourando o limite pensando, como em produção): a conversa não trava, o colapso em índice segura a rodada, e ela
      // termina sem checkpoint, que é o estado em que o dono encontrou a conversa.
      const script: Script = { phase: 'heavy', summaries: [], forcedFailures: 1_000 };
      scriptModel(world, script); world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Levante os esquemas de todos os apps conectados.'), 'completed', 120_000);
      script.phase = 'plain'; script.forcedFailures = 0;
      expect(await contextFailures(world)).toEqual([]);
      expect((await world.pool.query('SELECT revision, summary FROM conversation_context')).rows).toEqual([{ revision: 0, summary: '' }]);

      // 128k: "Compactar agora" cobre o histórico antigo da conversa ociosa.
      await setWindow(world, 131072);
      const before = script.summaries.length;
      const summary = await compactNow(world, bot.id);
      expect(summary.state.operation).toMatchObject({ mode: 'summarize', status: 'completed', errorCode: null, result: { changed: true } });
      expect(await world.runRow(summary.run)).toMatchObject({ status: 'completed', failure_code: null });
      const added = script.summaries.slice(before);
      expect(added.length).toBeGreaterThanOrEqual(1);
      // Contrato da chamada de resumo: sem ferramentas, effort mais baixo aceito (não o alto do bot) e limite de saída que comporta raciocínio e texto.
      for (const request of added) {
        expect(request.tools).toBeUndefined();
        expect(request.effort).toBe('low');
        expect(request.maxTokens).toBe(SUMMARY_MAX_OUTPUT_TOKENS);
      }
      const stored = (await world.pool.query<{ revision: number; summary: string }>('SELECT revision, summary FROM conversation_context')).rows[0]!;
      expect(stored.summary).toBe(CHECKPOINT);
      expect((await world.pool.query("SELECT state, summary_outcome FROM model_call_usage WHERE run_id=$1 AND purpose='summary'", [summary.run])).rows.every((row) => row.state === 'completed' && row.summary_outcome === 'applied')).toBe(true);

      // 256k: a janela NÃO entra na validade do checkpoint (CTX-09), então o resumo anterior continua valendo e vai no pedido. O dono ainda tem na tela a revisão lida
      // antes de trocar a janela: o clique é recusado na borda (409), sem criar operação nem gastar chamada.
      const staleRevision = (await world.conversations.contextState(bot.id)).revision;
      await setWindow(world, 262144);
      const operations = (await world.pool.query('SELECT count(*) AS total FROM context_maintenance')).rows[0]!.total;
      await expect(world.conversations.maintainContext(bot.id, { requestId: randomUUID(), mode: 'summarize', expectedRevision: staleRevision }, randomUUID())).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
      expect((await world.pool.query('SELECT count(*) AS total FROM context_maintenance')).rows[0]!.total).toBe(operations);
      const summary256 = await compactNow(world, bot.id);
      expect(summary256.state.operation).toMatchObject({ status: 'completed', errorCode: null });
      expect((await world.pool.query('SELECT revision, summary FROM conversation_context')).rows[0]).toEqual(stored); // nada novo a cobrir, nada invalidado
      const next = await world.send(bot, 'Mensagem nova depois da manutenção.');
      await world.waitForStatus(next, 'completed', 30_000);
      expect(await contextFailures(world)).toEqual([]);
      // Nada foi apagado: as 36 páginas seguem inteiras no banco.
      expect(Number((await world.pool.query("SELECT count(*) AS total FROM messages WHERE kind='activity' AND content LIKE '%FIM_PAGINA_%'")).rows[0]!.total)).toBe(36);
    } finally { await world.cleanup(); }
  }, 240_000);

  it('uma tentativa anterior que falhou (todas as entradas da escada no limite de saída, operação failed, fase failed) não bloqueia o clique seguinte', async () => {
    const world = await createRunsWorld({ tools: [schemaSearch], contextWindow: 65536 });
    try {
      await world.models.test(MODEL);
      const bot = await world.createBot({ model: MODEL, effort: 'high', stepLimit: 100 });
      const script: Script = { phase: 'heavy', summaries: [], forcedFailures: 1_000 };
      scriptModel(world, script); world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Levante os esquemas de todos os apps conectados.'), 'completed', 120_000);
      script.phase = 'plain';

      // Estado deixado pela falha: o provedor estoura o limite em TODAS as entradas da escada (o que a versão anterior fazia sempre com este modelo).
      script.forcedFailures = 100;
      const attemptsBefore = script.summaries.length;
      const failed = await compactNow(world, bot.id);
      expect(failed.state.operation).toMatchObject({ status: 'failed', errorCode: 'CONTEXT_COMPACTION_FAILED' });
      expect(failed.state.phase).toBe('failed');
      // O que a tela mostra é o motivo seguro desse código, não o genérico.
      expect(contextFailureMessage(failed.state.operation!.errorCode)).toBe('O modelo não devolveu um resumo utilizável. Nada foi alterado; tente de novo.');
      const attempts = (await world.pool.query<{ summary_outcome: string | null }>("SELECT summary_outcome FROM model_call_usage WHERE run_id=$1 AND purpose='summary'", [failed.run])).rows;
      expect(attempts.length).toBe(script.summaries.length - attemptsBefore);
      expect(attempts.length).toBeGreaterThanOrEqual(2); // a escada tentou entradas menores antes de desistir
      expect(attempts.length).toBeLessThanOrEqual(4);
      expect(attempts.every((row) => row.summary_outcome === 'output_limit')).toBe(true);
      expect((await world.pool.query('SELECT revision, summary FROM conversation_context')).rows).toEqual([{ revision: 0, summary: '' }]);

      // Nada disso pertence à operação seguinte: o clique novo ignora a recusa gravada, completa e o resumo é aplicado.
      script.forcedFailures = 0;
      const again = await compactNow(world, bot.id);
      expect(again.state.operation).toMatchObject({ status: 'completed', errorCode: null, result: { changed: true } });
      expect(again.state.phase).toBe('ready');
      expect((await world.pool.query('SELECT length(summary) > 0 AS has_summary FROM conversation_context')).rows[0]!.has_summary).toBe(true);
      await world.waitForStatus(await world.send(bot, 'Mensagem nova.'), 'completed', 30_000);
      // A única falha é a forçada no começo; nenhuma execução posterior herdou o problema.
      expect(await contextFailures(world)).toEqual([{ id: failed.run, failure_code: 'CONTEXT_COMPACTION_FAILED' }]);
    } finally { await world.cleanup(); }
  }, 180_000);

  it('modelo sem nível de effort aceito: o resumo não manda effort, mas segue com o limite de saída que comporta o raciocínio', async () => {
    const world = await createRunsWorld({ contextWindow: 65536 });
    try {
      await world.models.test('opencode/glm-5.3-flash');
      const bot = await world.createBot({ model: 'opencode/glm-5.3-flash' });
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      await loadManagedContext(world.pool, conversationId); // cobertura de conversa nova: começa do zero
      for (let index = 0; index < 5; index++) await world.pool.query("INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,$2,now())", [conversationId, `Decisão ${index}: ${'a'.repeat(6000)}`]); // 30 mil bytes: passam do trecho final íntegro (25% do orçamento de 64k) e deixam histórico a cobrir
      const script: Script = { phase: 'plain', summaries: [], forcedFailures: 0 };
      scriptModel(world, script); world.engine.start();
      const summary = await compactNow(world, bot.id);
      expect(summary.state.operation).toMatchObject({ status: 'completed', errorCode: null, result: { changed: true } });
      expect(script.summaries[0]!.effort).toBeUndefined();
      expect(script.summaries[0]!.maxTokens).toBe(SUMMARY_MAX_OUTPUT_TOKENS);
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('effort do resumo', () => {
  it('é o mais baixo que o modelo aceita, na ordem do vocabulário; sem nível aceito, nenhum', () => {
    expect(lowestEffort(['low', 'medium', 'high'])).toBe('low');
    expect(lowestEffort(['max', 'high', 'medium'])).toBe('medium');
    expect(lowestEffort(['xhigh'])).toBe('xhigh');
    expect(lowestEffort([])).toBeUndefined();
    expect(lowestEffort(['desconhecido'])).toBeUndefined();
  });
});
