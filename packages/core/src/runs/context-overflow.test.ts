// Regressão do travamento por contexto obrigatório (phase 8, F3), agora sob o modelo da phase 9 (CTX-07): uma rodada com dezenas de resultados de ~10 mil caracteres
// (esquemas de conector) numa janela efetiva de 32k deixava a própria rodada e TODA mensagem seguinte falhando com CONTEXT_TOO_LARGE, em bot e Chat geral. Hoje a rodada é
// COMPACTADA dentro dela (resumo estruturado e trecho final íntegro) e o colapso em índice só entra como rede de segurança quando o resumo não presta. Aqui o motor,
// o PostgreSQL e o provedor falso são os reais; o modelo é roteirizado para repetir a rodada do problema.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from '@aion/shared';
import type { ChatEvent, ChatRequest } from '../models/chat-protocols';
import { GeneralChatService } from '../general-chat/service';
import { SUMMARY_SECTIONS } from './compaction';
import { MAX_OUTPUT_TOKENS, SUMMARY_MAX_OUTPUT_TOKENS, contextEnvelope, estimateChatPayload } from './context-budget';
import { createRunsWorld, waitFor, type RunsWorld } from './test-support';
import { defineTool } from './tools';
import { searchHistoryTool } from './search-history';
import { readAttachmentTool } from './read-attachment';
import { editMemoryTool } from './edit-memory';
import { updateObjectiveTool } from './update-objective';
import { proposeRoutineTool } from './propose-routine';
import { getRoutineTool, listRoutinesTool, proposeRoutineChangeTool } from './routine-tools';
import { tableTools } from './table-tools';
import { ABRIR_GRUPO, DISCOVER_TOOLS } from './tool-discovery';

/**
 * Capacidade confirmada simulada do `opencode/glm-5.1` (nulo = sem capacidade, o caso real do modelo). A menor opção de janela é 64k desde a phase 11, então a janela EFETIVA de 32k da regressão
 * (menor entre a escolhida e a capacidade, `resolveContextWindow`) vem de um modelo com capacidade confirmada de 32k: o `beforeEach` liga, o `afterEach` desliga e o teste de 64k desliga
 * no começo. Hoisted porque o `vi.mock` roda antes dos imports.
 */
const modelCapacity = vi.hoisted(() => ({ tokens: null as number | null }));
vi.mock('../models/context-capacity', () => ({
  readModelContextCapacity: (model: string | null) => (modelCapacity.tokens !== null && model === 'opencode/glm-5.1'
    ? { provider: 'opencode_go', model, contextTokens: modelCapacity.tokens, outputTokens: null, source: 'https://exemplo.test/glm-5-1', checkedAt: '2026-10-17T00:00:00.000Z' }
    : null),
}));

/** Janela escolhida (a menor opção, fixada por cada teste, não depende do padrão do produto) e janela efetiva da regressão: 32768 - saída 8192 (25% da janela, phase 12) - margem 2048 = 22.528. */
const WINDOW = 65536;
const EFFECTIVE_WINDOW = 32768;
const INPUT_BUDGET = contextEnvelope(EFFECTIVE_WINDOW, MAX_OUTPUT_TOKENS).inputBudget;
beforeEach(() => { modelCapacity.tokens = EFFECTIVE_WINDOW; });
afterEach(() => { modelCapacity.tokens = null; });

/** Página de esquemas como a do conector: ~10 mil caracteres, com um marcador no fim para provar que o texto chegou inteiro ao modelo. */
const schemaPage = (n: number): string => JSON.stringify({ page: n, items: Array.from({ length: 30 }, (_, index) => ({ slug: `APP_ACTION_${n}_${index}`, description: 'Ação do conector com parâmetros extensos. '.repeat(3), input_parameters: { type: 'object', properties: { a: { type: 'string', description: 'campo a' }, b: { type: 'integer' }, c: { type: 'array', items: { type: 'string' } } }, required: ['a'] } })), end: `FIM_PAGINA_${n}` });

