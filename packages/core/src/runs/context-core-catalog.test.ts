// Regressão do catálogo fixo sob pressão de contexto (phase 8; decisão do dono em 13/10/2026: função antes de custo; phase 15, passo 11: lista fixa do bot). O orçamento do catálogo
// (`fitToolCatalog`, CATALOG_SHARE) descarregava ferramentas core por LRU quando sistema + objetivo + catálogo passavam de 65% do orçamento de entrada. Hoje a lista do BOT é fixa (as portas e as
// mais usadas, `botCatalogNames`) e nunca sai. O piso (sistema + essa lista + Python) media cerca de 31,7 mil bytes com o conector liberado e o Python quando a lista padrão tinha 5 ferramentas e 16.539 bytes
// (passo 11 da phase 15, 07/11/2026; antes, com as 13 core, ~36 mil); no passo 12 a padrão passou a 3 ferramentas e 7.972 bytes (o par de rotinas saiu, `DEFAULT_MOST_USED`) e o índice da árvore foi da descrição de
// `abrir_grupo` para o sistema. As provas de pressão pressupõem o piso de antes (~76% do orçamento de 64k, 47.104, com a reserva de saída de 16.384 da phase 12, e mais que o de uma janela efetiva de 32k, 22.528, na
// estimativa sem calibração: 1 byte = 1 token, ~3,5x o real), então os bots daqui levam a memória no máximo permitido (`heavyBot`), que devolve ao sistema o peso que a lista deixou de ter.
// A menor opção de janela é 64k desde a phase 11; a janela efetiva de 32k continua possível quando o modelo tem capacidade confirmada de 32k (menor entre a escolhida e a do modelo), e é assim que as provas dela
// seguem sendo exercitadas (`coreWorld`). Regra: a lista fixa nunca sai; só as opcionais do Chat geral (`discover_tools`) disputam o espaço restante, e só depois de uma compactação aplicada (phase 12); se o piso não
// couber, o histórico é que se compacta; CONTEXT_TOO_LARGE só quando o provedor recusa de fato. Aqui o motor, o PostgreSQL e o sandbox são os reais/falsos de sempre e o modelo é roteirizado; as provas medem o pedido
// exatamente como chega ao provedor.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { ChatRejected, type ChatEvent, type ChatRequest } from '../models/chat-protocols';
import { GeneralChatService } from '../general-chat/service';
import { startFakeSandbox } from '../testing/fake-sandbox';
import { SUMMARY_SECTIONS } from './compaction';
import { CATALOG_SHARE, MAX_OUTPUT_TOKENS, SUMMARY_MAX_OUTPUT_TOKENS, contextEnvelope, estimateChatPayload } from './context-budget';
import { editMemoryTool } from './edit-memory';
import { proposeRoutineTool } from './propose-routine';
import { readAttachmentTool } from './read-attachment';
import { getRoutineTool, listRoutinesTool, proposeRoutineChangeTool } from './routine-tools';
import { searchHistoryTool } from './search-history';
import { tableTools } from './table-tools';
import { ORIGIN, createRunsWorld } from './test-support';
import { MIN_SCALE } from './token-calibration';
import { ABRIR_GRUPO, DEFAULT_MOST_USED, DISCOVER_TOOLS, READ_ACTIVITY, USE_TOOL } from './tool-discovery';
import { defineTool, type ToolHandler } from './tools';
import { updateObjectiveTool } from './update-objective';

/**
 * Capacidade confirmada simulada para o `opencode/glm-5.1` (nulo = sem capacidade, o caso real do modelo). Janela efetiva = menor entre a escolhida e este valor (`resolveContextWindow`),
 * então 32768 aqui, com a escolha de 64k, reproduz a janela efetiva de 32k que as provas de piso acima do orçamento inteiro exigem. Hoisted: o `vi.mock` abaixo roda antes dos imports.
 */
const modelCapacity = vi.hoisted(() => ({ tokens: null as number | null }));
vi.mock('../models/context-capacity', () => ({
  readModelContextCapacity: (model: string | null) => (modelCapacity.tokens !== null && model === 'opencode/glm-5.1'
    ? { provider: 'opencode_go', model, contextTokens: modelCapacity.tokens, outputTokens: null, source: 'https://exemplo.test/glm-5-1', checkedAt: '2026-10-17T00:00:00.000Z' }
    : null),
}));

/** Entrada máxima de cada janela (saída reservada pela regra da phase 12, 25% da janela até 32.768, mais a margem de 2.048): 47.104 em 64k e 22.528 em 32k, como o executor mede. */
const budgetOf = (window: number): number => contextEnvelope(window, MAX_OUTPUT_TOKENS).inputBudget;
/** O que um bot recebe com o catálogo ligado: as portas e as mais usadas (a lista fixa), sem opcional; sem conta do conector liberada ele não tem as portas do Composio. */
const BOT_CATALOG = [ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...DEFAULT_MOST_USED].sort();
/** O Chat geral não tem memória, objetivo, rotinas nem tabelas: só as core que existem lá. */
const CHAT_CATALOG = [DISCOVER_TOOLS, READ_ACTIVITY, 'search_history', 'read_attachment', 'run_python'].sort();

const names = (request: ChatRequest): string[] => (request.tools ?? []).map((tool) => tool.name).sort();
const turnsText = (request: ChatRequest): string => JSON.stringify(request.turns);
/** Estimativa sem calibração do pedido exatamente como foi enviado ao provedor. */
const estimated = (request: ChatRequest): number => estimateChatPayload(request, 'chat_completions').estimatedInputTokens;
/** Só o que não é histórico: o turno de sistema (o objetivo não existe nestes bots). */
const floorOf = (request: ChatRequest): number => estimated({ ...request, turns: request.turns.filter((turn) => turn.role === 'system') });

/** O catálogo interno padrão do motor (sem docs); `extra` entra como ferramenta de teste, fora da lista fixa (o executor a resolve pelo registry). */
const internal = (...extra: ToolHandler[]): ToolHandler[] => [searchHistoryTool, readAttachmentTool, editMemoryTool, updateObjectiveTool, proposeRoutineTool, listRoutinesTool, getRoutineTool, proposeRoutineChangeTool, ...tableTools, ...extra];

/**
 * Um bot com o piso de sempre: a memória dele, no máximo permitido (8.000 caracteres), vai no turno de sistema. Desde o passo 12 da phase 15 a lista padrão das mais usadas pesa 7.972 bytes (eram 16.539, com o par de
 * rotinas, e o piso do bot era ~36 mil bytes, ~76% do orçamento de 64k), e as provas de pressão desta suíte pressupõem esse piso; a memória o devolve ao sistema sem mexer na lista fixa que está sendo provada.
 */
async function heavyBot(world: Awaited<ReturnType<typeof coreWorld>>['world'], options: Parameters<typeof world.createBot>[0] = {}) {
  const bot = await world.createBot(options);
  await world.memory.save({ scope: 'bot', botId: bot.id }, 'Memória do dono. '.repeat(470), 0, ORIGIN);
  return bot;
}

/**
 * Mundo com o catálogo core ligado (o padrão do produto), o Python falso (completa as 13 core), a janela efetiva pedida e o modelo já testado. A janela escolhida é sempre 64k (a menor
 * opção); a efetiva de 32k vem da capacidade confirmada simulada do modelo (`modelCapacity`), que o `cleanup` desfaz.
 */
async function coreWorld(effectiveWindow: 32768 | 65536, tools?: ToolHandler[]) {
  const sandbox = await startFakeSandbox();
  modelCapacity.tokens = effectiveWindow === 32768 ? 32768 : null;
  const world = await createRunsWorld({ coreCatalog: true, contextWindow: 65536, python: { url: sandbox.url, token: sandbox.token }, ...(tools ? { tools } : {}) });
  await world.models.test('opencode/glm-5.1');
  return { world, cleanup: async () => { modelCapacity.tokens = null; await world.cleanup(); await sandbox.stop(); } };
}