const schemaSearch = defineTool({
  definition: { name: 'schema_search', description: 'Busca esquemas de ações do conector.', parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } },
  argsSchema: z.strictObject({ q: z.string() }), resultLimitBytes: 32 * 1024, label: () => 'Buscar esquemas', execute: async ({ q }) => ({ result: schemaPage(Number(q)) }),
});
/** O catálogo interno padrão do motor mais a ferramenta volumosa: o tamanho do catálogo faz parte do que a janela precisa comportar. */
const TOOLS = [searchHistoryTool, readAttachmentTool, editMemoryTool, updateObjectiveTool, proposeRoutineTool, listRoutinesTool, getRoutineTool, proposeRoutineChangeTool, ...tableTools, schemaSearch];

/** Resumo bem formado (as sete seções); o provedor simulado devolve este, ou nada (`empty`), para cada chamada de resumo. */
const CHECKPOINT = SUMMARY_SECTIONS.map((title, index) => `## ${title}\n${index === 0 ? 'Resumo derivado: o dono pediu o levantamento de esquemas; os ids dos resultados foram preservados.' : 'Nada.'}`).join('\n\n');

interface Script {
  /** 'heavy': descobre a ferramenta e busca esquemas por `steps` etapas; 'plain': responde direto. */
  phase: 'heavy' | 'plain';
  steps: number;
  perStep: number;
  /** Razão tokens/byte que o provedor simulado informa no usage (calibra o orçamento e ancora a ocupação); nulo = sem usage, estimativa sem calibração. */
  scale: number | null;
  /** `ok`: a chamada de resumo devolve um checkpoint válido; `empty`: devolve nada (o resumo nunca presta e o colapso segura o pedido). */
  summary: 'ok' | 'empty';
  calls: number;
  requests: ChatRequest[];
  summaries: ChatRequest[];
  /** Lê o aviso do indicador (medição gravada) no instante em que o pedido chega ao provedor, uma entrada por pedido principal. */
  probe?: () => Promise<unknown>;
  compaction: unknown[];
  /** Roda no instante em que o pedido de índice `call` (0, 1, ...) chega ao provedor: simula o dono agindo no meio da execução (ex.: enviando um complemento). */
  beforeCall?: (call: number) => Promise<void>;
}
const newScript = (steps: number, perStep: number, scale: number | null = null, summary: 'ok' | 'empty' = 'ok'): Script => ({ phase: 'heavy', steps, perStep, scale, summary, calls: 0, requests: [], summaries: [], compaction: [] });

/** Primeiro passo dos roteiros: o bot abre um grupo da árvore (a lista `tools` dele é fixa, phase 15), o Chat geral seleciona a ferramenta por `discover_tools`. */
const openingCall = (request: ChatRequest, tool: string): ChatEvent => (request.tools?.some((entry) => entry.name === ABRIR_GRUPO)
  ? { type: 'tool_call', id: randomUUID(), name: ABRIR_GRUPO, arguments: JSON.stringify({ path: 'ferramentas/memoria' }) }
  : { type: 'tool_call', id: randomUUID(), name: DISCOVER_TOOLS, arguments: JSON.stringify({ names: [tool] }) });

/** Roteiro do modelo: a chamada de resumo (limite de saída `SUMMARY_MAX_OUTPUT_TOKENS`, sem ferramentas) devolve o checkpoint; as demais seguem a fase do roteiro. */
function scriptModel(world: RunsWorld, script: Script): void {
  vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
    if (request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS) {
      script.summaries.push(request);
      if (script.summary === 'ok') yield { type: 'text', text: CHECKPOINT };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } };
      yield { type: 'done', reason: 'stop' };
      return;
    }
    script.requests.push(request);
    if (script.probe) script.compaction.push(await script.probe());
    const call = script.calls++;
    await script.beforeCall?.(call);
    if (script.phase === 'heavy' && call === 0) yield openingCall(request, 'schema_search');
    else if (script.phase === 'heavy' && call <= script.steps) {
      for (let index = 0; index < script.perStep; index++) yield { type: 'tool_call', id: randomUUID(), name: 'schema_search', arguments: JSON.stringify({ q: String(call * 10 + index) }) };
    } else yield { type: 'text', text: script.phase === 'heavy' ? 'Levantamento concluído.' : 'Resposta normal.' };
    if (script.scale !== null) yield { type: 'usage', usage: { inputTokens: Math.round(estimateChatPayload(request, 'chat_completions').textTokens * script.scale), outputTokens: 20 } };
    yield { type: 'done', reason: 'stop' };
  });
}

/** Estimativa sem calibração do pedido exatamente como foi enviado ao provedor (1 byte = 1 token). */
const estimated = (request: ChatRequest): number => estimateChatPayload(request, 'chat_completions').estimatedInputTokens;
/** O que o provedor simulado contaria de verdade para esse pedido, na razão tokens/byte que o roteiro informa. */
const real = (request: ChatRequest, scale: number): number => Math.round(estimateChatPayload(request, 'chat_completions').textTokens * scale);
const turnsText = (request: ChatRequest): string => JSON.stringify(request.turns);
const hasCheckpoint = (request: ChatRequest): boolean => turnsText(request).includes('# Resumo derivado');
const hasIndex = (request: ChatRequest): boolean => turnsText(request).includes('Histórico anterior colapsado');

/** "Compactar agora" do painel: enfileira, espera a execução terminar e devolve o estado público. */
async function compactNow(world: RunsWorld, ref: string | { sessionId: string }) {
  const state = await world.conversations.contextState(ref), requestId = randomUUID();
  await world.conversations.maintainContext(ref, { requestId, mode: 'summarize', expectedRevision: state.revision }, randomUUID());
  const run = (await world.pool.query<{ id: string }>('SELECT id::text FROM runs WHERE context_operation_id=$1', [requestId])).rows[0]!.id;
  await waitFor('manutenção', async () => ['completed', 'failed'].includes((await world.runRow(run)).status), 30_000);
  return { run, state: await world.conversations.contextState(ref) };
}

/** Nenhuma execução da conversa pode ter terminado por contexto. */
const contextFailures = async (world: RunsWorld) => (await world.pool.query("SELECT id::text, failure_code FROM runs WHERE failure_code IN ('CONTEXT_TOO_LARGE','CONTEXT_COMPACTION_FAILED')")).rows;

/** Roda a rodada pesada e depois uma mensagem nova, devolvendo o roteiro para inspecionar o que foi enviado ao modelo. */
async function heavyThenNew(world: RunsWorld, send: (text: string) => Promise<string>, script: Script): Promise<void> {
  scriptModel(world, script);
  world.engine.start();
  await world.waitForStatus(await send('Levante os esquemas de todos os apps conectados.'), 'completed', 120_000);
  script.phase = 'plain';
  await world.waitForStatus(await send('Mensagem nova depois da rodada pesada.'), 'completed', 30_000);
}