describe('catálogo fixo sob pressão de contexto', () => {
  it.each([
    { owner: 'bot', window: 65536 as const, instructions: 8000, catalog: BOT_CATALOG },
    { owner: 'bot', window: 32768 as const, instructions: 0, catalog: BOT_CATALOG },
    { owner: 'Chat geral', window: 32768 as const, instructions: 0, catalog: CHAT_CATALOG },
  ])('$owner em $window sem calibração: a lista fixa publicada e a execução termina', async ({ owner, window, instructions, catalog }) => {
    const { world, cleanup } = await coreWorld(window);
    try {
      const seen: ChatRequest[] = [];
      // Sem usage no retorno: nenhuma amostra de calibração, a estimativa fica no teto de 1 byte por token durante todo o teste.
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        seen.push(structuredClone(request));
        yield { type: 'text', text: 'Pronto.' }; yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      let run: string;
      if (owner === 'bot') run = await world.send(await heavyBot(world, { instructions: 'Regra do agente do dono. '.repeat(instructions / 25) }), 'oi');
      else {
        const ref = { sessionId: (await new GeneralChatService({ pool: world.pool }).create()).id };
        await world.conversations.setPreference(ref, 'opencode/glm-5.1', null);
        run = (await world.conversations.send(ref, 'oi')).id;
      }
      await world.waitForStatus(run, 'completed');
      expect(await world.runRow(run)).toMatchObject({ status: 'completed', failure_code: null });
      const request = seen.at(-1)!;
      expect(names(request)).toEqual(catalog);
      expect(turnsText(request)).not.toContain('Schemas descarregados por espaço');
      // A premissa de cada caso: em 64k o piso passa do teto de 65% (por LRU a lista fixa sairia), em 32k passa do orçamento inteiro (só o provedor arbitra).
      if (owner === 'bot' && window === 65536) { expect(floorOf(request)).toBeGreaterThan(Math.floor(budgetOf(window) * CATALOG_SHARE)); expect(floorOf(request)).toBeLessThan(budgetOf(window)); }
      if (owner === 'bot' && window === 32768) expect(floorOf(request)).toBeGreaterThan(budgetOf(window));
      if (owner === 'Chat geral') expect(estimated(request)).toBeLessThan(budgetOf(window));
    } finally { await cleanup(); }
  }, 60_000);

  it('32k: depois da primeira chamada o usage calibra o modelo, o piso passa a caber e a lista fixa continua completa', async () => {
    const { world, cleanup } = await coreWorld(32768);
    try {
      const seen: ChatRequest[] = [];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        seen.push(structuredClone(request));
        yield { type: 'text', text: 'Pronto.' };
        yield { type: 'usage', usage: { inputTokens: Math.round(estimateChatPayload(request, 'chat_completions').textTokens * 0.34), outputTokens: 20 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      const bot = await heavyBot(world);
      await world.waitForStatus(await world.send(bot, 'primeira'), 'completed');
      await world.waitForStatus(await world.send(bot, 'segunda'), 'completed');
      expect(seen).toHaveLength(2);
      for (const request of seen) expect(names(request)).toEqual(BOT_CATALOG);
      // Primeira chamada: sem calibração o piso passa do teto (o provedor arbitra). Segunda: com a escala observada (0,34 x folga de 1,2) cabe na janela real.
      expect(estimated(seen[0]!)).toBeGreaterThan(budgetOf(32768));
      expect(estimateChatPayload(seen[1]!, 'chat_completions').textTokens * 0.34 * 1.2).toBeLessThanOrEqual(budgetOf(32768));
      expect(await world.pool.query("SELECT 1 FROM runs WHERE failure_code IS NOT NULL")).toHaveProperty('rowCount', 0);
    } finally { await cleanup(); }
  }, 60_000);

  it('o provedor é quem decide: recusa de contexto com o piso acima do teto repete a chamada ainda com a lista fixa inteira e termina em CONTEXT_TOO_LARGE', async () => {
    const { world, cleanup } = await coreWorld(32768);
    try {
      const seen: ChatRequest[] = [];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        seen.push(structuredClone(request));
        throw new ChatRejected(400, false, true);
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      const run = await world.send(await heavyBot(world), 'oi');
      await world.waitForStatus(run, 'failed');
      expect((await world.runRow(run)).failure_code).toBe('CONTEXT_TOO_LARGE');
      // A recarga não derruba a lista fixa: as duas tentativas (a original e a recarga) levam o mesmo catálogo completo.
      expect(seen).toHaveLength(2);
      for (const request of seen) expect(names(request)).toEqual(BOT_CATALOG);
    } finally { await cleanup(); }
  }, 60_000);

  it('a exceção do piso sem calibração não libera qualquer pedido: o pedido final é conferido na escala mais otimista e mensagem enorme falha sem chamar o provedor (R3)', async () => {
    const { world, cleanup } = await coreWorld(32768);
    try {
      const seen: ChatRequest[] = [];
      // Sem usage no retorno: o modelo continua sem amostra de calibração durante todo o teste.
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        seen.push(structuredClone(request));
        yield { type: 'text', text: 'Pronto.' }; yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      const bot = await heavyBot(world);
      // O piso sozinho passa do teto de 1 byte por token mas cabe na escala mais otimista: o provedor arbitra e esta chamada segue.
      await world.waitForStatus(await world.send(bot, 'oi'), 'completed');
      const floor = seen[0]!, budget = budgetOf(32768);
      expect(estimated(floor)).toBeGreaterThan(budget);
      expect(estimateChatPayload(floor, 'chat_completions', undefined, MIN_SCALE).estimatedInputTokens).toBeLessThanOrEqual(budget);
      // Mensagem no limite de 32.000 caracteres, de 3 bytes cada: nem na hipótese mais otimista cabe junto do piso.
      const huge = '漢'.repeat(32_000);
      expect(estimateChatPayload({ ...floor, turns: [floor.turns[0]!, { role: 'user', text: huge }] }, 'chat_completions', undefined, MIN_SCALE).estimatedInputTokens).toBeGreaterThan(budget);
      const run = await world.send(bot, huge);
      await world.waitForStatus(run, 'failed');
      expect((await world.runRow(run)).failure_code).toBe('CONTEXT_TOO_LARGE');
      // A falha é local: nenhuma chamada PRINCIPAL nova chegou ao provedor (a ocupação alta pode ter disparado um resumo do histórico antes, chamada à parte com `SUMMARY_MAX_OUTPUT_TOKENS`).
      expect(seen.filter((request) => request.maxTokens !== SUMMARY_MAX_OUTPUT_TOKENS)).toHaveLength(1);
    } finally { await cleanup(); }
  }, 60_000);

  it('"calibrado" é ter amostra válida, não escala menor que 1: com a razão observada alta o piso acima do teto vira CONTEXT_TOO_LARGE definitivo, sem o provedor (R3)', async () => {
    const { world, cleanup } = await coreWorld(32768);
    try {
      const seen: ChatRequest[] = [];
      // Usage igual à estimativa por bytes (razão 1,0, texto denso em tokens): amostra válida cuja escala, com a folga de 20%, fica em 1.
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        seen.push(structuredClone(request));
        yield { type: 'text', text: 'Pronto.' };
        yield { type: 'usage', usage: { inputTokens: estimateChatPayload(request, 'chat_completions').textTokens, outputTokens: 5 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      const bot = await heavyBot(world);
      // Primeira chamada: sem amostra, o piso acima do teto segue (cabe na escala mais otimista) e o usage dela vira a primeira amostra.
      await world.waitForStatus(await world.send(bot, 'primeira'), 'completed');
      expect(estimated(seen[0]!)).toBeGreaterThan(budgetOf(32768));
      // Segunda: o modelo já está calibrado (com a escala em 1), então o teto por bytes é a medida real e o piso não cabe de fato.
      const second = await world.send(bot, 'segunda');
      await world.waitForStatus(second, 'failed');
      expect((await world.runRow(second)).failure_code).toBe('CONTEXT_TOO_LARGE');
      expect(seen.filter((request) => request.maxTokens !== SUMMARY_MAX_OUTPUT_TOKENS)).toHaveLength(1);
    } finally { await cleanup(); }
  }, 60_000);

  it('64k: o histórico cede (colapso em índice) em vez de perder a lista fixa, que não muda em nenhuma etapa (A8, phase 12; lista fixa do bot, phase 15)', async () => {
    // Página de esquemas de ~7 mil caracteres, como as do conector (eram ~10 mil com o orçamento de 55.296: com o de 47.104 e o piso em ~77%, uma página de 10 mil já não cabe junto do piso e a execução
    // falharia com CONTEXT_TOO_LARGE): pressiona o histórico sem mexer no piso.
    const page = (n: number): string => JSON.stringify({ page: n, items: Array.from({ length: 20 }, (_, index) => ({ slug: `APP_ACTION_${n}_${index}`, description: 'Ação do conector com parâmetros extensos. '.repeat(3), input_parameters: { type: 'object', properties: { a: { type: 'string', description: 'campo a' }, b: { type: 'integer' } }, required: ['a'] } })), end: `FIM_PAGINA_${n}` });
    const schemaSearch = defineTool({
      definition: { name: 'schema_search', description: 'Busca esquemas de ações do conector.', parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } },
      argsSchema: z.strictObject({ q: z.string() }), resultLimitBytes: 32 * 1024, label: () => 'Buscar esquemas', execute: async ({ q }) => ({ result: page(Number(q)) }),
    });
    const { world, cleanup } = await coreWorld(65536, internal(schemaSearch));
    try {
      const seen: ChatRequest[] = [];
      let calls = 0;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        seen.push(structuredClone(request));
        const call = calls++;
        // O bot abre um grupo (a lista `tools` dele é fixa: a ferramenta de teste não é publicada, o executor a resolve pelo registry) e depois chama a busca direto pelo nome.
        if (call === 0) yield { type: 'tool_call', id: randomUUID(), name: ABRIR_GRUPO, arguments: JSON.stringify({ path: 'ferramentas/memoria' }) };
        else if (call <= 8) yield { type: 'tool_call', id: randomUUID(), name: 'schema_search', arguments: JSON.stringify({ q: String(call) }) };
        else yield { type: 'text', text: 'Levantamento concluído.' };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      // Com 8.000 caracteres de regras do agente o piso (sistema, a lista fixa e o Python) é ~76% do orçamento de 47.104: acima dos 65% do teto, abaixo de 100% e com espaço para UMA página de esquemas. Sem as
      // regras (~59%) um checkpoint aliviaria o pedido e o colapso em índice não seria preciso; aqui ele custaria o que o índice economiza.
      const bot = await heavyBot(world, { stepLimit: 100, instructions: 'Regra do agente do dono. '.repeat(320) });
      await world.waitForStatus(await world.send(bot, 'Levante os esquemas.'), 'completed', 60_000);
      expect(seen.length).toBe(10);
      const budget = budgetOf(65536);
      // O piso (sistema com as regras do agente, a lista fixa e o Python) é ~76% do orçamento: acima do teto de 65% e abaixo de 100%, então o que cede à pressão é o histórico e a lista fixa não sai.
      expect(floorOf(seen[0]!)).toBeGreaterThan(Math.floor(budget * CATALOG_SHARE));
      expect(floorOf(seen[0]!)).toBeLessThan(budget);
      for (const request of seen) {
        // Nada sai da lista fixa, em nenhuma etapa; o pedido cabe no orçamento sem calibração.
        expect(names(request)).toEqual(BOT_CATALOG);
        expect(estimated(request)).toBeLessThanOrEqual(budget);
        expect(turnsText(request)).not.toContain('Schemas descarregados por espaço');
      }
      // O histórico foi quem cedeu: com o piso em ~67% do orçamento um checkpoint não alivia (custaria o que o índice economiza), então o colapso em índice trocou os
      // resultados antigos e o resultado mais recente chegou inteiro. Nenhum resultado vira referência: a projeção por etapa deixou de existir (phase 9).
      expect(turnsText(seen.at(-1)!)).toContain('Histórico anterior colapsado');
      expect(turnsText(seen.at(-1)!)).not.toContain('aionActivityReference');
      expect(seen.at(-1)!.turns.filter((turn) => turn.role === 'tool').at(-1)!.text).toContain('FIM_PAGINA_8');
      // O catálogo é estável em toda a rodada, inclusive depois de abrir o grupo (mesmo prefixo em cache, byte a byte), e nada travou por contexto.
      expect(new Set(seen.map((request) => JSON.stringify(request.tools))).size).toBe(1);
      expect(await world.pool.query("SELECT 1 FROM runs WHERE failure_code IS NOT NULL")).toHaveProperty('rowCount', 0);
    } finally { await cleanup(); }
  }, 90_000);

  // A8 com o catálogo real (phase 12, F2; lista fixa do bot, phase 15): numa compactação aplicada a lista do bot NÃO muda (não há opcional publicada para o teto de 65% retirar, que é coisa do Chat geral e está provada em
  // `tool-discovery.test.ts`), mesmo com o piso (sistema + lista) acima do próprio teto. O histórico sintético (~21 mil caracteres, em linhas de rodadas anteriores) leva a ocupação além dos 90% do orçamento de 64k e a compactação automática é aplicada no pedido seguinte.
  it('64k: a compactação aplicada não muda a lista fixa do bot nem o que o grupo aberto trouxe, e não há aviso de ferramentas descarregadas', async () => {
    const { world, cleanup } = await coreWorld(65536);
    try {
      await world.models.test('opencode/glm-5.1');
      const seen: ChatRequest[] = [];
      let summaries = 0, openNext = true;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        if (request.turns[0]?.role === 'system' && request.turns[0].text.startsWith('Você produz o checkpoint do histórico')) {
          summaries += 1;
          yield { type: 'text', text: SUMMARY_SECTIONS.map((title, index) => `## ${title}\n${index === 0 ? 'Checkpoint do histórico antigo.' : 'Nada.'}`).join('\n\n') };
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }; yield { type: 'done', reason: 'stop' }; return;
        }
        seen.push(structuredClone(request));
        if (openNext) { openNext = false; yield { type: 'tool_call', id: randomUUID(), name: ABRIR_GRUPO, arguments: JSON.stringify({ path: 'ferramentas/memoria' }) }; yield { type: 'done', reason: 'stop' }; return; }
        yield { type: 'text', text: 'Pronto.' }; yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      const bot = await heavyBot(world);
      await world.waitForStatus(await world.send(bot, 'Primeiro pedido.'), 'completed');
      // Antes da compactação: a lista fixa, e abrir o grupo não a mexe (o esquema vai para o fim do histórico).
      expect(names(seen[0]!)).toEqual(BOT_CATALOG);
      expect(JSON.stringify(seen[1]!.tools)).toBe(JSON.stringify(seen[0]!.tools));
      expect(turnsText(seen[1]!)).not.toContain('Schemas descarregados por espaço');
      expect(summaries).toBe(0);
      const published = JSON.stringify(seen[1]!.tools);
      // Histórico anterior que leva o pedido a 90%: a compactação é aplicada e o pedido dessa mesma etapa sai com a MESMA lista, byte a byte.
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      for (let index = 0; index < 6; index++) await world.pool.query("INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,$2,now())", [conversationId, `Histórico ${index}: ${'a'.repeat(3500)}`]);
      await world.waitForStatus(await world.send(bot, 'Segundo pedido.'), 'completed');
      expect(summaries).toBe(1);
      const after = seen.at(-1)!;
      expect(names(after)).toEqual(BOT_CATALOG);
      expect(JSON.stringify(after.tools)).toBe(published);
      expect(turnsText(after)).not.toContain('Schemas descarregados por espaço');
      // Depois dela, etapas e rodadas seguintes: mesmo campo e nenhum aviso, e nenhuma compactação nova.
      await world.waitForStatus(await world.send(bot, 'Terceiro pedido.'), 'completed');
      await world.waitForStatus(await world.send(bot, 'Quarto pedido.'), 'completed');
      expect(summaries).toBe(1);
      const noticeAt = (request: ChatRequest) => request.turns.findIndex((turn) => turn.text.startsWith('# Catálogo publicado'));
      for (const request of seen.slice(-2)) expect({ tools: JSON.stringify(request.tools), notice: noticeAt(request) }).toEqual({ tools: JSON.stringify(after.tools), notice: noticeAt(after) });
    } finally { await cleanup(); }
  }, 90_000);
});