describe('rodada pesada de ferramentas em janela de 32k', () => {
  it('bot: nem a rodada nem a mensagem seguinte travam; é compactada dentro da rodada, todo pedido cabe, o catálogo fica estável e os originais seguem íntegros', async () => {
    const world = await createRunsWorld({ tools: TOOLS, contextWindow: WINDOW });
    try {
      const bot: Bot = await world.createBot({ stepLimit: 100 }); await world.models.test('opencode/glm-5.1');
      const script = newScript(18, 2, 0.3); // 36 chamadas de ~10k caracteres numa só rodada, com o usage do provedor (0,3 token por byte)
      script.probe = async () => (await world.conversations.contextState(bot.id)).measurement?.compaction;
      await heavyThenNew(world, (text) => world.send(bot, text), script);
      expect(await contextFailures(world)).toEqual([]);
      for (const request of script.requests) expect(real(request, 0.3)).toBeLessThanOrEqual(INPUT_BUDGET);
      // A rodada passou do limiar várias vezes: foi compactada em checkpoints (sem chamada de resumo sem necessidade, cada uma coberta e aplicada) e o colapso, rede
      // de segurança, não foi preciso com um resumo que presta.
      expect(script.summaries.length).toBeGreaterThan(1);
      expect(script.summaries.length).toBeLessThanOrEqual(18);
      expect(script.requests.some(hasCheckpoint)).toBe(true);
      expect(script.requests.some(hasIndex)).toBe(false);
      // O aviso do indicador acompanha o pedido: limpo no começo e "resumo" no pedido que acabou de ser compactado; sem elisão.
      expect(script.compaction[0]).toEqual({ elision: false, summary: false, index: false });
      expect(script.compaction).toContainEqual(expect.objectContaining({ elision: false, summary: true }));
      expect(script.compaction.every((entry) => (entry as { elision: boolean }).elision === false)).toBe(true);
      for (const request of script.summaries) expect(estimated(request)).toBeLessThanOrEqual(INPUT_BUDGET);
      // O catálogo não oscila com o histórico: a lista do bot é fixa (portas, sem opcional), a mesma em toda etapa, inclusive depois de abrir um grupo e na mensagem nova.
      const published = script.requests.map((request) => (request.tools ?? []).map((tool) => tool.name).join(','));
      expect(new Set(published).size).toBe(1);
      expect(published[0]).toBe('abrir_grupo,use_tool,read_activity');
      // A mensagem nova chegou inteira ao modelo.
      const last = script.requests.at(-1)!;
      expect(last.turns.some((turn) => turn.role === 'user' && turn.text.includes('Mensagem nova depois da rodada pesada.'))).toBe(true);
      // Nada foi apagado: as 36 páginas continuam inteiras no banco (a tela, a busca e o recall leem de lá).
      const stored = (await world.pool.query<{ total: string; shortest: string }>("SELECT count(*) AS total, min(length(content)) AS shortest FROM messages WHERE kind='activity' AND content LIKE '%FIM_PAGINA_%'")).rows[0]!;
      expect(Number(stored.total)).toBe(36);
      expect(Number(stored.shortest)).toBeGreaterThan(10_000);
    } finally { await world.cleanup(); }
  }, 180_000);

  it('Chat geral: a mesma rodada pesada também não trava a sessão', async () => {
    const world = await createRunsWorld({ tools: TOOLS, contextWindow: WINDOW });
    try {
      await world.models.test('opencode/glm-5.1');
      const ref = { sessionId: (await new GeneralChatService({ pool: world.pool }).create()).id };
      await world.conversations.setPreference(ref, 'opencode/glm-5.1', null);
      const script = newScript(18, 2, 0.3);
      await heavyThenNew(world, async (text) => (await world.conversations.send(ref, text)).id, script);
      expect(await contextFailures(world)).toEqual([]);
      for (const request of script.requests) expect(real(request, 0.3)).toBeLessThanOrEqual(INPUT_BUDGET);
      expect(script.requests.some(hasCheckpoint)).toBe(true);
      expect(script.requests.at(-1)!.turns.some((turn) => turn.role === 'user' && turn.text.includes('Mensagem nova depois da rodada pesada.'))).toBe(true);
    } finally { await world.cleanup(); }
  }, 180_000);

  it.each([{ summary: 'ok' as const, safety: 'compactação' }, { summary: 'empty' as const, safety: 'colapso em índice' }])('o complemento do dono absorvido no meio de uma rodada pesada (CONV-03) segue inteiro no pedido sob $safety e nunca entra no resumo nem no índice (R1)', async ({ summary }) => {
    const world = await createRunsWorld({ tools: TOOLS, contextWindow: WINDOW });
    try {
      const bot = await world.createBot({ stepLimit: 100 }); await world.models.test('opencode/glm-5.1');
      // A restrição vem depois dos 80 caracteres da prévia que o índice dá às mensagens do dono: se fosse colapsada, o modelo leria só a primeira metade.
      const complement = `${'Atenção a esta restrição nova do dono. '.repeat(3)}NAO envie nada ao cliente antes da minha aprovacao.`;
      const script = newScript(18, 2, 0.3, summary);
      // Chega durante a 5ª chamada, com a rodada ainda leve; é absorvido antes da 6ª e fica no meio da rodada, que depois engorda até ser compactada ou colapsada.
      script.beforeCall = async (call) => { if (call === 4) await world.send(bot, complement); };
      scriptModel(world, script); world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Levante os esquemas de todos os apps conectados.'), 'completed', 120_000);
      expect(await contextFailures(world)).toEqual([]);
      const absorbed = script.requests.slice(5);
      const pressed = absorbed.filter(summary === 'ok' ? hasCheckpoint : hasIndex);
      // A rodada foi compactada (ou colapsou) depois do complemento (senão a prova não diz nada) e todo pedido a partir da absorção o leva por inteiro, fora do índice.
      expect(pressed.length).toBeGreaterThan(3);
      for (const request of absorbed) {
        const notice = request.turns.find((turn) => turn.role === 'user' && turn.text.startsWith('# Histórico anterior colapsado'));
        expect(notice?.text ?? '').not.toContain('NAO envie');
        expect(request.turns.some((turn) => turn.role === 'user' && turn !== notice && turn.text.includes(complement))).toBe(true);
        expect(real(request, 0.3)).toBeLessThanOrEqual(INPUT_BUDGET);
      }
      // O que o resumo recebe como linhas a cobrir nunca inclui a abertura nem o complemento (mensagens do dono da rodada atual): seguem inteiras no pedido.
      for (const request of script.summaries) expect(request.turns[1]!.text).not.toContain('NAO envie');
    } finally { await world.cleanup(); }
  }, 180_000);

  it('com o resumo recusado, o colapso em índice (prefixo do pedido) fica byte a byte igual entre etapas consecutivas enquanto couber e só avança quando precisa (R2, cache)', async () => {
    // Só uma ferramenta de páginas pequenas (~3 mil caracteres) numa janela de 64k: o piso é pequeno e há folga entre a meta saudável do colapso e o limite, que é o que
    // deixa o corte parado vários passos entre um avanço e o seguinte. O resumo devolve nada: a execução desiste depois de UMA escada e dali em diante só o colapso
    // segura o pedido. (Com páginas de 10 mil caracteres numa janela de 32k uma única página já é quase metade do orçamento: não sobra folga e o corte avança a cada etapa.)
    const smallPages = defineTool({
      definition: { name: 'schema_search', description: 'Busca esquemas de ações do conector.', parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } },
      argsSchema: z.strictObject({ q: z.string() }), resultLimitBytes: 32 * 1024, label: () => 'Buscar esquemas', execute: async ({ q }) => ({ result: `PAGINA_${q} ${'y'.repeat(3000)}` }),
    });
    const wide = contextEnvelope(65536, MAX_OUTPUT_TOKENS).inputBudget;
    modelCapacity.tokens = null; // janela efetiva de 64k de verdade: sem capacidade confirmada menor
    const world = await createRunsWorld({ tools: [smallPages], contextWindow: 65536 });
    try {
      const bot = await world.createBot({ stepLimit: 100 }); await world.models.test('opencode/glm-5.1');
      const script = newScript(75, 1, null, 'empty');
      scriptModel(world, script); world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Levante os esquemas de todos os apps conectados.'), 'completed', 150_000);
      expect(await contextFailures(world)).toEqual([]);
      expect(script.summaries.length).toBeLessThanOrEqual(4); // uma escada só
      for (const request of script.requests) expect(estimated(request)).toBeLessThanOrEqual(wide);
      /** O que o provedor lê antes de qualquer histórico que muda: o catálogo e os turnos até o fim do índice. */
      const prefixOf = (request: ChatRequest): string | null => {
        const at = request.turns.findIndex((turn) => turn.role === 'user' && turn.text.startsWith('# Histórico anterior colapsado'));
        return at < 0 ? null : JSON.stringify({ tools: request.tools, turns: request.turns.slice(0, at + 1) });
      };
      const prefixes = script.requests.map(prefixOf).filter((prefix): prefix is string => prefix !== null);
      expect(prefixes.length).toBeGreaterThan(20);
      // O corte avançou (a rodada é longa demais para caber sem avançar), mas bem menos que uma vez por etapa colapsada: antes, cada etapa mudava o índice.
      const cuts = new Set(prefixes).size;
      expect(cuts).toBeGreaterThan(1);
      expect(cuts).toBeLessThanOrEqual(prefixes.length / 4);
      // Etapas consecutivas: o prefixo só muda quando o corte avança, e cada avanço é seguido de vários passos com o índice parado.
      const changes = prefixes.filter((prefix, index) => index > 0 && prefix !== prefixes[index - 1]).length;
      expect(changes).toBe(cuts - 1);
    } finally { await world.cleanup(); }
  }, 240_000);

  it('com o orçamento calibrado, o resultado que o modelo acabou de buscar chega sempre inteiro, e os antigos saem do pedido por compactação, nunca por referência', async () => {
    const world = await createRunsWorld({ tools: TOOLS, contextWindow: WINDOW });
    try {
      const bot = await world.createBot({ stepLimit: 100 }); await world.models.test('opencode/glm-5.1');
      const script = newScript(9, 1, 0.35); // o provedor simulado informa 0,35 token por byte
      scriptModel(world, script); world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Levante os esquemas.'), 'completed', 90_000);
      // Da 3ª chamada em diante há resultado de ferramenta; o último turno de ferramenta é sempre a página recém-buscada, íntegra.
      for (const request of script.requests.slice(2)) {
        const lastTool = request.turns.filter((turn) => turn.role === 'tool').at(-1)!;
        expect(lastTool.text).toContain('FIM_PAGINA_');
        expect(lastTool.text).not.toContain('aionActivityReference');
        // O que o provedor contaria de verdade (0,35 por byte) cabe na janela.
        expect(real(request, 0.35)).toBeLessThanOrEqual(INPUT_BUDGET);
      }
      for (const request of script.requests) expect(turnsText(request)).not.toContain('aionActivityReference');
      expect(script.requests.some(hasCheckpoint)).toBe(true); // 9 páginas de ~10k passam de 90% da janela: os antigos viraram checkpoint
      expect(await contextFailures(world)).toEqual([]);
    } finally { await world.cleanup(); }
  }, 120_000);

  it('"Compactar agora" libera espaço mesmo com a rodada pesada na conversa ociosa (a compactação do F3 abaixo do limiar), e a mensagem seguinte usa o checkpoint', async () => {
    const world = await createRunsWorld({ tools: TOOLS, contextWindow: WINDOW });
    try {
      const bot = await world.createBot({ stepLimit: 100 }); await world.models.test('opencode/glm-5.1');
      const script = newScript(18, 2, 0.3);
      scriptModel(world, script); world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Levante os esquemas de todos os apps conectados.'), 'completed', 120_000);
      script.phase = 'plain';
      const summariesBefore = script.summaries.length;

      const manual = await compactNow(world, bot.id);
      expect(await world.runRow(manual.run)).toMatchObject({ status: 'completed', failure_code: null });
      expect(manual.state.operation).toMatchObject({ status: 'completed', result: { changed: true } });
      expect(manual.state.operation!.result!.afterInputTokens!).toBeLessThan(manual.state.operation!.result!.beforeInputTokens!);
      // Entrada do resumo dentro do orçamento, texto das linhas cortado com o id do original, e o custo do resumo contabilizado na operação.
      const added = script.summaries.slice(summariesBefore);
      expect(added.length).toBeGreaterThanOrEqual(1);
      for (const request of added) expect(estimated(request)).toBeLessThanOrEqual(INPUT_BUDGET);
      expect(manual.state.operation!.result!.summaryUsage!.calls).toBe(added.length);
      // R6: a medição feita pela manutenção manual não grava aviso nenhum (o aviso é só da compactação AUTOMÁTICA).
      expect(manual.state.measurement!.compaction).toEqual({ elision: false, summary: false, index: false });
      const stored = (await world.pool.query<{ summary: string; ids: string[] }>('SELECT summary, covered_message_ids::text[] AS ids FROM conversation_context')).rows[0]!;
      expect(stored.summary).toBe(CHECKPOINT);
      expect(stored.ids.length).toBeGreaterThan(2);
      // A rodada estava ociosa: a mensagem do dono que a abriu pode entrar no checkpoint.
      const opening = (await world.pool.query<{ id: string }>("SELECT id::text FROM messages WHERE role='user' ORDER BY id LIMIT 1")).rows[0]!.id;
      expect(stored.ids).toContain(opening);

      const next = await world.send(bot, 'Mensagem nova depois da manutenção.');
      await world.waitForStatus(next, 'completed', 30_000);
      const last = script.requests.at(-1)!;
      expect(hasCheckpoint(last)).toBe(true);
      expect(real(last, 0.3)).toBeLessThanOrEqual(INPUT_BUDGET);
      expect(await contextFailures(world)).toEqual([]);
    } finally { await world.cleanup(); }
  }, 180_000);

  it('o piso obrigatório continua protegido: uma mensagem do dono que sozinha excede a janela falha com CONTEXT_TOO_LARGE e nada é apagado', async () => {
    const world = await createRunsWorld({ tools: TOOLS, contextWindow: WINDOW });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const script = newScript(0, 0); script.phase = 'plain';
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'é'.repeat(15_000)); // 30 mil bytes: acima de todo o orçamento de entrada sem calibração
      await world.waitForStatus(run, 'failed', 30_000);
      expect((await world.runRow(run)).failure_code).toBe('CONTEXT_TOO_LARGE');
      expect(script.requests).toHaveLength(0);
      expect((await world.pool.query("SELECT count(*) AS total FROM messages WHERE role='user'")).rows[0]!.total).toBe('1');
    } finally { await world.cleanup(); }
  }, 60_000);
});
