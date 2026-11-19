// Exposição das ferramentas no worker real. Duas variantes (phase 15, passo 11): o BOT tem a lista `tools` fixa (portas e mais usadas) e a árvore de grupos (`abrir_grupo` + `use_tool`), e o CHAT GERAL segue com
// `discover_tools`: seleção durável e acumulativa (o catálogo só cresce na conversa e só uma compactação retira opcional, phase 12) sem alterar handlers ou aprovação. Os testes de seleção (A5 a A8, rede de
// segurança, reinício) rodam numa sessão do Chat geral; os da árvore, da porta `use_tool` e da lista fixa, no bot.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { PROTOCOLS, type ChatEvent, type ChatProtocol, type ChatRequest, type ChatTool, type ChatTurn } from '../models/chat-protocols';
import { SUMMARY_SECTIONS } from './compaction';
import { CATALOG_SHARE, MAX_OUTPUT_TOKENS, contextEnvelope, estimateChatPayload } from './context-budget';
import { createRunsWorld, ORIGIN } from './test-support';
import { readTokenCalibration } from './token-calibration';
import { defineTool, type ToolHandler } from './tools';
import { GeneralChatService } from '../general-chat/service';
import { ABRIR_GRUPO, CONNECTOR_PORTS, DEFAULT_MOST_USED, DISCOVER_TOOLS, MOST_USED_MAX_BYTES, MOST_USED_MAX_TOOLS, MOST_USED_TOGETHER, READ_ACTIVITY, RESERVED_RUNTIME_TOOLS, TOOL_TREE, USE_TOOL, USE_TOOL_UNREACHABLE, abrirGrupoTool, assertRuntimeToolNames, assertToolTree, botCatalogNames, groupOpeningResults, parseGroupOpening, readToolSelectionHistory, resolveMostUsed, resolveTreePath, selectCatalog, selectMostUsed, selectedBeforeCut, treeIndex, ungroupedTools, useToolPort, type ToolGroup } from './tool-discovery';
import type { Bot } from '@aion/shared';
import { commitContextSummary, loadManagedContext } from './context-checkpoint';
import { mergeEvidence } from './evidence-provenance';
import { NOT_EXECUTED_RESULTS } from '../approvals/service';
import { DocService } from '../docs';
import { buildTurns, fullResultForModel, resultForModel, RESULT_PROMPT_MAX_CHARS, type ContextRow } from './context';
import { INTERRUPTED_CALL_RESULT } from './activity-read';
import { COLD_AFTER_MS, COLD_MASK_MIN_CHARS, readMostUsedAnchor } from './cold-maintenance';
import { COMPOSIO_EXECUTE_TOOL, COMPOSIO_SEARCH_TOOL } from './composio-tools';
import { INTERNAL_TOOLS } from './engine';
import { attachmentBlock } from './untrusted-content';
import { startFakeSandbox } from '../testing/fake-sandbox';
import { RUN_PYTHON_TOOL } from './run-python';
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from './web-tools';

/** Ferramenta de teste volumosa prova economia do catálogo, sem valores reais nem mudança de autorização. */
function localTool(name: string, botOnly = false, descriptionRepeats=150) {
  return defineTool({ definition: { name, description: `Responsabilidade ${name}. ` + 'regra completa '.repeat(descriptionRepeats), parameters: { type: 'object', properties: { payload: { type: 'string' } }, additionalProperties: false } }, argsSchema: z.strictObject({ payload: z.string().optional() }), botOnly, label: () => name, execute: async ({ payload }) => ({ result: payload ?? 'confirmado' }) });
}
/** O modelo falso chama schemas nativos; nenhum efeito passa por proxy de execução ou inferência real. */
function event(name: string, args: unknown): ChatEvent { return { type: 'tool_call', id: randomUUID(), name, arguments: JSON.stringify(args) }; }
/** O campo `tools` exatamente como o adaptador do protocolo o serializa no corpo enviado ao provedor: a base de "idêntico em bytes" (phase 12, A5 a A7). */
const toolsBytes = (protocol: ChatProtocol, request: ChatRequest): string => JSON.stringify(PROTOCOLS[protocol].body(request).tools ?? null);
/** Nomes do campo `tools` de um pedido, na ordem em que seguem para o provedor. */
const toolNames = (request: ChatRequest): string[] => (request.tools ?? []).map((tool) => tool.name);
type World = Awaited<ReturnType<typeof createRunsWorld>>;
/**
 * Uma sessão do Chat geral no `opencode/glm-5.1` (o modelo precisa estar testado no mundo). O catálogo com `discover_tools` (selecionar opcionais, acumular, teto e rede de segurança) é do Chat geral desde a phase 15
 * (decisão 26): `send` envia uma mensagem à sessão e devolve a execução; `conversationId` é a conversa dela.
 */
async function chatSession(world: World): Promise<{ send: (text: string) => Promise<string>; conversationId: string }> {
  const session = await new GeneralChatService({ pool: world.pool }).create();
  await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
  return { send: async (text) => (await world.conversations.send({ sessionId: session.id }, text)).id, conversationId: session.id };
}

describe('descoberta durável de ferramentas (Chat geral) e lista fixa (bot)', () => {
  it('schemas nativos chegam aos três protocolos: o bot publica a lista fixa e o Chat geral seleciona por discover_tools, com o índice excluindo botOnly', async () => {
    const world = await createRunsWorld({ tools: [localTool('source'), localTool('bot_only', true)] });
    try {
      for (const model of ['opencode/glm-5.1', 'opencode/kimi-k2.7-code', 'opencode/grok-4.7']) await world.models.test(model);
      world.engine.start();
      const original = world.provider.streamChat.bind(world.provider); let choose = true; const indexes: string[] = [];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (key, protocol, request, signal) {
        indexes.push(request.tools?.find((tool) => tool.name === DISCOVER_TOOLS)?.description ?? '');
        if (choose && request.tools?.some((tool) => tool.name === DISCOVER_TOOLS)) { choose = false; yield event(DISCOVER_TOOLS, { names: ['source'] }); yield { type: 'done', reason: 'stop' }; }
        else yield* original(key, protocol, request, signal);
      });
      const wireNames = (conversationId: string, wrapped: boolean): (string | undefined)[] => {
        const body = world.upstreams.requests.findLast((entry) => entry.sessionId === conversationId)!.body!, tools = body.tools as { name?: string; function?: { name: string } }[];
        return tools.map((tool) => (wrapped ? tool.function?.name : tool.name));
      };
      for (const [model, wrapped] of [['opencode/glm-5.1', true], ['opencode/kimi-k2.7-code', false], ['opencode/grok-4.7', false]] as const) {
        // Bot: a mesma lista fixa nos três formatos de protocolo (nenhuma ferramenta de teste entra: ela não está nos mais usadas).
        const bot = await world.createBot({ model });
        const run = await world.send(bot, 'Olá'); await world.waitForStatus(run, 'completed');
        expect(wireNames(await world.conversations.conversationIdOf(bot.id), wrapped)).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY]);
        // Chat geral com o mesmo modelo: a seleção acrescenta a ferramenta nos três formatos.
        const session = await new GeneralChatService({ pool: world.pool }).create();
        await world.conversations.setPreference({ sessionId: session.id }, model, null); choose = true;
        await world.waitForStatus((await world.conversations.send({ sessionId: session.id }, 'Olá')).id, 'completed');
        expect(wireNames(session.id, wrapped)).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'source']);
      }
      expect(indexes.at(-1)).toContain('source:'); expect(indexes.at(-1)).not.toContain('bot_only:');
    } finally { await world.cleanup(); }
  });

  // A6 (phase 12, F2): a seleção ACUMULA. Antes ela substituía a anterior e `names:[]` descarregava; agora a nova entra no fim, repetir e `names:[]` não mudam nada e nada sai.
  it('Chat geral: publica índice compacto e acumula as seleções: a nova entra no fim, repetir, names:[] e a falha não mudam nada; payload confirmado continua intacto', async () => {
    // Cada ferramenta tem ~15 mil caracteres: juntas pesam bem mais que o índice compacto das portas, e com a escala calibrada (0,36) cabem no orçamento de 64k (47.104).
    const tools = [localTool('first_source', false, 1000), localTool('second_source', false, 1000)], world = await createRunsWorld({ contextWindow: 65536, tools });
    try {
      await world.models.test('opencode/glm-5.1'); const { send } = await chatSession(world);
      const payload = '😀<dado>'.repeat(700), requests: { tools: ChatTool[]; turns: ChatTurn[]; bytes: string }[] = [];
      // A ordem do registry é first, second; o modelo seleciona primeiro a segunda: a lista publicada segue a ordem da PRIMEIRA SELEÇÃO, não a do registry.
      const calls = [event(DISCOVER_TOOLS, { names: ['second_source'] }), event('second_source', { payload }), event(DISCOVER_TOOLS, { names: ['first_source'] }), event('first_source', {}), event(DISCOVER_TOOLS, { names: ['missing'] }), event(DISCOVER_TOOLS, { names: [] }), event(DISCOVER_TOOLS, { names: ['second_source'] })];
      let step = 0;
      // Usage realista (30% da estimativa crua do pedido, como um provedor de verdade): o motor calibra a escala já na primeira chamada e a estimativa do pedido deixa de ser o
      // teto de 1 token por byte, que com os dois schemas e o payload de 14 KB no histórico passaria do orçamento de 64k (CONTEXT_TOO_LARGE) sem que a prova seja disso.
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, protocol, request) { requests.push({ tools: request.tools ?? [], turns: request.turns, bytes: toolsBytes(protocol, request) }); const call = calls[step++]; if (call) yield call; else yield { type: 'text', text: 'Concluído' }; yield { type: 'usage', usage: { inputTokens: Math.round(estimateChatPayload(request, 'chat_completions').textTokens * 0.3), outputTokens: 5 } }; yield { type: 'done', reason: 'stop' }; });
      world.engine.start(); const run = await send('Selecionar e executar'); await world.waitForStatus(run, 'completed');
      const names = (index: number) => requests[index]!.tools.map((tool) => tool.name);
      expect(names(0)).toEqual([DISCOVER_TOOLS, READ_ACTIVITY]);
      expect(Buffer.byteLength(JSON.stringify(requests[0]!.tools))).toBeLessThan(Buffer.byteLength(JSON.stringify(tools.map((tool) => tool.definition))) / 4);
      // Depois de selecionar a segunda, ela chega já na etapa seguinte; selecionar a primeira a põe DEPOIS dela (ordem da seleção), e as anteriores mantêm o lugar.
      expect(names(1)).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'second_source']);
      expect(names(2)).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'second_source']);
      expect(names(3)).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'second_source', 'first_source']);
      // Nada sai depois: a seleção inexistente (falha), `names:[]` e repetir uma já selecionada deixam o campo `tools` idêntico em bytes, até o fim da execução.
      expect(requests).toHaveLength(8);
      for (const request of requests.slice(3)) expect(request.bytes).toBe(requests[3]!.bytes);
      expect(requests[3]!.turns.some((turn) => turn.text.includes('Schemas descarregados por espaço'))).toBe(false);
      // A seleção válida e a falha ficam no histórico; só a válida conta para o catálogo, e o resultado do que falhou não o altera.
      expect((await readToolSelectionHistory(world.pool, run)).names).toEqual(['second_source', 'first_source']);
      const original = (await world.pool.query<{ content: string; tool_arguments: string }>("SELECT content,tool_arguments FROM messages WHERE run_id=$1 AND data->>'tool'='second_source'", [run])).rows[0]!;
      expect(original.content).toBe(payload); expect(JSON.parse(original.tool_arguments)).toEqual({ payload });
      const historical = requests.at(-1)!.turns.flatMap((turn) => turn.role === 'assistant' ? turn.toolCalls : []).find((call) => call.name === 'second_source')!;
      // Argumentos de resultados antigos voltam como foram gravados em todo pedido (forma única, CTX-10): só o colapso de último recurso os troca por referência.
      expect(JSON.parse(historical.arguments)).toEqual({ payload });
      // A seleção vale para a conversa: a execução seguinte começa já com as duas, na mesma ordem e com os mesmos bytes, sem nova descoberta paga.
      step = calls.length; const second = await send('Outra execução'); await world.waitForStatus(second, 'completed'); expect(requests.at(-1)!.bytes).toBe(requests[3]!.bytes);
      // Sem capacidade de recuperação, o modelo recebe os argumentos originais, nunca referências inacessíveis.
      await world.pool.query("UPDATE model_profiles SET test_status='no_tools' WHERE model_id='opencode/glm-5.1'");
      const withoutTools = await send('Sem ferramentas'); await world.waitForStatus(withoutTools, 'completed');
      expect(requests.at(-1)!.tools).toEqual([]);
      const oldCall = requests.at(-1)!.turns.flatMap((turn) => turn.role === 'assistant' ? turn.toolCalls : []).find((call) => call.name === 'second_source')!;
      expect(JSON.parse(oldCall.arguments)).toEqual({ payload }); expect(JSON.stringify(requests.at(-1)!.turns)).not.toContain('aionActivityReference');
    } finally { await world.cleanup(); }
  });

  // A5 e A6 (phase 12, F2): pedidos reais do motor, capturados no provedor falso com o corpo que o adaptador serializa. Os dois schemas pesam ~27 mil caracteres: com a escala em 1 sistema + catálogo (~35 mil) passam
  // de 65% do orçamento de 64k (30.617) e o motor de antes o retiraria; com a escala calibrada baixa, não. O provedor falso devolve razões de usage diferentes a cada chamada, então a escala muda
  // de uma etapa para a outra (aqui, de 0,36 a 1): o campo `tools` não pode mudar junto.
  it('Chat geral, A5/A6: o campo tools é idêntico em bytes entre etapas e rodadas sem descoberta, mesmo com a escala de calibração mudando, e depois de uma descoberta só cresce no fim', async () => {
    const world = await createRunsWorld({ contextWindow: 65536, tools: [localTool('alpha_source', false, 900), localTool('beta_source', false, 900)] });
    try {
      await world.models.test('opencode/glm-5.1'); const { send } = await chatSession(world);
      // Cada rodada responde com o roteiro dela; `ratios` é a razão usage ÷ estimativa de CADA chamada, em ordem (o motor usa a MAIOR das últimas 20 vezes 1,2).
      const rounds: ChatEvent[][] = [[event(DISCOVER_TOOLS, { names: ['alpha_source'] })], [], [], [event(DISCOVER_TOOLS, { names: ['beta_source'] })], [event(DISCOVER_TOOLS, { names: ['alpha_source'] })], [event(DISCOVER_TOOLS, { names: [] })]];
      const ratios = [0.3, 0.3, 0.55, 0.9, 0.2, 0.7, 0.4, 0.95, 0.3, 0.3], seen: { round: number; bytes: string; names: string[]; scale: number; notice: boolean }[] = [];
      let round = 0, call = 0, perRound = 0;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, protocol, request) {
        const scale = (await readTokenCalibration(world.pool, 'opencode/glm-5.1')).scale;
        seen.push({ round, bytes: toolsBytes(protocol, request), names: toolNames(request), scale, notice: request.turns.some((turn) => turn.text.includes('Schemas descarregados por espaço')) });
        // Cada rodada faz as chamadas de ferramenta do roteiro e fecha com texto.
        const scripted = rounds[round]![perRound++];
        if (scripted) yield scripted; else { yield { type: 'text', text: `Rodada ${round}` }; perRound = 0; }
        yield { type: 'usage', usage: { inputTokens: Math.round(estimateChatPayload(request, 'chat_completions').textTokens * ratios[call++ % ratios.length]!), outputTokens: 5 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      for (round = 0; round < rounds.length; round++) { perRound = 0; await world.waitForStatus(await send(`Mensagem ${round}`), 'completed'); }
      const at = (index: number) => seen[index]!;
      // Rodada 0: descoberta da alpha (1ª chamada só com as portas; a 2ª já com a alpha no fim).
      expect(at(0).names).toEqual([DISCOVER_TOOLS, READ_ACTIVITY]);
      expect(at(1).names).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'alpha_source']);
      // Rodadas 1 e 2 e a etapa de descoberta da rodada 3 (sem nada novo): campo idêntico em bytes ao da etapa que veio depois da descoberta, com escalas de calibração diferentes entre elas.
      const afterAlpha = seen.filter((entry) => entry.round >= 1 && entry.round <= 3 && entry.names.length === 3);
      expect(afterAlpha).toHaveLength(3);
      for (const entry of afterAlpha) expect(entry.bytes).toBe(at(1).bytes);
      expect(new Set([at(1), ...afterAlpha].map((entry) => entry.scale)).size).toBeGreaterThanOrEqual(3);
      // Rodada 3: a beta entra no FIM, as anteriores mantêm a ordem (o campo anterior é prefixo do novo, na lista JSON).
      const withBeta = seen.filter((entry) => entry.names.includes('beta_source'));
      expect(withBeta.length).toBeGreaterThanOrEqual(3);
      for (const entry of withBeta) {
        expect(entry.names).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'alpha_source', 'beta_source']);
        expect(entry.bytes).toBe(withBeta[0]!.bytes);
        expect(entry.bytes.startsWith(at(1).bytes.slice(0, -1))).toBe(true);
      }
      // Selecionar de novo a alpha (rodada 4) e `names:[]` (rodada 5) não mudam nada, e em nenhum pedido há aviso de omissão (nada foi compactado).
      expect(seen.filter((entry) => entry.round >= 4).every((entry) => entry.bytes === withBeta[0]!.bytes)).toBe(true);
      expect(seen.some((entry) => entry.notice)).toBe(false);
      expect((await readToolSelectionHistory(world.pool, String((await world.pool.query<{ id: string }>('SELECT max(id)::text AS id FROM runs')).rows[0]!.id))).names).toEqual(['alpha_source', 'beta_source']);
    } finally { await world.cleanup(); }
  }, 60_000);

  // A7 (phase 12, F2, decisão 9; lista fixa do bot, phase 15): a pesquisa na web e as contas do Composio só mudam o campo `tools` do BOT quando o conteúdo muda. Cada estado vale por duas execuções (a segunda
  // relê o interruptor no banco; o conector vem do cache de 60 s da fonte, e a releitura depois do ttl é provada em composio-tools.test.ts): o campo é idêntico dentro do estado, muda uma única vez a cada
  // mudança real e, voltando ao estado de antes, volta aos MESMOS bytes. No bot a web não é publicada: ela mora no grupo ferramentas/web, e o que muda é o índice da árvore, que vive no turno de SISTEMA
  // (passo 12: a descrição de abrir_grupo não o leva mais, então ligar ou desligar a web nem toca o campo tools); as portas do conector entram e saem da lista fixa com a conta liberada (decisão 24).
  it('A7: o interruptor da web e a conta do Composio mudam o campo tools do bot só quando mudam; recarregar as fontes sem mudança de conteúdo não muda um byte', async () => {
    const world = await createRunsWorld({ webSearch: true });
    try {
      await world.connectComposio();
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      await world.releaseConnectorAccounts(bot);
      const seen: { state: string; bytes: string; names: string[]; system: string }[] = [];
      let state = '';
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, protocol, request) {
        seen.push({ state, bytes: toolsBytes(protocol, request), names: toolNames(request), system: request.turns[0]?.text ?? '' });
        yield { type: 'text', text: 'Ok' };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      const runTwice = async (label: string) => { state = label; for (const text of ['primeira', 'segunda']) await world.waitForStatus(await world.send(bot, `${label}: ${text}`), 'completed'); };
      const of = (label: string) => seen.filter((entry) => entry.state === label);
      const stable = (label: string) => { const entries = of(label); expect(entries.length).toBeGreaterThanOrEqual(2); for (const entry of entries.slice(1)) expect(entry.bytes, label).toBe(entries[0]!.bytes); return entries.at(-1)!; };
      const ports = [ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY];
      const WEB_LINE = '\n- ferramentas/web: ';
      // Web ligada e Composio conectado: as duas portas do conector estão na lista fixa e o índice da árvore tem o grupo da web.
      await runTwice('web e Composio');
      const both = stable('web e Composio');
      expect(both.names).toEqual([...ports, ...CONNECTOR_PORTS]);
      expect(both.system).toContain(WEB_LINE); // a linha do índice; o guia do sistema cita o caminho em qualquer estado
      // Web desligada: a lista de nomes e o campo tools não mudam (a web nunca foi publicada e o índice não está nas definições), mas o sistema perde o grupo dela nesta execução e na seguinte, sem mais nenhuma mudança.
      await world.pool.query('UPDATE app_settings SET web_search_enabled = false');
      await runTwice('sem web');
      const noWeb = stable('sem web');
      expect(noWeb.names).toEqual([...ports, ...CONNECTOR_PORTS]);
      expect(noWeb.system).not.toContain(WEB_LINE);
      expect(noWeb.system).not.toBe(both.system);
      expect(noWeb.bytes).toBe(both.bytes);
      // Composio desconectado (e a web ainda desligada): só as portas de exposição.
      await world.credentials.disconnect('connector', ORIGIN);
      await runTwice('sem nada');
      const nothing = stable('sem nada');
      expect(nothing.names).toEqual(ports);
      expect(nothing.system).not.toContain('\n- conector/composio: ');
      expect(nothing.bytes).not.toBe(both.bytes);
      // Web religada: o grupo volta ao índice do sistema, sem o Composio, e o campo tools segue o mesmo.
      await world.pool.query('UPDATE app_settings SET web_search_enabled = true');
      await runTwice('só web');
      const onlyWeb = stable('só web');
      expect(onlyWeb.names).toEqual(ports);
      expect(onlyWeb.system).toContain(WEB_LINE);
      expect(onlyWeb.system).not.toBe(nothing.system);
      expect(onlyWeb.bytes).toBe(nothing.bytes);
      // Composio reconectado: o campo e o sistema voltam aos bytes do primeiro estado (descrição com os apps ordenados por slug, mesmas definições).
      await world.connectComposio();
      await runTwice('de volta');
      expect(stable('de volta').bytes).toBe(both.bytes);
      expect(stable('de volta').system).toBe(both.system);
      expect(both.bytes).toContain('Apps conectados: Github (github), Gmail (gmail)');
    } finally { await world.cleanup(); }
  }, 90_000);

  // A8 (phase 12, F2, decisão 10): o teto de 65% (CATALOG_SHARE) só retira opcional DEPOIS de uma compactação aplicada, e só a que ela deixou para trás. A `big_source` pesa ~25 mil caracteres: com
  // sistema e portas (~8 mil) passa do teto de 64k (30.617), então o motor de antes a retiraria assim que fosse selecionada; agora ela segue no campo `tools` em todas as etapas até o checkpoint, sai
  // junto com ele (a compactação já reescreveu o prefixo), o aviso fica idêntico depois disso e selecioná-la de novo a protege até a compactação seguinte. As portas ficam em todo pedido.
  it('Chat geral, A8: o teto de 65% do orçamento só retira opcional numa compactação aplicada; antes dela a selecionada fica, depois o aviso e o campo ficam estáveis e selecionar de novo a devolve', async () => {
    const world = await createRunsWorld({ contextWindow: 65536, tools: [localTool('big_source', false, 1700)] });
    try {
      await world.models.test('opencode/glm-5.1'); const { send, conversationId: chatId } = await chatSession(world);
      const budget = contextEnvelope(65536, MAX_OUTPUT_TOKENS).inputBudget, cap = Math.floor(budget * CATALOG_SHARE);
      const checkpoint = SUMMARY_SECTIONS.map((title, index) => `## ${title}\n${index === 0 ? 'Checkpoint do histórico antigo; ids preservados.' : 'Nada.'}`).join('\n\n');
      const isSummary = (request: ChatRequest) => request.turns[0]?.role === 'system' && request.turns[0].text.startsWith('Você produz o checkpoint do histórico');
      const noticeOf = (request: ChatRequest) => request.turns.findIndex((turn) => turn.text.startsWith('# Catálogo publicado nesta etapa'));
      const mains: { bytes: string; names: string[]; notice: string | null; noticeAt: number; floor: number }[] = [], summaries: ChatRequest[] = [];
      let discoverNext = false;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, protocol, request): AsyncGenerator<ChatEvent> {
        if (isSummary(request)) { summaries.push(request); yield { type: 'text', text: checkpoint }; }
        else {
          const at = noticeOf(request);
          mains.push({ bytes: toolsBytes(protocol, request), names: toolNames(request), notice: at === -1 ? null : request.turns[at]!.text, noticeAt: at, floor: estimateChatPayload({ ...request, turns: [request.turns[0]!] }, 'chat_completions').estimatedInputTokens });
          // O modelo seleciona a big_source na primeira etapa pedida (`discoverNext`) e responde com texto na seguinte.
          if (discoverNext) { discoverNext = false; yield event(DISCOVER_TOOLS, { names: ['big_source'] }); yield { type: 'done', reason: 'stop' }; return; }
          yield { type: 'text', text: 'Ok.' };
        }
        // Usage implausível de propósito (100 tokens): nenhuma amostra de calibração, então a escala fica em 1 e o pedido é o do teto conservador, igual em toda etapa.
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      discoverNext = true;
      const first = await send('Início da conversa.'); await world.waitForStatus(first, 'completed');
      const conversationId = chatId;
      // Antes da compactação: a big_source segue publicada mesmo com sistema + catálogo acima do teto de 65% (o motor de antes a retiraria na etapa seguinte à seleção).
      expect(mains.map((entry) => entry.names)).toEqual([[DISCOVER_TOOLS, READ_ACTIVITY], [DISCOVER_TOOLS, READ_ACTIVITY, 'big_source']]);
      expect(mains[1]!.floor).toBeGreaterThan(cap);
      expect(mains[1]!.notice).toBeNull();
      const published = mains[1]!.bytes;
      // O histórico cresce em linhas gravadas (a rodada já concluída) até a ocupação chegar a 90% e UMA compactação ser aplicada. Em nenhuma etapa antes dela a lista muda.
      let step = 100;
      const iterate = async (text: string) => {
        for (let index = 0; index < 2; index++) {
          await world.pool.query(
            `INSERT INTO messages(conversation_id,run_id,role,kind,status,opens_round,step,content,data,tool_arguments,evidence_provenance,created_at)
             VALUES($1,$2,'assistant','text','done',false,$3,$4,'{}','{}','{"attachments":[],"tables":[]}',now())`,
            [conversationId, first, step++, `texto ${step} `.padEnd(600, 'x')]);
        }
        const summariesBefore = summaries.length;
        await world.waitForStatus(await send(text), 'completed');
        return summaries.length > summariesBefore;
      };
      let compacted = false;
      for (let index = 0; index < 40 && !compacted; index++) {
        compacted = await iterate(`Mensagem ${index}.`);
        if (!compacted) expect(mains.at(-1)!.bytes).toBe(published);
      }
      expect(compacted).toBe(true);
      expect(summaries).toHaveLength(1);
      // Na etapa que compactou a opcional sai com o aviso (o prefixo já foi reescrito); as portas ficam.
      const afterCompaction = mains.at(-1)!;
      expect(afterCompaction.names).toEqual([DISCOVER_TOOLS, READ_ACTIVITY]);
      expect(afterCompaction.notice).toContain('Schemas descarregados por espaço: big_source.');
      expect(afterCompaction.noticeAt).toBe(1);
      // Depois da compactação, etapa e rodada seguintes: o campo e o aviso (texto e posição) são idênticos, e nada é compactado de novo.
      await world.waitForStatus(await send('Depois da compactação.'), 'completed');
      await world.waitForStatus(await send('Outra rodada.'), 'completed');
      expect(summaries).toHaveLength(1);
      for (const entry of mains.slice(-2)) expect({ bytes: entry.bytes, notice: entry.notice, at: entry.noticeAt }).toEqual({ bytes: afterCompaction.bytes, notice: afterCompaction.notice, at: 1 });
      // O histórico de seleções não muda: a big_source continua registrada como selecionada, só não é mais exposta.
      expect((await readToolSelectionHistory(world.pool, first)).names).toEqual(['big_source']);
      // Selecionar de novo a protege até a compactação seguinte: volta ao campo (no lugar da primeira seleção), o aviso some e fica estável.
      discoverNext = true;
      await world.waitForStatus(await send('Preciso da big_source de novo.'), 'completed');
      const reselected = mains.slice(-2);
      expect(reselected[0]!.names).toEqual([DISCOVER_TOOLS, READ_ACTIVITY]);
      expect(reselected[1]!.names).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'big_source']);
      expect(reselected[1]!.bytes).toBe(published);
      expect(reselected[1]!.notice).toBeNull();
      await world.waitForStatus(await send('E mais uma.'), 'completed');
      expect(mains.at(-1)!.bytes).toBe(published);
      expect(summaries).toHaveLength(1);
    } finally { await world.cleanup(); }
  }, 120_000);

  // Rede de segurança do catálogo (phase 12, F2): a opcional selecionada só sai fora da compactação quando a única saída seria recusar o pedido (CONTEXT_TOO_LARGE). Aí ela sai SÓ daquele pedido (a mesma
  // regra da recarga depois da recusa do provedor), com o aviso de omitidas, e a execução segue; antes da phase 12 o teto de 65% a retirava na hora e a execução nunca travava por causa dela. Sem histórico
  // a compactar nos dois casos: (1) a opcional sozinha passa do orçamento (piso acima de 100%); (2) o piso cabe, mas piso + a mensagem do dono, que o colapso nunca tira, não cabem.
  it.each([
    { caminho: 'o piso com a opcional passa do orçamento', optionalRepeats: 11000, message: 'Selecionar e executar', followUpSameRequest: true },
    { caminho: 'o piso cabe, mas piso e mensagem do dono não', optionalRepeats: 6700, message: 'm'.repeat(32_000), followUpSameRequest: false },
  ])('Chat geral, rede de segurança: a opcional selecionada que impede o pedido de caber ($caminho) sai só daquele pedido, com o aviso, em vez de CONTEXT_TOO_LARGE', async ({ optionalRepeats, message, followUpSameRequest }) => {
    const world = await createRunsWorld({ contextWindow: 65536, tools: [localTool('huge_source', false, optionalRepeats)] });
    try {
      await world.models.test('opencode/glm-5.1'); const { send } = await chatSession(world);
      const requests: { names: string[]; notice: string | null; bytes: string }[] = [];
      const noticeOf = (request: ChatRequest) => request.turns.find((turn) => turn.text.startsWith('# Catálogo publicado nesta etapa'))?.text ?? null;
      let step = 0;
      // Usage realista (30% da estimativa crua): o motor calibra a escala (0,36) já na primeira chamada, então a recusa local por tamanho é definitiva (CONTEXT_TOO_LARGE) se nada sair.
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, protocol, request) {
        requests.push({ names: toolNames(request), notice: noticeOf(request), bytes: toolsBytes(protocol, request) });
        if (step++ === 0) yield event(DISCOVER_TOOLS, { names: ['huge_source'] }); else yield { type: 'text', text: 'Concluído' };
        yield { type: 'usage', usage: { inputTokens: Math.round(estimateChatPayload(request, 'chat_completions').textTokens * 0.3), outputTokens: 5 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      const run = await send(message); await world.waitForStatus(run, 'completed');
      expect((await world.runRow(run)).failure_code).toBeNull();
      // A seleção valeu e continua registrada, mas a etapa seguinte sai sem a opcional e com o aviso (antes da seleção, o pedido não tinha nenhum dos dois).
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ names: [DISCOVER_TOOLS, READ_ACTIVITY], notice: null });
      expect(requests[1]!.names).toEqual([DISCOVER_TOOLS, READ_ACTIVITY]);
      expect(requests[1]!.notice).toContain('Schemas descarregados por espaço: huge_source.');
      expect((await readToolSelectionHistory(world.pool, run)).names).toEqual(['huge_source']);
      // A rodada seguinte segue sem recusa. No caso (1) nada muda (a opcional continua sozinha acima do orçamento): campo e aviso idênticos. No caso (2) o colapso do histórico antigo já basta, então a
      // rede de segurança nem é chamada e a opcional volta ao pedido (só sai quando a única saída é recusar).
      const second = await send('Outra rodada'); await world.waitForStatus(second, 'completed');
      expect((await world.runRow(second)).failure_code).toBeNull();
      if (followUpSameRequest) expect(requests.at(-1)).toMatchObject({ names: [DISCOVER_TOOLS, READ_ACTIVITY], notice: requests[1]!.notice, bytes: requests[1]!.bytes });
      else expect(requests.at(-1)!.names).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'huge_source']);
    } finally { await world.cleanup(); }
  }, 60_000);

  it('Chat geral: restart/aprovação mantém seleção e execução original; oferta não é autorização nem contorno de limite', async () => {
    let effects = 0;
    const dangerous = defineTool({ definition: { name: 'dangerous', description: 'Operação destrutiva local.', parameters: { type: 'object', additionalProperties: false } }, argsSchema: z.strictObject({}), approvalRequired: true, action: { slug: 'TEST_DANGEROUS', label: 'Destrutiva', appSlug: 'local', appName: 'Local' }, label: () => 'Destrutiva', execute: async () => { effects++; return { result: 'confirmado' }; } });
    const world = await createRunsWorld({ tools: [dangerous] });
    try {
      await world.models.test('opencode/glm-5.1'); const { send } = await chatSession(world);
      let step = 0; const offered: string[][] = [];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) { offered.push((request.tools ?? []).map((tool) => tool.name)); if (step++ === 0) yield event(DISCOVER_TOOLS, { names: ['dangerous'] }); else if (step === 2) yield event('dangerous', {}); else yield { type: 'text', text: 'Após aprovação' }; yield { type: 'done', reason: 'stop' }; });
      world.engine.start(); const run = await send('Ação'); await world.waitForStatus(run, 'waiting_approval');
      expect(effects).toBe(0); await world.engine.stop();
      const approval = await world.approvalOf(run); await world.approvals.respond(approval!.id, 'allow_once', ORIGIN);
      const resumed = world.createEngine(); resumed.start(); try { await world.waitForStatus(run, 'completed'); } finally { await resumed.stop(); }
      expect(effects).toBe(1); expect(offered.at(-1)).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'dangerous']);
      expect((await readToolSelectionHistory(world.pool, run)).names).toEqual(['dangerous']);
      expect((await world.pool.query('SELECT tool_calls FROM runs WHERE id=$1', [run])).rows[0].tool_calls).toBe(2);
      // Execução nova da mesma conversa já recebe o schema selecionado na primeira chamada: sem nova descoberta paga.
      const next = world.createEngine(); next.start();
      try { const second = await send('De novo'); await world.waitForStatus(second, 'completed'); } finally { await next.stop(); }
      expect(offered.at(-1)).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'dangerous']);
      expect(effects).toBe(1);
    } finally { await world.cleanup(); }
  });

  it('nomes reservados não podem sobrescrever portas; seleção respeita botOnly e registro estável', async () => {
    const world = await createRunsWorld({ tools: [localTool('bot_only', true)] });
    try {
      expect(() => world.createEngine()).not.toThrow();
      // Validação na origem confiável, antes de construir o Map silenciosamente substituível.
      const { assertRuntimeToolNames, discoveryTool } = await import('./tool-discovery');
      expect(() => assertRuntimeToolNames([localTool(DISCOVER_TOOLS)])).toThrow(); expect(() => assertRuntimeToolNames([localTool(READ_ACTIVITY)])).toThrow(); expect(() => assertRuntimeToolNames([localTool(ABRIR_GRUPO)])).toThrow();
      const a = localTool('a'), b = localTool('b'), registry = new Map([['a', a], ['b', b]]), discovery = discoveryTool(registry);
      // A publicação segue a ordem da primeira seleção (b antes de a), não a do registry (phase 12, A6).
      expect(selectCatalog(registry, { names: ['b', 'a'], lastSelectedId: new Map([['b', '1'], ['a', '2']]) }, () => false).optional).toEqual([b.definition, a.definition]);
      expect(() => discovery.prepare(JSON.stringify({ names: ['a', 'a'] }))).toThrow();
      expect(() => discovery.prepare(JSON.stringify({ names: Array.from({ length: 9 }, (_, index) => `t${index}`) }))).toThrow();
    } finally { await world.cleanup(); }
  });
});

// A conta pura do catálogo (phase 12, F2): sem banco nem motor, as seleções e o corte decidem tudo.
describe('catálogo estável: seleções da conversa e corte da compactação', () => {
  /** Handler de teste; `core` marca a ferramenta como core, como o motor faz com os nomes de `CORE_TOOLS`. */
  const handler = (name: string, core = false): ToolHandler => ({ ...localTool(name, false, 1), ...(core ? { core: true } : {}) });
  const registry = new Map([['core_a', handler('core_a', true)], ['opt_x', handler('opt_x')], ['core_b', handler('core_b', true)], ['opt_y', handler('opt_y')], ['opt_z', handler('opt_z')], [READ_ACTIVITY, handler(READ_ACTIVITY)], [DISCOVER_TOOLS, handler(DISCOVER_TOOLS)]]);
  const namesOf = (definitions: { name: string }[]) => definitions.map((definition) => definition.name);
  /** opt_z foi a primeira selecionada (id 5), opt_x a segunda (id 9); `ghost` saiu do registry (conta desconectada) e não aparece. */
  const history = { names: ['opt_z', 'ghost', 'opt_x'], lastSelectedId: new Map([['opt_z', '5'], ['ghost', '7'], ['opt_x', '9']]) };

  it('as portas e as core são fixas na ordem do registry; as opcionais seguem a ordem da primeira seleção, com a nova no fim, e nome fora do registry é ignorado', () => {
    const plan = selectCatalog(registry, history, () => false);
    expect(namesOf(plan.fixed)).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'core_a', 'core_b']);
    expect(namesOf(plan.optional)).toEqual(['opt_z', 'opt_x']);
    expect(plan.droppable).toEqual([]);
    // Uma seleção nova entra no fim, e as anteriores não saem do lugar.
    const grown = selectCatalog(registry, { names: [...history.names, 'opt_y'], lastSelectedId: new Map([...history.lastSelectedId, ['opt_y', '11']]) }, () => false);
    expect(namesOf(grown.optional)).toEqual(['opt_z', 'opt_x', 'opt_y']);
    // Selecionar de novo uma já selecionada não muda a ordem, nem a lista.
    const again = selectCatalog(registry, { ...history, lastSelectedId: new Map([...history.lastSelectedId, ['opt_z', '12']]) }, () => false);
    expect(namesOf(again.optional)).toEqual(['opt_z', 'opt_x']);
    // Se o registry volta a ter a ferramenta que sumiu, ela volta ao lugar de origem.
    registry.set('ghost', handler('ghost'));
    try { expect(namesOf(selectCatalog(registry, history, () => false).optional)).toEqual(['opt_z', 'ghost', 'opt_x']); } finally { registry.delete('ghost'); }
  });

  it('só sai do catálogo o selecionado até o corte do checkpoint, o mais antigo primeiro; sem checkpoint, e para o selecionado de novo depois do corte, nada pode sair', () => {
    expect(namesOf(selectCatalog(registry, history, selectedBeforeCut(null)).droppable)).toEqual([]);
    // Corte em 7: só a opt_z (seleção 5); a opt_x (9) foi selecionada depois e fica protegida.
    expect(namesOf(selectCatalog(registry, history, selectedBeforeCut('7')).droppable)).toEqual(['opt_z']);
    // Corte em 9 (igual ao id): as duas, da seleção mais antiga à mais nova, mesmo que a ordem da lista seja outra.
    const swapped = { names: ['opt_x', 'opt_z'], lastSelectedId: history.lastSelectedId };
    expect(namesOf(selectCatalog(registry, swapped, selectedBeforeCut('9')).droppable)).toEqual(['opt_z', 'opt_x']);
    expect(namesOf(selectCatalog(registry, swapped, selectedBeforeCut('9')).optional)).toEqual(['opt_x', 'opt_z']);
    // Selecionada de novo depois do corte: protegida até a compactação seguinte, sem mudar o lugar.
    const reselected = { names: history.names, lastSelectedId: new Map([...history.lastSelectedId, ['opt_z', '20']]) };
    expect(namesOf(selectCatalog(registry, reselected, selectedBeforeCut('9')).droppable)).toEqual(['opt_x']);
    // Ids de mais de 15 dígitos (messages.id é bigint) comparam como números inteiros exatos, não como texto nem ponto flutuante.
    expect(selectedBeforeCut('9007199254740993')('9007199254740992')).toBe(true);
    expect(selectedBeforeCut('9007199254740992')('9007199254740993')).toBe(false);
    expect(selectedBeforeCut('100')('99')).toBe(true);
    // Core e portas nunca são candidatas, nem quando o modelo as "seleciona".
    const withCore = { names: ['core_a', 'opt_z'], lastSelectedId: new Map([['core_a', '1'], ['opt_z', '2']]) };
    expect(namesOf(selectCatalog(registry, withCore, () => true).droppable)).toEqual(['opt_z']);
  });

  it('as seleções vêm da conversa, da mais antiga à mais nova: união na ordem da primeira, id da última, leitura tolerante e falha ignorada', async () => {
    const rows = [
      { id: '3', tool_arguments: JSON.stringify({ names: ['b', 'a'] }) },
      { id: '8', tool_arguments: JSON.stringify({ names: JSON.stringify(['c', 'b']) }) },
      { id: '9', tool_arguments: 'não é JSON' },
      { id: '12', tool_arguments: null },
    ];
    const db = { query: async () => ({ rows }) } as never;
    expect(await readToolSelectionHistory(db, '1')).toEqual({ names: ['b', 'a', 'c'], lastSelectedId: new Map([['b', '8'], ['a', '3'], ['c', '8']]) });
    expect((await readToolSelectionHistory(db, '1')).names).toEqual(['b', 'a', 'c']);
    expect(await readToolSelectionHistory({ query: async () => ({ rows: [] }) } as never, '1')).toEqual({ names: [], lastSelectedId: new Map() });
  });
});

// A porta `use_tool` (phase 15, passo 9; spec decisões 21 e 30). Cada risco da decisão 21 (E1 a E6) tem teste próprio, no motor real com um modelo roteirizado e ferramentas locais de efeito contável.
// Desde o passo 11 o bot publica a porta na lista fixa (ao lado de `abrir_grupo`); o Chat geral a tem no registry mas não a publica (decisão 26). Nestes testes o modelo roteirizado a chama pelo nome, e um teste prende que o pedido do bot a leva.
describe('use_tool: o portão decide pelo ALVO, o alvo sai do mapa filtrado e a retomada o reconfere (phase 15, E1 a E6)', () => {
  const ACTION = { slug: 'TEST_DANGEROUS', label: 'Destrutiva', appSlug: 'local', appName: 'Local' };
  type World = Awaited<ReturnType<typeof makeWorld>>['world'];
  const refusalText = (content: string): string => (JSON.parse(content) as { message: string }).message;

  /** Mundo com ferramentas locais de efeito contável: `dangerous` pede aprovação, `reader` e `strict` não (`strict` só aceita `{ n: inteiro }`). */
  async function makeWorld() {
    const effects = { dangerous: 0, reader: 0, strict: 0 };
    const dangerous = defineTool({ definition: { name: 'dangerous', description: 'Operação destrutiva local.', parameters: { type: 'object', additionalProperties: false } }, argsSchema: z.strictObject({}), approvalRequired: true, action: ACTION, label: () => 'Destrutiva', execute: async () => { effects.dangerous += 1; return { result: 'confirmado' }; } });
    const reader = defineTool({ definition: { name: 'reader', description: 'Leitura local.', parameters: { type: 'object', additionalProperties: false } }, argsSchema: z.strictObject({}), label: () => 'Leitura', execute: async () => { effects.reader += 1; return { result: 'lido' }; } });
    const strict = defineTool({ definition: { name: 'strict', description: 'Aceita só n.', parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false } }, argsSchema: z.strictObject({ n: z.number().int() }), label: () => 'Estrita', execute: async ({ n }) => { effects.strict += 1; return { result: String(n) }; } });
    const world = await createRunsWorld({ tools: [dangerous, reader, strict] });
    await world.models.test('opencode/glm-5.1');
    world.engine.start();
    return { world, effects };
  }
  /** Roteiriza o modelo: o passo `i` devolve os eventos de `steps[i]`; depois deles, um texto final. `seen` guarda os pedidos que chegaram ao provedor. */
  function script(world: World, steps: ChatEvent[][]): ChatRequest[] {
    const seen: ChatRequest[] = [];
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
      seen.push(structuredClone(request));
      yield* steps[seen.length - 1] ?? [{ type: 'text', text: 'Concluído' }];
      yield { type: 'done', reason: 'stop' };
    });
    return seen;
  }
  const activitiesOf = async (world: World, run: string) =>
    (await world.pool.query<{ id: string; status: string; content: string; data: Record<string, unknown> }>("SELECT id::text, status, content, data FROM messages WHERE run_id = $1 AND kind = 'activity' ORDER BY messages.id", [run])).rows;
  /** Manda a mensagem a uma sessão nova do Chat geral, com o modelo `opencode/glm-5.1`, e devolve a execução. */
  async function sendToSession(world: World, text: string): Promise<string> {
    const session = await new GeneralChatService({ pool: world.pool }).create();
    await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
    return (await world.conversations.send({ sessionId: session.id }, text)).id;
  }

  it('A27, E1 e E5: sem regra a chamada pelo alvo PERGUNTA e pausa; o pedido guarda o alvo e a ação DELE; reiniciar o worker e aprovar executa UMA vez, e o histórico volta a porta como o modelo a chamou', async () => {
    const { world, effects } = await makeWorld();
    try {
      const bot = await world.createBot();
      const seen = script(world, [[event(USE_TOOL, { name: 'dangerous', arguments: {} })]]);
      const run = await world.send(bot, 'Executar');
      await world.waitForStatus(run, 'waiting_approval');
      expect(effects.dangerous).toBe(0);
      // E1: a aprovação é da ação do ALVO (a porta não tem ação nem pede aprovação por si), e a chamada gravada é a do alvo, com a porta em `via`.
      const approval = (await world.approvalOf(run))!;
      const pending = (await world.pool.query<{ action_slug: string; call: Record<string, unknown> }>('SELECT action_slug, call FROM approvals WHERE id = $1', [approval.id])).rows[0]!;
      expect(pending.action_slug).toBe('TEST_DANGEROUS');
      expect(pending.call).toMatchObject({ name: 'dangerous', arguments: '{}', via: USE_TOOL });
      expect((await activitiesOf(world, run))[0]!.data).toMatchObject({ tool: 'dangerous', via: USE_TOOL, awaitingApproval: true });

      // A resposta chega com o worker reiniciado: outra instância reencontra o alvo no mapa dela e executa a MESMA chamada, uma vez só.
      await world.engine.stop();
      await world.approvals.respond(approval.id, 'allow_once', ORIGIN);
      const resumed = world.createEngine(); resumed.start();
      try { await world.waitForStatus(run, 'completed'); } finally { await resumed.stop(); }
      expect(effects.dangerous).toBe(1);
      const rows = await activitiesOf(world, run);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'completed', content: 'confirmado' });
      expect((await world.runRow(run)).tool_calls).toBe(1);
      // O histórico devolve a chamada como o modelo a fez (a porta com o nome e os argumentos do alvo dentro) e o resultado do alvo.
      const history = seen.at(-1)!.turns;
      const call = history.flatMap((turn) => (turn.role === 'assistant' ? turn.toolCalls : [])).find((entry) => entry.name === USE_TOOL)!;
      expect(JSON.parse(call.arguments)).toEqual({ name: 'dangerous', arguments: {} });
      expect(history.find((turn) => turn.role === 'tool' && turn.callId === call.id)).toMatchObject({ text: 'confirmado' });
      // O bot publica a porta na lista fixa (passo 11), a mesma em toda etapa.
      for (const request of seen) expect(toolNames(request)).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY]);
      // E5: `read_activity` diz que os argumentos são os do alvo, com o nome próprio da porta.
      const reading = script(world, [[event(READ_ACTIVITY, { messageId: rows[0]!.id, part: 'arguments' })]]);
      const engine = world.createEngine(); engine.start();
      try {
        const read = await world.send(bot, 'Ler a atividade'); await world.waitForStatus(read, 'completed');
        expect((await activitiesOf(world, read))[0]!.content).toMatch(/"via":"use_tool","argumentsScope":"inner-tool"/u);
      } finally { await engine.stop(); }
      expect(reading.length).toBeGreaterThan(0);
    } finally { await world.cleanup(); }
  }, 60_000);

  it('A26 e E1: "negar sempre" a ação do alvo vale pela porta: a chamada seguinte não executa nem pede aprovação, e a atividade fica negada; o alvo sem aprovação executa direto', async () => {
    const { world, effects } = await makeWorld();
    try {
      const bot = await world.createBot();
      script(world, [[event(USE_TOOL, { name: 'dangerous', arguments: {} })]]);
      const first = await world.send(bot, 'Primeira'); await world.waitForStatus(first, 'waiting_approval');
      await world.approvals.respond((await world.approvalOf(first))!.id, 'deny_always', ORIGIN);
      await world.waitForStatus(first, 'completed');
      expect((await activitiesOf(world, first))[0]).toMatchObject({ status: 'failed', content: NOT_EXECUTED_RESULTS.denied });

      script(world, [[event(USE_TOOL, { name: 'dangerous', arguments: {} })]]);
      const second = await world.send(bot, 'Segunda'); await world.waitForStatus(second, 'completed');
      expect(await world.approvalOf(second)).toBeNull(); // negada pela regra, sem pausa nem cartão
      expect((await activitiesOf(world, second))[0]).toMatchObject({ status: 'failed', content: NOT_EXECUTED_RESULTS.deniedByRule, data: { tool: 'dangerous', via: USE_TOOL } });
      expect(effects.dangerous).toBe(0);

      // Controle: o alvo sem aprovação executa pela porta, sem regra nenhuma.
      script(world, [[event(USE_TOOL, { name: 'reader', arguments: {} })]]);
      const third = await world.send(bot, 'Terceira'); await world.waitForStatus(third, 'completed');
      expect((await activitiesOf(world, third))[0]).toMatchObject({ status: 'completed', content: 'lido', data: { tool: 'reader', via: USE_TOOL } });
      expect(effects.reader).toBe(1);
    } finally { await world.cleanup(); }
  }, 60_000);

  it('A28 e E3: a aprovação vale só para a ação gravada no pedido; ação gravada trocada ou chamada que reencontra outra ferramenta na retomada é recusada, sem executar nenhuma das duas', async () => {
    const { world, effects } = await makeWorld();
    try {
      const bot = await world.createBot();
      // Retomada em que o pedido aprovado era de OUTRA ação: o alvo reencontrado não é o que o dono viu.
      script(world, [[event(USE_TOOL, { name: 'dangerous', arguments: {} })]]);
      const swapped = await world.send(bot, 'Ação trocada'); await world.waitForStatus(swapped, 'waiting_approval');
      const approval = (await world.approvalOf(swapped))!;
      await world.pool.query("INSERT INTO approval_actions (slug, app_slug, app_name, label, global_rule, first_seen_at, last_seen_at) VALUES ('TEST_OUTRA_ACAO', 'local', 'Local', 'Outra', 'neutral', now(), now())");
      await world.pool.query("UPDATE approvals SET action_slug = 'TEST_OUTRA_ACAO' WHERE id = $1", [approval.id]);
      await world.approvals.respond(approval.id, 'allow_once', ORIGIN);
      await world.waitForStatus(swapped, 'completed');
      const refused = (await activitiesOf(world, swapped))[0]!;
      expect(refused.status).toBe('failed');
      expect(refusalText(refused.content)).toContain('A ação mudou depois do pedido de aprovação');

      // Retomada em que a chamada gravada passou a apontar para outra ferramenta (sem aprovação): ela também não executa com a aprovação de outra.
      script(world, [[event(USE_TOOL, { name: 'dangerous', arguments: {} })]]);
      const renamed = await world.send(bot, 'Chamada trocada'); await world.waitForStatus(renamed, 'waiting_approval');
      const second = (await world.approvalOf(renamed))!;
      await world.pool.query(`UPDATE approvals SET call = jsonb_set(call, '{name}', '"reader"') WHERE id = $1`, [second.id]);
      await world.approvals.respond(second.id, 'allow_once', ORIGIN);
      await world.waitForStatus(renamed, 'completed');
      const refusedRenamed = (await activitiesOf(world, renamed))[0]!;
      expect(refusedRenamed.status).toBe('failed');
      expect(refusalText(refusedRenamed.content)).toContain('A ação mudou depois do pedido de aprovação');
      expect(effects).toEqual({ dangerous: 0, reader: 0, strict: 0 });
    } finally { await world.cleanup(); }
  }, 60_000);

  it('A30, E4 e E5: reservadas (inclusive abrir_grupo), a própria porta, portas do conector, alvo inexistente e argumentos fora do esquema do alvo (ou da porta) são recusados: nada executa, nenhuma aprovação nasce e a seleção do discover_tools não muda', async () => {
    const { world, effects } = await makeWorld();
    try {
      const bot = await world.createBot();
      const attempts: unknown[] = [
        { name: DISCOVER_TOOLS, arguments: { names: ['reader'] } },
        { name: ABRIR_GRUPO, arguments: { path: 'artefatos' } },
        { name: READ_ACTIVITY, arguments: { messageId: '1' } },
        { name: USE_TOOL, arguments: { name: 'reader', arguments: {} } },
        { name: COMPOSIO_EXECUTE_TOOL, arguments: { action: 'GMAIL_SEND_EMAIL', arguments: {} } },
        { name: COMPOSIO_SEARCH_TOOL, arguments: { app: 'gmail', query: 'send' } },
        { name: 'ferramenta_que_nao_existe', arguments: {} },
        { name: 'dangerous', arguments: { extra: 1 } }, // fora do esquema do alvo, que pediria aprovação: nunca chega ao portão
        { name: 'strict', arguments: { n: 'texto' } },
        { name: 'strict', arguments: { n: 1, extra: true } },
        { name: 'strict' }, // sem arguments, o esquema do alvo exige n
        { arguments: {} }, // sem nome: a própria porta recusa
        { name: 'reader', arguments: 'não é um objeto' },
      ];
      const seen = script(world, attempts.map((args) => [event(USE_TOOL, args)]));
      const run = await world.send(bot, 'Recusar tudo'); await world.waitForStatus(run, 'completed');
      const rows = await activitiesOf(world, run);
      expect(rows.map((row) => row.status)).toEqual(Array(attempts.length).fill('failed'));
      expect(effects).toEqual({ dangerous: 0, reader: 0, strict: 0 });
      expect(await world.approvalOf(run)).toBeNull();
      expect((await readToolSelectionHistory(world.pool, run)).names).toEqual([]);
      // As que a porta nunca alcança ficam gravadas na própria porta (sem alvo, sem `via`) e dizem para chamar direto; o inexistente responde como qualquer ferramenta desconhecida.
      for (const index of [0, 1, 2, 3, 4, 5]) {
        expect(rows[index]!.data).toMatchObject({ tool: USE_TOOL });
        expect(rows[index]!.data).not.toHaveProperty('via');
        expect(refusalText(rows[index]!.content)).toMatch(/se chamam direto/u);
      }
      expect(rows[6]!.data).toMatchObject({ tool: 'ferramenta_que_nao_existe', via: USE_TOOL });
      expect(JSON.parse(rows[6]!.content)).toMatchObject({ code: 'TOOL_NOT_FOUND', message: expect.stringContaining('Ferramenta desconhecida: ferramenta_que_nao_existe') });
      // Argumentos do alvo recusados pelo esquema DELE; os da porta, pelo dela.
      for (const index of [7, 8, 9, 10]) expect(JSON.parse(rows[index]!.content)).toMatchObject({ code: 'VALIDATION_FAILED' });
      for (const index of [11, 12]) {
        expect(rows[index]!.data).toMatchObject({ tool: USE_TOOL });
        expect(JSON.parse(rows[index]!.content)).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      expect(seen).toHaveLength(attempts.length + 1);
    } finally { await world.cleanup(); }
  }, 60_000);

  // O nome do alvo é comparado exatamente (sem caixa, sem espaço, sem prefixo): variante de um nome que existe NUNCA resolve para ele. Fora do formato a própria porta recusa (VALIDATION_FAILED);
  // no formato mas inexistente, o executor responde ferramenta desconhecida (TOOL_NOT_FOUND). Nos dois casos nada executa, nenhuma aprovação nasce e o modelo recebe a recusa como resultado.
  it.each([
    ['caixa diferente de um nome do catálogo', 'DOC_LIST', 'TOOL_NOT_FOUND'],
    ['caixa diferente de um alvo do registry', 'DANGEROUS', 'TOOL_NOT_FOUND'],
    ['espaço no começo', ' reader', 'VALIDATION_FAILED'],
    ['espaço no fim', 'reader ', 'VALIDATION_FAILED'],
    ['prefixo de outra ferramenta', 'read', 'TOOL_NOT_FOUND'],
    ['nome que estende outra ferramenta', 'reader_extra', 'TOOL_NOT_FOUND'],
    ['128 caracteres (o limite do formato)', 'a'.repeat(128), 'TOOL_NOT_FOUND'],
    ['129 caracteres (acima do limite)', 'a'.repeat(129), 'VALIDATION_FAILED'],
    ['nome vazio', '', 'VALIDATION_FAILED'],
  ])('A30: nome do alvo com %s é recusado, sem efeito nem aprovação, e o modelo recebe a recusa', async (_caso, name, code) => {
    const { world, effects } = await makeWorld();
    try {
      const bot = await world.createBot();
      const seen = script(world, [[event(USE_TOOL, { name, arguments: {} })]]);
      const run = await world.send(bot, 'Nome inválido'); await world.waitForStatus(run, 'completed');
      const [activity] = await activitiesOf(world, run);
      expect(activity).toMatchObject({ status: 'failed' });
      expect(JSON.parse(activity!.content)).toMatchObject({ code });
      expect(effects).toEqual({ dangerous: 0, reader: 0, strict: 0 });
      expect(await world.approvalOf(run)).toBeNull();
      // O modelo recebe a recusa: o pedido seguinte traz o resultado da chamada da porta.
      const refusal = seen.at(-1)!.turns.find((turn) => turn.role === 'tool');
      expect(refusal).toMatchObject({ text: activity!.content });
    } finally { await world.cleanup(); }
  }, 60_000);

  it('os argumentos do alvo enviados como texto com o JSON são decodificados como em qualquer ferramenta, e o histórico grava o objeto', async () => {
    const { world, effects } = await makeWorld();
    try {
      const bot = await world.createBot();
      script(world, [[event(USE_TOOL, { name: 'strict', arguments: '{"n":7}' })]]);
      const run = await world.send(bot, 'Texto'); await world.waitForStatus(run, 'completed');
      expect((await activitiesOf(world, run))[0]).toMatchObject({ status: 'completed', content: '7', data: { tool: 'strict', via: USE_TOOL } });
      expect(effects.strict).toBe(1);
      const stored = (await world.pool.query<{ tool_arguments: string }>("SELECT tool_arguments FROM messages WHERE run_id = $1 AND kind = 'activity'", [run])).rows[0]!;
      expect(JSON.parse(stored.tool_arguments)).toEqual({ n: 7 });
    } finally { await world.cleanup(); }
  }, 60_000);

  it('no Chat geral a aprovação pendente de um alvo comum retoma e executa pela porta: a recusa da pendência vale só para o via do conector', async () => {
    const { world, effects } = await makeWorld();
    try {
      script(world, [[event(USE_TOOL, { name: 'dangerous', arguments: {} })]]);
      const run = await sendToSession(world, 'Executar no chat geral');
      await world.waitForStatus(run, 'waiting_approval');
      expect(effects.dangerous).toBe(0);
      await world.approvals.respond((await world.approvalOf(run))!.id, 'allow_once', ORIGIN);
      await world.waitForStatus(run, 'completed');
      expect(effects.dangerous).toBe(1);
      expect((await activitiesOf(world, run))[0]).toMatchObject({ status: 'completed', content: 'confirmado', data: { tool: 'dangerous', via: USE_TOOL } });
    } finally { await world.cleanup(); }
  }, 60_000);

  it('E4 e E6: a lista de recusa da porta inclui as reservadas e as duas portas do conector, que NÃO entram em RESERVED_RUNTIME_TOOLS (o conector continua carregando); unwrap só traduz o alcançável e o alvo sai só do mapa recebido', async () => {
    expect([...USE_TOOL_UNREACHABLE].sort()).toEqual([ABRIR_GRUPO, COMPOSIO_EXECUTE_TOOL, COMPOSIO_SEARCH_TOOL, DISCOVER_TOOLS, READ_ACTIVITY, USE_TOOL].sort());
    // Os nomes literais das portas do conector (para tool-discovery.ts seguir livre de ciclos) são os de composio-tools.ts.
    expect([...CONNECTOR_PORTS].sort()).toEqual([COMPOSIO_EXECUTE_TOOL, COMPOSIO_SEARCH_TOOL].sort());
    expect(RESERVED_RUNTIME_TOOLS.has(COMPOSIO_EXECUTE_TOOL) || RESERVED_RUNTIME_TOOLS.has(COMPOSIO_SEARCH_TOOL)).toBe(false);
    expect(() => assertRuntimeToolNames([localTool(COMPOSIO_EXECUTE_TOOL), localTool(COMPOSIO_SEARCH_TOOL)])).not.toThrow();
    expect(() => assertRuntimeToolNames([localTool(USE_TOOL)])).toThrow();
    const reader = localTool('reader');
    const port = useToolPort(new Map([['reader', reader]]));
    expect(port.unwrap!(JSON.stringify({ name: 'reader', arguments: { a: 1 } }))).toEqual({ name: 'reader', arguments: '{"a":1}' });
    expect(port.unwrap!(JSON.stringify({ name: 'reader' }))).toEqual({ name: 'reader', arguments: '{}' });
    for (const name of USE_TOOL_UNREACHABLE) expect(port.unwrap!(JSON.stringify({ name, arguments: {} }))).toBeNull();
    expect(port.unwrap!('{"name":7}')).toBeNull();
    // O alvo sai SÓ do mapa recebido: o que ele não tem (filtrado ou inexistente) é indistinguível, e as portas nunca são alvo.
    expect(await port.target!('reader', { botId: null })).toBe(reader);
    expect(await port.target!('bot_only', { botId: null })).toBeUndefined();
    expect(await port.target!(USE_TOOL, { botId: null })).toBeUndefined();
  });

  it('E5: a chamada pela porta volta ao modelo com o nome e os argumentos do alvo dentro, e a leitura de anexo por ela deduplica a página inicial como a direta (o via do conector não)', () => {
    const text = 'conteúdo inicial '.repeat(2000);
    const attachment = { id: '7', message_id: '1', kind: 'document' as const, name: 'a.txt', original_bytes: 100, total_chars: text.length, removed: false, extracted_text: text, image_bytes: null };
    const first: ContextRow = { id: '1', run_id: '1', role: 'user', kind: 'text', status: 'done', opens_round: true, step: null, content: 'Analise.', data: {}, attachments: [attachment] };
    const read: ContextRow = { id: '2', run_id: '1', role: 'assistant', kind: 'activity', status: 'completed', opens_round: false, step: 1, content: attachmentBlock(text), tool_arguments: '{"attachmentId":"7"}', data: { tool: 'read_attachment', callId: 'read-1', arguments: '{"attachmentId":"7"}', label: 'Ler', detail: { type: 'attachment_read', attachmentId: '7', kind: 'document', offset: 0 }, via: USE_TOOL } };
    // A deduplicação só vale com uma mensagem do dono depois da leitura (o complemento): é a forma que o pedido tem quando o modelo já leu o arquivo e a rodada segue.
    const complement: ContextRow = { id: '3', run_id: '1', role: 'user', kind: 'text', status: 'done', opens_round: false, step: null, content: 'Mais uma coisa.', data: { complement: true } };
    const turns = buildTurns([first, read, complement], { readAttachmentRefs: true });
    const call = turns.flatMap((turn) => (turn.role === 'assistant' ? turn.toolCalls : []))[0]!;
    expect(call.name).toBe(USE_TOOL);
    expect(JSON.parse(call.arguments)).toEqual({ name: 'read_attachment', arguments: { attachmentId: '7' } });
    expect(turns[0]!.text).not.toContain('conteúdo inicial'); // a leitura pela porta é a cópia íntegra: a página inline sai
    const viaConnector = buildTurns([first, { ...read, data: { ...(read.data as object), via: COMPOSIO_EXECUTE_TOOL } }, complement], { readAttachmentRefs: true });
    expect(viaConnector[0]!.text).toContain('conteúdo inicial'); // o mesmo nome chamado pelo conector nunca conta como leitura do anexo
  });
});

// ---------------------------------------------------------------------------------------------
// A árvore de grupos e `abrir_grupo` (phase 15, passo 11; decisões 23 a 26, A23, A24, A31, A32 e A46)
// ---------------------------------------------------------------------------------------------
describe('a árvore de grupos e abrir_grupo (phase 15, passo 11)', () => {
  /** Roteiro do modelo: o passo `i` devolve os eventos de `steps[i]`, depois um texto final; `seen` guarda os pedidos (clonados) que chegaram ao provedor. */
  function script(world: World, steps: ChatEvent[][]): ChatRequest[] {
    const seen: ChatRequest[] = [];
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
      seen.push(structuredClone(request));
      yield* steps[seen.length - 1] ?? [{ type: 'text', text: 'Concluído' }];
      yield { type: 'done', reason: 'stop' };
    });
    return seen;
  }
  const activitiesOf = async (world: World, run: string) =>
    (await world.pool.query<{ id: string; status: string; content: string; data: Record<string, unknown> }>("SELECT id::text, status, content, data FROM messages WHERE run_id = $1 AND kind = 'activity' ORDER BY messages.id", [run])).rows;
  const toolTurns = (request: ChatRequest): string[] => request.turns.flatMap((turn) => (turn.role === 'tool' ? [turn.text] : []));
  const definitionOf = (name: string): ChatTool => {
    const handler = INTERNAL_TOOLS.find((tool) => tool.definition.name === name);
    if (!handler) throw new Error(`ferramenta ${name} não está no catálogo padrão`);
    return handler.definition;
  };
  /** Os nomes que o catálogo padrão do bot tem de verdade: internas, Python, web, o histórico e as duas portas do conector. */
  const knownNames = (): Set<string> => new Set([...INTERNAL_TOOLS.map((tool) => tool.definition.name), RUN_PYTHON_TOOL, WEB_SEARCH_TOOL, WEB_FETCH_TOOL, READ_ACTIVITY, ...CONNECTOR_PORTS]);

  it('A32: a árvore é a fonte única do caminho: todo handler padrão tem caminho, todo caminho aponta para uma ferramenta do catálogo, um nome pertence a um galho só e a composição é a da decisão 23', () => {
    const grouped = TOOL_TREE.flatMap((group) => group.tools);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(new Set(grouped)).toEqual(knownNames());
    expect(ungroupedTools(INTERNAL_TOOLS)).toEqual([]);
    expect(() => assertToolTree(INTERNAL_TOOLS)).not.toThrow();
    // Um handler novo sem caminho falha na partida do motor; nomeá-lo no galho certo de TOOL_TREE é o único registro que falta.
    const orphan = localTool('ferramenta_sem_caminho');
    expect(ungroupedTools([...INTERNAL_TOOLS, orphan])).toEqual(['ferramenta_sem_caminho']);
    expect(() => assertToolTree([orphan])).toThrow(/ferramenta_sem_caminho/u);
    // As portas ficam fora da árvore (decisão 23): abrir_grupo, use_tool e discover_tools não têm galho.
    expect(ungroupedTools([localTool(ABRIR_GRUPO), localTool(USE_TOOL), localTool(DISCOVER_TOOLS)])).toEqual([]);
    expect(Object.fromEntries(TOOL_TREE.map((group) => [group.path, group.tools]))).toEqual({
      'artefatos/docs': ['doc_list', 'doc_read', 'doc_create', 'doc_append', 'doc_replace', 'doc_rewrite', 'doc_versions', 'doc_restore', 'doc_delete'],
      'artefatos/tabelas/dados': ['table_list', 'table_get', 'table_query', 'table_write', 'table_import_attachment'],
      'artefatos/tabelas/estrutura': ['table_create', 'table_update', 'table_views', 'table_view_create', 'table_view_update', 'table_view_remove', 'table_formula_preview'],
      'artefatos/tabelas/exclusao': ['table_prepare_operation', 'table_delete_records', 'table_delete_column', 'table_convert_column', 'table_delete_table'],
      'conector/composio': ['composio_search_actions', 'composio_execute_action'],
      'ferramentas/memoria': ['edit_memory'],
      'ferramentas/objetivo': ['update_objective'],
      'ferramentas/rotinas': ['propose_routine', 'propose_routine_change', 'list_routines', 'get_routine'],
      'ferramentas/historico': ['search_history', 'read_activity', 'read_attachment'],
      'ferramentas/web': ['web_search', 'web_fetch'],
      'ferramentas/python': ['run_python'],
    });
    // Cada esquema abre íntegro e sem teto (ponytail em groupOpeningResults): enquanto nenhum passar de 12.000 caracteres, o teto de CTX-10 nem seria aplicado a ele.
    for (const tool of INTERNAL_TOOLS) expect(JSON.stringify(tool.definition).length, tool.definition.name).toBeLessThan(RESULT_PROMPT_MAX_CHARS);
    // propose_routine e propose_routine_change moram no mesmo galho e abrem juntas (o contorno da agenda de uma cita o esquema da outra).
    expect(resolveTreePath('propose_routine_change')!.path.split('/').slice(0, -1)).toEqual(resolveTreePath('propose_routine')!.path.split('/').slice(0, -1));
  });

  it('resolveTreePath: galho (inclusive os ancestrais), folha por nome ou por caminho completo, caixa e espaços não importam, e o que não está na árvore não resolve', () => {
    expect(resolveTreePath('artefatos/docs')).toEqual({ kind: 'branch', path: 'artefatos/docs', tools: TOOL_TREE[0]!.tools });
    expect(resolveTreePath('artefatos')!.tools).toEqual(TOOL_TREE.filter((group) => group.path.startsWith('artefatos/')).flatMap((group) => group.tools));
    expect(resolveTreePath('artefatos/tabelas')!.tools).toHaveLength(17);
    expect(resolveTreePath('ferramentas')!.tools).toHaveLength(12);
    expect(resolveTreePath('conector')).toMatchObject({ kind: 'branch', path: 'conector', tools: [...CONNECTOR_PORTS] });
    // Folha: o nome da ferramenta e o caminho completo resolvem para a mesma coisa.
    for (const raw of ['doc_read', 'artefatos/docs/doc_read']) expect(resolveTreePath(raw)).toEqual({ kind: 'leaf', path: 'artefatos/docs/doc_read', tools: ['doc_read'] });
    // Equivalência: caixa, espaços nas pontas e barras sobrando são o mesmo caminho.
    for (const raw of ['  Artefatos/Docs  ', 'ARTEFATOS/DOCS/', '/artefatos//docs', ' artefatos / docs ']) expect(resolveTreePath(raw), raw).toEqual(resolveTreePath('artefatos/docs'));
    expect(resolveTreePath('DOC_READ ')).toEqual(resolveTreePath('doc_read'));
    // Inválidos: vazio, só barras, prefixo parcial de nome, galho inexistente, caminho com folha de outro galho.
    for (const raw of ['', ' ', '/', 'doc', 'artefatos/doc', 'docs', 'artefatos/docs/table_query', 'artefatos/tabelas/doc_list', 'nao/existe', '..']) expect(resolveTreePath(raw), raw).toBeNull();
  });

  it('a lista fixa do bot: as portas, as do conector e só depois as mais usadas, só o que o registry tem, na mesma ordem em qualquer seleção; o Chat geral não usa a árvore', () => {
    const registry = new Map<string, ToolHandler>([[ABRIR_GRUPO, localTool(ABRIR_GRUPO)], [USE_TOOL, localTool(USE_TOOL)], [READ_ACTIVITY, localTool(READ_ACTIVITY)], ['table_query', localTool('table_query')], ['edit_memory', localTool('edit_memory')], ['doc_list', localTool('doc_list')]]);
    // Sem conector no registry e com "mais usadas" que o registry não tem, a lista é o que existe.
    expect(botCatalogNames(registry, ['edit_memory', 'ghost', 'table_query'])).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, 'edit_memory', 'table_query']);
    // O conector entra entre as portas e as mais usadas.
    for (const port of CONNECTOR_PORTS) registry.set(port, localTool(port));
    expect(botCatalogNames(registry, ['edit_memory'])).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...CONNECTOR_PORTS, 'edit_memory']);
    // Uma "mais usada" que é porta não duplica; vazio é só as portas.
    expect(botCatalogNames(registry, [READ_ACTIVITY, 'edit_memory'])).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...CONNECTOR_PORTS, 'edit_memory']);
    expect(botCatalogNames(registry, [])).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...CONNECTOR_PORTS]);
    // selectCatalog no bot (o registry tem abrir_grupo) ignora seleções, corte e a marca core: a lista é função só do registry e da lista das mais usadas.
    const plan = selectCatalog(registry, { names: ['doc_list', 'table_query'], lastSelectedId: new Map([['doc_list', '3'], ['table_query', '4']]) }, () => true, ['edit_memory']);
    expect(plan.fixed.map((definition) => definition.name)).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...CONNECTOR_PORTS, 'edit_memory']);
    expect(plan.optional).toEqual([]);
    expect(plan.droppable).toEqual([]);
    // O DEFAULT_MOST_USED provisório cabe nas "até 5" da decisão 24 e só tem ferramentas do catálogo que não são portas.
    expect(DEFAULT_MOST_USED.length).toBeLessThanOrEqual(5);
    for (const name of DEFAULT_MOST_USED) expect(knownNames().has(name) && !RESERVED_RUNTIME_TOOLS.has(name) && !CONNECTOR_PORTS.includes(name) && name !== READ_ACTIVITY, name).toBe(true);
  });

  it('abrir_grupo (unidade): o índice cita só os galhos com ferramenta no registry, e uma folha, um galho, o que já está na lista e o que não existe respondem como a decisão 23 diz', async () => {
    const registry = new Map<string, ToolHandler>([[ABRIR_GRUPO, localTool(ABRIR_GRUPO)], ['doc_list', localTool('doc_list', true, 1)], ['doc_read', localTool('doc_read', true, 1)], ['edit_memory', localTool('edit_memory', true, 1)]]);
    const tool = abrirGrupoTool(registry, ['edit_memory']);
    // O índice: um galho por linha, só os que têm ferramenta aqui, sem marcar o que está publicado.
    const index = treeIndex(registry);
    expect(index.split('\n')).toHaveLength(2);
    expect(index).toMatch(/^- artefatos\/docs: .*\(doc_list, doc_read\)$/mu);
    expect(index).toMatch(/^- ferramentas\/memoria: .*\(edit_memory\)$/mu);
    // O índice vive no sistema do bot (passo 12), não na descrição da porta: a descrição não muda com a composição da árvore.
    expect(tool.definition.description).not.toContain(index);
    for (const line of index.split('\n')) expect(tool.definition.description).not.toContain(line);
    expect(abrirGrupoTool(new Map<string, ToolHandler>([[ABRIR_GRUPO, localTool(ABRIR_GRUPO)]])).definition.description).toBe(tool.definition.description);
    const open = async (path: string) => JSON.parse((await tool.prepare(JSON.stringify({ path })).execute({} as never)).result) as { path: string; opened: string[]; inYourList: string[]; schemas: { name: string }[] };
    // Folha por nome: o esquema vem; galho: os esquemas das ferramentas que o registry tem, na ordem da árvore; o que é "mais usada" não vem de novo e fica em inYourList.
    expect(await open('doc_read')).toMatchObject({ path: 'artefatos/docs/doc_read', opened: ['doc_read'], inYourList: [] });
    expect((await open('artefatos')).schemas.map((schema) => schema.name)).toEqual(['doc_list', 'doc_read']);
    expect(await open('ferramentas/memoria')).toMatchObject({ opened: [], inYourList: ['edit_memory'], schemas: [] });
    // Ferramenta da árvore que o registry não tem: o galho existe mas está vazio aqui; caminho que não existe lista os caminhos disponíveis. Em ambos, o envelope de erro com código.
    const failureOf = async (path: string) => { try { await open(path); } catch (error) { return JSON.parse((error as Error).message) as { code: string; message: string }; } throw new Error('esperava falha'); };
    expect(await failureOf('ferramentas/web')).toMatchObject({ code: 'TOOL_NOT_FOUND', message: expect.stringContaining('Nenhuma ferramenta de "ferramentas/web"') });
    const unknown = await failureOf('nao/existe');
    expect(unknown.code).toBe('TOOL_NOT_FOUND');
    expect(unknown.message).toContain('Caminhos que existem: artefatos/docs, ferramentas/memoria.');
    // Argumentos fora do contrato: campo extra, vazio, caractere fora do conjunto, comprimento e ausência.
    for (const bad of [{ path: 'doc_read', extra: 1 }, { path: '' }, { path: 'doc_read;drop' }, { path: 'a'.repeat(129) }, {}]) expect(() => tool.prepare(JSON.stringify(bad)), JSON.stringify(bad)).toThrow();
  });

  it('A24 e A23: abrir um galho devolve o esquema de cada ferramenta num resultado próprio e íntegro (sem o corte de 12.000), e nem a lista tools nem o prefixo do histórico mudam', async () => {
    // Janela do produto (256k): abrir `artefatos` inteiro põe cerca de 41 mil bytes de esquemas no histórico, que a janela de 64k dos mundos de teste não comporta sem compactar.
    const world = await createRunsWorld({ contextWindow: 'product' });
    try {
      await world.models.test('opencode/glm-5.1');
      world.engine.start();
      const bot = await world.createBot();
      const seen = script(world, [[event(ABRIR_GRUPO, { path: 'artefatos' })]]);
      const run = await world.send(bot, 'Abra os artefatos'); await world.waitForStatus(run, 'completed');
      const second = await world.send(bot, 'Outra mensagem'); await world.waitForStatus(second, 'completed');
      expect(seen).toHaveLength(3);
      // A23: a lista é a mesma em bytes na etapa da abertura, na seguinte e na rodada seguinte.
      expect(toolNames(seen[0]!)).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY]);
      for (const request of seen) expect(JSON.stringify(request.tools)).toBe(JSON.stringify(seen[0]!.tools));

      // A24: a chamada real tem o resumo da abertura; cada ferramenta tem a SUA chamada e o SEU resultado, completo e igual à definição, e nenhum passa do teto nem leva o marcador de corte.
      const expected = resolveTreePath('artefatos')!.tools;
      expect(expected).toHaveLength(26);
      const results = toolTurns(seen[1]!);
      expect(results).toHaveLength(1 + expected.length);
      expect(JSON.parse(results[0]!)).toEqual({ path: 'artefatos', opened: expected, inYourList: [] });
      const schemas = results.slice(1);
      expect(schemas.map((text) => (JSON.parse(text) as ChatTool).name)).toEqual(expected);
      for (const text of schemas) {
        const schema = JSON.parse(text) as ChatTool;
        expect(schema).toEqual(definitionOf(schema.name));
        expect(text.length).toBeLessThan(RESULT_PROMPT_MAX_CHARS);
        expect(text).not.toContain('[mostrando');
      }
      // O que prova que o teto cortaria um resultado único: a soma dos esquemas (cerca de 41 mil caracteres) passa de três vezes os 12.000, e o maior deles passa de 3.000.
      expect(schemas.reduce((sum, text) => sum + text.length, 0)).toBeGreaterThan(RESULT_PROMPT_MAX_CHARS * 3);
      expect(Math.max(...schemas.map((text) => text.length))).toBeGreaterThan(3_000);

      // Protocolo: o turno do assistente carrega a chamada real e uma por esquema, com ids únicos, cada uma com exatamente um turno de resultado, na mesma ordem.
      const assistant = seen[1]!.turns.find((turn) => turn.role === 'assistant' && turn.toolCalls.length > 0);
      if (assistant?.role !== 'assistant') throw new Error('turno do assistente ausente');
      expect(assistant.toolCalls.map((call) => call.name)).toEqual(Array(1 + expected.length).fill(ABRIR_GRUPO));
      expect(assistant.toolCalls.map((call) => JSON.parse(call.arguments) as unknown)).toEqual([{ path: 'artefatos' }, ...expected.map((name) => ({ path: name }))]);
      expect(new Set(assistant.toolCalls.map((call) => call.id)).size).toBe(assistant.toolCalls.length);
      for (const id of assistant.toolCalls.map((call) => call.id)) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
      expect(seen[1]!.turns.filter((turn) => turn.role === 'tool').map((turn) => (turn.role === 'tool' ? turn.callId : ''))).toEqual(assistant.toolCalls.map((call) => call.id));

      // O que fica gravado é UMA atividade (o esquema de cada ferramenta mora nela, íntegro), do tipo da porta e sem `via`.
      const rows = await activitiesOf(world, run);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'completed', data: { tool: ABRIR_GRUPO, label: 'Abrir artefatos' } });
      expect(rows[0]!.data).not.toHaveProperty('via');
      expect(parseGroupOpening(rows[0]!.content)!.schemas.map((schema) => schema.name)).toEqual(expected);
      expect((await world.runRow(run)).tool_calls).toBe(1);

      // Cache do provedor: a rodada seguinte começa pelos MESMOS turnos da etapa anterior, byte a byte (o histórico só cresce no fim), mesmo com a abertura de 26 esquemas no meio dele.
      expect(seen[2]!.turns.slice(0, seen[1]!.turns.length)).toEqual(seen[1]!.turns);
    } finally { await world.cleanup(); }
  }, 90_000);

  it('o que já está na lista não vem de novo, grupo sem ferramenta no registry e caminho inexistente respondem com os caminhos disponíveis, e a lista fixa não muda em nenhum caso', async () => {
    const world = await createRunsWorld({ coreCatalog: true, contextWindow: 'product' });
    try {
      await world.models.test('opencode/glm-5.1');
      world.engine.start();
      const bot = await world.createBot();
      const seen = script(world, [[event(ABRIR_GRUPO, { path: 'artefatos/tabelas/dados' })], [event(ABRIR_GRUPO, { path: 'ferramentas/web' })], [event(ABRIR_GRUPO, { path: 'nao/existe' })], [event(ABRIR_GRUPO, { path: ' FERRAMENTAS ' })]]);
      const run = await world.send(bot, 'Abra os grupos'); await world.waitForStatus(run, 'completed');
      const rows = await activitiesOf(world, run);
      expect(rows.map((row) => row.status)).toEqual(['completed', 'failed', 'failed', 'completed']);
      // dados: as mais usadas (table_query e table_write) ficam em inYourList e sem esquema; o resto vem aberto, na ordem da árvore.
      expect(JSON.parse(toolTurns(seen[1]!)[0]!)).toEqual({ path: 'artefatos/tabelas/dados', opened: ['table_list', 'table_get', 'table_import_attachment'], inYourList: ['table_query', 'table_write'] });
      expect(toolTurns(seen[1]!).slice(1).map((text) => (JSON.parse(text) as ChatTool).name)).toEqual(['table_list', 'table_get', 'table_import_attachment']);
      // web: o registry deste mundo não tem a pesquisa na web; a resposta lista os caminhos que existem, sem o dela.
      const webFailure = JSON.parse(rows[1]!.content) as { code: string; message: string };
      expect(webFailure.code).toBe('TOOL_NOT_FOUND');
      expect(webFailure.message).toContain('Nenhuma ferramenta de "ferramentas/web"');
      expect(webFailure.message).toContain('artefatos/docs');
      expect(webFailure.message).not.toContain('ferramentas/web,');
      expect(JSON.parse(rows[2]!.content)).toMatchObject({ code: 'TOOL_NOT_FOUND', message: expect.stringContaining('Grupo desconhecido: "nao/existe"') });
      // Galho de nível 1, com caixa e espaços: tudo o que o registry tem sob ele (sem a web nem o Python, que este mundo não tem), menos o que já está na lista (edit_memory, a única da lista padrão sob este galho, e read_activity).
      const level1 = JSON.parse(toolTurns(seen[4]!).find((text) => text.includes('"path":"ferramentas"'))!) as { path: string; opened: string[]; inYourList: string[] };
      expect(level1).toEqual({ path: 'ferramentas', opened: ['update_objective', 'propose_routine', 'propose_routine_change', 'list_routines', 'get_routine', 'search_history', 'read_attachment'], inYourList: ['edit_memory', READ_ACTIVITY] });
      for (const request of seen) expect(JSON.stringify(request.tools)).toBe(JSON.stringify(seen[0]!.tools));
      expect(toolNames(seen[0]!)).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...DEFAULT_MOST_USED]);
    } finally { await world.cleanup(); }
  }, 60_000);
});

// A reconstrução do pedido a partir da linha gravada de uma abertura (`buildTurns`, `resultForModel`, `read_activity`): um resultado por esquema, ids estáveis e as formas que ficam num resultado só.
describe('a abertura de grupo no histórico: um resultado por esquema (A24), ids estáveis e formas de um resultado só (phase 15, passo 11)', () => {
  const opening = {
    path: 'artefatos/docs', opened: ['doc_list', 'doc_read'], inYourList: [],
    schemas: [
      { name: 'doc_list', description: 'Lista os docs.', parameters: { type: 'object', additionalProperties: false } },
      { name: 'doc_read', description: 'Lê um doc. '.repeat(120), parameters: { type: 'object', properties: { docId: { type: 'string' } }, required: ['docId'] } },
    ],
  };
  const user: ContextRow = { id: '1', run_id: '1', role: 'user', kind: 'text', status: 'done', opens_round: true, step: null, content: 'Abra os docs.', data: {} };
  const openingRow = (over: Partial<ContextRow> = {}, callId = 'call-open-1'): ContextRow => ({
    id: '10', run_id: '1', role: 'assistant', kind: 'activity', status: 'completed', opens_round: false, step: 1, content: JSON.stringify(opening), tool_arguments: '{"path":"artefatos/docs"}',
    data: { callId, tool: ABRIR_GRUPO, label: 'Abrir artefatos/docs', arguments: '{"path":"artefatos/docs"}', detail: null }, ...over,
  });
  const callsOf = (turns: ChatTurn[]) => turns.flatMap((turn) => (turn.role === 'assistant' ? turn.toolCalls : []));
  const resultsOf = (turns: ChatTurn[]) => turns.flatMap((turn) => (turn.role === 'tool' ? [turn] : []));

  it('uma linha concluída vira a chamada real com o resumo e uma chamada por esquema, cada uma com o seu resultado íntegro, com ids derivados do id da chamada e iguais em qualquer reconstrução', () => {
    const turns = buildTurns([user, openingRow()]);
    const calls = callsOf(turns), results = resultsOf(turns);
    expect(calls.map((call) => call.name)).toEqual([ABRIR_GRUPO, ABRIR_GRUPO, ABRIR_GRUPO]);
    expect(calls[0]).toMatchObject({ id: 'call-open-1', arguments: '{"path":"artefatos/docs"}' });
    expect(calls.slice(1).map((call) => call.arguments)).toEqual(['{"path":"doc_list"}', '{"path":"doc_read"}']);
    expect(results.map((turn) => turn.callId)).toEqual(calls.map((call) => call.id));
    expect(JSON.parse(results[0]!.text)).toEqual({ path: 'artefatos/docs', opened: ['doc_list', 'doc_read'], inYourList: [] });
    expect(results.slice(1).map((turn) => JSON.parse(turn.text) as unknown)).toEqual(opening.schemas);
    // Estável: reconstruir dá os mesmos turnos; o mesmo esquema aberto por outra chamada ganha outro id (nenhum id repete no histórico).
    expect(buildTurns([user, openingRow()])).toEqual(turns);
    const again = callsOf(buildTurns([user, openingRow(), openingRow({ id: '11', step: 2 }, 'call-open-2')]));
    expect(new Set(again.map((call) => call.id)).size).toBe(again.length);
    for (const call of calls.slice(1)) expect(call.id).toMatch(/^abrir_[0-9a-f]{24}$/u);
    // Tudo o que a linha pesa no pedido é a soma dos resultados (o custo estimado da linha), e `read_activity` (part=result) devolve essa mesma forma inteira.
    const joined = [results[0]!.text, ...results.slice(1).map((turn) => turn.text)].join('\n\n');
    expect(resultForModel(openingRow())).toBe(joined);
    expect(fullResultForModel(openingRow())).toBe(joined);
  });

  it('falha, chamada interrompida, resultado mascarado com a conversa fria e conteúdo que não é uma abertura ficam num resultado só, como qualquer ferramenta', () => {
    const failure = JSON.stringify({ code: 'TOOL_NOT_FOUND', message: 'Grupo desconhecido: "x". Caminhos que existem: artefatos/docs.' });
    const failed = buildTurns([user, openingRow({ status: 'failed', content: failure })]);
    expect(callsOf(failed)).toHaveLength(1);
    expect(resultsOf(failed).map((turn) => turn.text)).toEqual([failure]);
    const running = buildTurns([user, openingRow({ status: 'running' })]);
    expect(callsOf(running)).toHaveLength(1);
    expect(resultsOf(running).map((turn) => turn.text)).toEqual([INTERRUPTED_CALL_RESULT]);
    // Mascarado (conversa fria, resultado acima de COLD_MASK_MIN_CHARS): o marcador de sempre, que manda reler, sem os esquemas.
    expect(openingRow().content.length).toBeGreaterThan(COLD_MASK_MIN_CHARS);
    const masked = buildTurns([user, openingRow({ cold_masked: true })]);
    expect(callsOf(masked)).toHaveLength(1);
    expect(resultsOf(masked).map((turn) => turn.text)).toEqual([`[resultado de ${ABRIR_GRUPO}, ${openingRow().content.length.toLocaleString('pt-BR')} caracteres, #10; releia com ${READ_ACTIVITY}]`]);
    expect(resultForModel(openingRow({ cold_masked: true }))).toBe(resultsOf(masked)[0]!.text);
    // Conteúdo que não é uma abertura (gravação cortada em 256 KiB, forma desconhecida): um resultado comum.
    const cut = buildTurns([user, openingRow({ content: JSON.stringify(opening).slice(0, 200) })]);
    expect(callsOf(cut)).toHaveLength(1);
    expect(parseGroupOpening('{"path":"x"}')).toBeNull();
    expect(parseGroupOpening('não é JSON')).toBeNull();
    // A porta chamada pela use_tool nunca vira abertura (a use_tool recusa abrir_grupo): linha com `via` fica como veio.
    const viaPort = buildTurns([user, openingRow({ data: { callId: 'c', tool: ABRIR_GRUPO, via: USE_TOOL, label: 'x', arguments: '{}', detail: null } })]);
    expect(callsOf(viaPort)).toHaveLength(1);
  });

  it('o resumo da abertura diz quando todas as ferramentas já estavam na lista, e cada esquema é o JSON da definição', () => {
    const results = groupOpeningResults({ path: 'ferramentas/memoria', opened: [], inYourList: ['edit_memory'], schemas: [] });
    expect(JSON.parse(results.summary)).toEqual({ path: 'ferramentas/memoria', opened: [], inYourList: ['edit_memory'], note: 'Todas já estão na sua lista: chame direto.' });
    expect(results.schemas).toEqual([]);
    expect(groupOpeningResults(opening).schemas.map((schema) => JSON.parse(schema.text) as unknown)).toEqual(opening.schemas);
  });
});

// A31, A46 e A32 no motor real.
describe('regra de aprovação, Chat geral e registro único no motor real (phase 15, passo 11)', () => {
  function script(world: World, steps: ChatEvent[][]): ChatRequest[] {
    const seen: ChatRequest[] = [];
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
      seen.push(structuredClone(request));
      yield* steps[seen.length - 1] ?? [{ type: 'text', text: 'Concluído' }];
      yield { type: 'done', reason: 'stop' };
    });
    return seen;
  }
  const activitiesOf = async (world: World, run: string) =>
    (await world.pool.query<{ status: string; content: string; data: Record<string, unknown> }>("SELECT status, content, data FROM messages WHERE run_id = $1 AND kind = 'activity' ORDER BY messages.id", [run])).rows;

  it('A31: a regra de aprovação gravada com o nome da ação antes da árvore vale para a mesma ferramenta aberta por abrir_grupo e chamada por use_tool (e pelo nome): negar não executa, permitir executa uma vez', async () => {
    const world = await createRunsWorld();
    try {
      await world.models.test('opencode/glm-5.1');
      world.engine.start();
      const bot = await world.createBot();
      const docs = new DocService({ pool: world.pool });
      const doc = await docs.create({ title: 'Plano', content: 'Texto', botIds: [bot.id], operationId: randomUUID() }, { kind: 'owner' });
      const exists = async () => Number((await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM docs WHERE id = $1', [doc.id])).rows[0]!.total);
      const args = () => ({ docId: doc.id, operationId: randomUUID() });

      // Antes da árvore, o bot chamava doc_delete direto: sem regra pergunta, e o dono nega "sempre". A regra fica gravada com o slug da ação (`aion_doc_delete`), não com o caminho nem com o nome da porta.
      script(world, [[event('doc_delete', args())]]);
      const first = await world.send(bot, 'Excluir o plano'); await world.waitForStatus(first, 'waiting_approval');
      await world.approvals.respond((await world.approvalOf(first))!.id, 'deny_always', ORIGIN);
      await world.waitForStatus(first, 'completed');
      expect(await exists()).toBe(1);
      const rules = (await world.pool.query<{ action_slug: string; value: string }>('SELECT action_slug, value FROM bot_approval_rules WHERE bot_id = $1', [bot.id])).rows;
      expect(rules).toEqual([{ action_slug: 'aion_doc_delete', value: 'deny' }]);

      // Agora o bot abre o grupo e chama pela porta: a MESMA regra nega, sem pausa, sem cartão e sem efeito, e o nome direto também.
      script(world, [[event(ABRIR_GRUPO, { path: 'artefatos/docs/doc_delete' })], [event(USE_TOOL, { name: 'doc_delete', arguments: args() })], [event('doc_delete', args())]]);
      const second = await world.send(bot, 'Excluir de novo'); await world.waitForStatus(second, 'completed');
      expect(await world.approvalOf(second)).toBeNull();
      expect((await activitiesOf(world, second)).map((row) => [row.data.tool, row.status, row.data.via ?? null])).toEqual([[ABRIR_GRUPO, 'completed', null], ['doc_delete', 'failed', USE_TOOL], ['doc_delete', 'failed', null]]);
      expect((await activitiesOf(world, second)).slice(1).map((row) => row.content)).toEqual([NOT_EXECUTED_RESULTS.deniedByRule, NOT_EXECUTED_RESULTS.deniedByRule]);
      expect(await exists()).toBe(1);

      // A mesma regra, agora "permitir": a chamada pela porta executa direto (uma vez), sem pausar.
      await world.pool.query("UPDATE bot_approval_rules SET value = 'allow' WHERE bot_id = $1 AND action_slug = 'aion_doc_delete'", [bot.id]);
      script(world, [[event(USE_TOOL, { name: 'doc_delete', arguments: args() })]]);
      const third = await world.send(bot, 'Excluir com a regra liberada'); await world.waitForStatus(third, 'completed');
      expect(await world.approvalOf(third)).toBeNull();
      expect((await activitiesOf(world, third))[0]).toMatchObject({ status: 'completed', data: { tool: 'doc_delete', via: USE_TOOL } });
      expect(await exists()).toBe(0);
      // A regra continua uma só, a do slug: nada foi regravado com o caminho novo.
      expect((await world.pool.query('SELECT 1 FROM bot_approval_rules WHERE bot_id = $1', [bot.id])).rowCount).toBe(1);
    } finally { await world.cleanup(); }
  }, 90_000);

  it('A46: o Chat geral segue com as mesmas 7 ferramentas (as core, read_activity, discover_tools e a web depois de selecionada), sem árvore no pedido, sem conector e sem docs, mesmo com o catálogo completo ligado', async () => {
    const sandbox = await startFakeSandbox();
    const world = await createRunsWorld({ coreCatalog: true, webSearch: true, python: { url: sandbox.url, token: sandbox.token }, contextWindow: 'product' });
    try {
      await world.models.test('opencode/glm-5.1');
      await world.connectComposio();
      world.engine.start();
      const { send } = await chatSession(world);
      const seen = script(world, [[event(DISCOVER_TOOLS, { names: ['web_search', 'web_fetch'] })]]);
      await world.waitForStatus(await send('Pesquise algo'), 'completed');
      // Antes da seleção: as core e as duas portas do Chat geral; depois dela, as 7 de hoje, nesta ordem.
      expect(toolNames(seen[0]!)).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'search_history', 'read_attachment', RUN_PYTHON_TOOL]);
      expect(toolNames(seen[1]!)).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'search_history', 'read_attachment', RUN_PYTHON_TOOL, WEB_SEARCH_TOOL, WEB_FETCH_TOOL]);
      // Sem árvore: nenhuma porta de grupo, nenhum galho, nenhum conector, nenhum doc nem tabela, nem nas definições nem no sistema.
      for (const request of seen) {
        const everything = JSON.stringify([request.tools, request.turns[0]]);
        for (const absent of [ABRIR_GRUPO, USE_TOOL, 'artefatos/', 'conector/', 'ferramentas/', 'composio', 'edit_memory', 'doc_list', 'table_list']) expect(everything, absent).not.toContain(absent);
        expect(request.tools!.map((tool) => tool.name).filter((name) => /^(doc|table|composio)_/u.test(name))).toEqual([]);
      }
    } finally { await world.cleanup(); await sandbox.stop(); }
  }, 60_000);

  it('A32: uma ferramenta nova entra com UM registro (o nome dela no galho certo de TOOL_TREE): o índice de abrir_grupo, a abertura e a chamada por use_tool a enxergam sem outra edição', async () => {
    const extra = defineTool({ definition: { name: 'nova_ferramenta', description: 'Faz algo novo.', parameters: { type: 'object', properties: {}, additionalProperties: false } }, argsSchema: z.strictObject({}), label: () => 'Nova', execute: async () => ({ result: 'nova ok' }) });
    (TOOL_TREE as ToolGroup[]).push({ path: 'ferramentas/teste', when: 'um grupo só do teste', tools: ['nova_ferramenta'] });
    const world = await createRunsWorld({ tools: [extra] });
    try {
      await world.models.test('opencode/glm-5.1');
      world.engine.start();
      const bot = await world.createBot();
      const seen = script(world, [[event(ABRIR_GRUPO, { path: 'ferramentas/teste' })], [event(USE_TOOL, { name: 'nova_ferramenta', arguments: {} })]]);
      const run = await world.send(bot, 'Use a nova'); await world.waitForStatus(run, 'completed');
      // O índice da árvore está no turno de sistema do bot (passo 12): a ferramenta nova aparece nele, e não na descrição de abrir_grupo.
      expect(seen[0]!.turns[0]!.text).toContain('- ferramentas/teste: um grupo só do teste (nova_ferramenta)');
      expect(seen[0]!.tools!.find((tool) => tool.name === ABRIR_GRUPO)!.description).not.toContain('nova_ferramenta');
      expect(JSON.parse(seen[1]!.turns.filter((turn) => turn.role === 'tool').at(-1)!.text)).toEqual(extra.definition);
      expect((await activitiesOf(world, run)).map((row) => [row.data.tool, row.status, row.content])).toEqual([[ABRIR_GRUPO, 'completed', expect.any(String)], ['nova_ferramenta', 'completed', 'nova ok']]);
    } finally { (TOOL_TREE as ToolGroup[]).pop(); await world.cleanup(); }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// As "mais usadas" do bot e o índice da árvore no sistema (phase 15, passo 12; decisões 23 e 24; A25, A32, A42 a A45)
// ---------------------------------------------------------------------------------------------
/**
 * Grava, à mão, uma execução do bot na conversa (a linha de `runs`, e a de `model_call_usage` quando `callAt` vem): é o que a contagem das mais usadas (`resolveMostUsed`, as execuções ENCERRADAS até a âncora) e a
 * regra de conversa fria (`readMostUsedAnchor`, a última chamada ao modelo e as execuções que ainda estavam ativas) leem. `finishedAt` nulo deixa a execução aberta (ativa). Devolve o id dela.
 */
async function seedRun(world: World, conversationId: string, { createdAt, finishedAt = createdAt, callAt = null }: { createdAt: Date; finishedAt?: Date | null; callAt?: Date | null }): Promise<string> {
  const inserted = await world.pool.query<{ id: string }>(
    "INSERT INTO runs(conversation_id, bot_id, status, input, created_at, started_at, finished_at) SELECT $1, bot_id, $2, 'seed', $3, $3, $4 FROM conversations WHERE id = $1 RETURNING id::text",
    [conversationId, finishedAt === null ? 'waiting_approval' : 'completed', createdAt, finishedAt],
  );
  const runId = inserted.rows[0]!.id;
  if (callAt !== null) {
    await world.pool.query("INSERT INTO model_call_usage(id, conversation_id, run_id, purpose, model, protocol, state, created_at) VALUES($1, $2, $3, 'main', 'opencode/glm-5.1', 'chat_completions', 'unknown', $4)", [randomUUID(), conversationId, runId, callAt]);
  }
  return runId;
}

/**
 * Grava `count` atividades de `tool` com a data e o estado dados, dentro de uma execução própria encerrada em `finishedAt` (a mesma data por padrão): as linhas do histórico do bot que a contagem das
 * mais usadas lê (`resolveMostUsed`). `finishedAt` depois da âncora (ou nulo) é a execução que ainda estava aberta nela. Devolve o id da execução.
 */
async function seedUse(world: World, conversationId: string, tool: string, count: number, at: Date, status = 'completed', { finishedAt = at, callAt = null }: { finishedAt?: Date | null; callAt?: Date | null } = {}): Promise<string> {
  const runId = await seedRun(world, conversationId, { createdAt: at, finishedAt, callAt });
  for (let index = 0; index < count; index += 1) {
    await world.pool.query("INSERT INTO messages(conversation_id, run_id, role, kind, status, step, content, data, created_at) VALUES($1, $2, 'assistant', 'activity', $3, 1, 'ok', $4::jsonb, $5)", [conversationId, runId, status, JSON.stringify({ tool }), at]);
  }
  return runId;
}

describe('as mais usadas do bot: escolha pelo uso, teto, histerese e par de rotinas (phase 15, passo 12; decisão 24)', () => {
  /** O registry padrão do bot: as internas de verdade, com os bytes reais das definições. */
  const registry = new Map<string, ToolHandler>(INTERNAL_TOOLS.map((tool) => [tool.definition.name, tool]));
  const usage = (entries: Record<string, number>): Map<string, number> => new Map(Object.entries(entries));
  const bytesOf = (names: readonly string[]): number => names.reduce((sum, name) => sum + Buffer.byteLength(JSON.stringify(registry.get(name)!.definition), 'utf8'), 0);
  /** Sem teto de bytes: a prova da regra de ranking não depende do valor escolhido para `MOST_USED_MAX_BYTES`. */
  const WIDE = { maxTools: MOST_USED_MAX_TOOLS, maxBytes: 1_000_000 };

  it('A44: sem uso a lista é a padrão do Aion, que cabe nas até 5 ferramentas e no teto em bytes; uso de porta, de slug do conector e de nome desconhecido não conta', () => {
    expect(selectMostUsed(registry, usage({}))).toEqual([...DEFAULT_MOST_USED]);
    expect(DEFAULT_MOST_USED.length).toBeLessThanOrEqual(MOST_USED_MAX_TOOLS);
    expect(bytesOf(DEFAULT_MOST_USED)).toBeLessThanOrEqual(MOST_USED_MAX_BYTES);
    const noise = usage({ [READ_ACTIVITY]: 99, [ABRIR_GRUPO]: 99, [USE_TOOL]: 99, composio_execute_action: 99, composio_search_actions: 99, GMAIL_FETCH_EMAILS: 99, fantasma: 99 });
    expect(selectMostUsed(registry, noise)).toEqual([...DEFAULT_MOST_USED]);
    // Nenhuma porta jamais é candidata, nem com a lista inteira de registry (as do conector e as de exposição).
    const withPorts = new Map(registry);
    for (const name of [ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...CONNECTOR_PORTS]) withPorts.set(name, localTool(name, true, 1));
    expect(selectMostUsed(withPorts, noise)).toEqual([...DEFAULT_MOST_USED]);
  });

  it('A42: o uso do bot ordena a lista (até 5), o titular completa as vagas que o uso não preenche, e só entra o que o registry tem', () => {
    const used = usage({ table_create: 40, update_objective: 30, doc_create: 25, table_update: 3 });
    expect(selectMostUsed(registry, used, WIDE)).toEqual(['table_create', 'update_objective', 'doc_create', 'table_update', DEFAULT_MOST_USED[0]]);
    // Menos uso que vagas: os titulares completam, na ordem da lista padrão.
    expect(selectMostUsed(registry, usage({ table_create: 5 }), WIDE)).toEqual(['table_create', 'table_query', 'table_write', 'edit_memory']); // o par de rotinas não cabe nas 5 vagas depois destas 4
    // O registry decide: sem a ferramenta nele, ela nunca aparece, por mais usada que seja.
    const small = new Map([...registry].filter(([name]) => ['table_query', 'edit_memory', 'doc_create'].includes(name)));
    expect(selectMostUsed(small, usage({ table_create: 99, doc_create: 7 }), WIDE)).toEqual(['doc_create', 'table_query', 'edit_memory']);
    expect(selectMostUsed(new Map(), usage({ table_create: 99 }), WIDE)).toEqual([]);
  });

  it('desempate determinístico: a mesma contagem dá a mesma lista em qualquer ordem de leitura, decidida pelo titular, pela lista padrão e pela ordem da árvore', () => {
    const forward = usage({ doc_create: 5, doc_append: 5, table_create: 5, table_update: 5 });
    const backward = usage({ table_update: 5, table_create: 5, doc_append: 5, doc_create: 5 });
    const options = { maxTools: 2, maxBytes: 1_000_000 };
    expect(selectMostUsed(registry, forward, options)).toEqual(['doc_create', 'doc_append']);
    expect(selectMostUsed(registry, backward, options)).toEqual(['doc_create', 'doc_append']);
    // Empate entre o titular e o desafiante na pontuação (17 contra 10 × 1,5 + 2): vence quem tem mais usos.
    expect(selectMostUsed(registry, usage({ table_query: 10, doc_create: 17 }), { maxTools: 1, maxBytes: 1_000_000 })).toEqual(['doc_create']);
  });

  it('histerese: um desafiante só desbanca o titular com pelo menos 50% a mais de usos (1,5 × usos + 2); diferença pequena não troca a lista', () => {
    const one = { maxTools: 1, maxBytes: 1_000_000 };
    const holder = DEFAULT_MOST_USED[0]!; // table_query: 10 usos valem 17 de pontuação
    expect(selectMostUsed(registry, usage({ [holder]: 10, doc_create: 16 }), one)).toEqual([holder]);
    expect(selectMostUsed(registry, usage({ [holder]: 10, doc_create: 17 }), one)).toEqual(['doc_create']);
    // Titular sem uso: um único uso do desafiante não basta (1 < 2), dois sim.
    expect(selectMostUsed(registry, usage({ doc_create: 1 }), one)).toEqual([holder]);
    expect(selectMostUsed(registry, usage({ doc_create: 2 }), one)).toEqual(['doc_create']);
  });

  it('propose_routine e propose_routine_change entram ou saem juntas: o uso é a soma, ocupam duas vagas e pesam a soma dos bytes', () => {
    const pair = [...MOST_USED_TOGETHER[0]!];
    expect(pair).toEqual(['propose_routine', 'propose_routine_change']);
    // O uso de uma só puxa as duas.
    expect(selectMostUsed(registry, usage({ propose_routine: 30 }), WIDE).slice(0, 2)).toEqual(pair);
    expect(selectMostUsed(registry, usage({ propose_routine_change: 30 }), WIDE).slice(0, 2)).toEqual(pair);
    // Sem as duas vagas, nenhuma entra: 3 ferramentas mais usadas ocupam 3 das 4 vagas e o par (2) não cabe; o titular seguinte (1 vaga) entra.
    const crowded = usage({ table_create: 200, update_objective: 150, doc_create: 120, propose_routine: 20 });
    const four = selectMostUsed(registry, crowded, { maxTools: 4, maxBytes: 1_000_000 });
    expect(four).toEqual(['table_create', 'update_objective', 'doc_create', DEFAULT_MOST_USED[0]]);
    // Sem os bytes do par, nenhuma entra: o teto é a soma exata dos bytes de `table_query` e `edit_memory` (derivada das definições, não um número fixo que mudaria a cada ajuste de descrição), o par pesa
    // bem mais que isso e fica de fora mesmo sendo o mais usado, e `table_write` já não cabe depois das duas.
    const cap = bytesOf(['table_query', 'edit_memory']);
    const heavy = selectMostUsed(registry, usage({ propose_routine: 50, table_query: 40, edit_memory: 30, table_write: 20 }), { maxTools: 5, maxBytes: cap });
    expect(heavy).toEqual(['table_query', 'edit_memory']);
    expect(bytesOf(['propose_routine', 'propose_routine_change'])).toBeGreaterThan(cap);
    // Propriedade: em qualquer combinação de uso e de vagas, as duas estão juntas ou as duas ausentes.
    for (const maxTools of [1, 2, 3, 4, 5]) for (const used of [{}, { propose_routine: 1 }, { propose_routine_change: 40, table_create: 3 }, { table_create: 90, update_objective: 80, doc_create: 70, propose_routine: 60 }] as Record<string, number>[]) {
      const chosen = selectMostUsed(registry, usage(used), { maxTools, maxBytes: 1_000_000 });
      expect(chosen.includes('propose_routine'), JSON.stringify([maxTools, used])).toBe(chosen.includes('propose_routine_change'));
    }
  });

  it('o teto em bytes do conjunto é respeitado em qualquer uso, a ferramenta que não cabe é pulada e a seguinte ainda pode entrar, e o conjunto nunca passa de 5 ferramentas', () => {
    const heaviest = usage({ propose_routine: 99, table_prepare_operation: 90, table_update: 80, table_create: 70, table_import_attachment: 60, table_formula_preview: 50, table_query: 40 });
    const chosen = selectMostUsed(registry, heaviest);
    expect(bytesOf(chosen)).toBeLessThanOrEqual(MOST_USED_MAX_BYTES);
    expect(chosen.length).toBeLessThanOrEqual(MOST_USED_MAX_TOOLS);
    expect(chosen.length).toBeGreaterThan(0);
    // Teto de 5.200: a mais usada (4.254) cabe, a segunda (4.092) não, e a terceira, leve (869), entra no que sobra.
    const capped = selectMostUsed(registry, usage({ table_prepare_operation: 90, table_update: 80, update_objective: 70 }), { maxTools: 5, maxBytes: 5_200 });
    expect(capped).toEqual(['table_prepare_operation', 'update_objective']);
    expect(bytesOf(capped)).toBeLessThanOrEqual(5_200);
  });
});

/** Aplica um checkpoint como a compactação o faz (a única escrita que sobe a revisão), cobrindo as linhas dadas. */
async function compact(world: World, conversationId: string, summary: string, at: Date, covered: readonly ContextRow[] = []): Promise<void> {
  const managed = await loadManagedContext(world.pool, conversationId);
  expect(await commitContextSummary(world.pool, conversationId, managed.checkpoint.revision, summary, covered, mergeEvidence(), at)).toBe(true);
}

/** Roteiro do modelo por rodada: guarda os pedidos (clonados) e devolve os eventos do passo seguinte da rodada, ou o texto final. */
function driver(world: World) {
  const seen: ChatRequest[] = [];
  let plan: ChatEvent[][] = [];
  vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
    seen.push(structuredClone(request));
    yield* plan.shift() ?? [{ type: 'text', text: 'Concluído' }];
    yield { type: 'done', reason: 'stop' };
  });
  return {
    seen,
    /** Envia a mensagem, espera concluir e devolve só os pedidos dessa rodada. */
    async round(bot: Bot, text: string, steps: ChatEvent[][] = []): Promise<ChatRequest[]> {
      const from = seen.length;
      plan = [...steps];
      await world.waitForStatus(await world.send(bot, text), 'completed');
      return seen.slice(from);
    },
  };
}

describe('a lista vigente das mais usadas, lida do banco (phase 15, passo 12; A42 a A44)', () => {
  const registry = new Map<string, ToolHandler>(INTERNAL_TOOLS.map((tool) => [tool.definition.name, tool]));
  const usage = (entries: Record<string, number>): Map<string, number> => new Map(Object.entries(entries));
  const DAY = 86_400_000;

  it('sem recálculo (a conversa nunca esfriou nem foi compactada) vale a lista padrão, mesmo com uso gravado; depois da compactação vale o uso dos 30 dias ANTERIORES a ela, e só o uso de ferramenta da árvore concluído ou com falha', async () => {
    const world = await createRunsWorld({ coreCatalog: true });
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const cut = new Date('2026-03-10T12:00:00Z');
      const before = (days: number): Date => new Date(cut.getTime() - days * DAY);
      await seedUse(world, conversationId, 'table_create', 12, before(2));
      await seedUse(world, conversationId, 'update_objective', 9, before(29)); // ainda dentro da janela de 30 dias
      await seedUse(world, conversationId, 'table_delete_table', 4, before(1), 'failed'); // a falha também é uso
      await seedUse(world, conversationId, 'doc_create', 50, before(31)); // fora da janela
      await seedUse(world, conversationId, 'doc_list', 50, new Date(cut.getTime() + 60_000)); // depois da compactação: só vale na seguinte
      await seedUse(world, conversationId, 'table_update', 50, before(1), 'discarded'); // abandonada por reinício
      await seedUse(world, conversationId, 'table_views', 50, before(1), 'running'); // em andamento
      await seedUse(world, conversationId, 'GMAIL_FETCH_EMAILS', 80, before(1)); // slug do conector, gravado em data.tool pela porta
      await seedUse(world, conversationId, 'composio_execute_action', 80, before(1)); // porta
      await seedUse(world, conversationId, ABRIR_GRUPO, 80, before(1)); // porta
      // Sem recálculo (nenhuma compactação, e a conversa nunca ficou 40 minutos sem chamar o modelo): a âncora é nula e a lista é a padrão (A44), por mais uso que haja.
      const fresh = await readMostUsedAnchor(world.pool, conversationId);
      expect(fresh).toBeNull();
      expect(await resolveMostUsed(world.pool, conversationId, registry, fresh)).toEqual(selectMostUsed(registry, usage({})));
      // Compactação aplicada: a âncora é o instante dela e a lista passa a vir do uso encerrado antes dele.
      await compact(world, conversationId, 'Checkpoint 1.', cut);
      const first = await readMostUsedAnchor(world.pool, conversationId);
      expect(first).toEqual(cut);
      const list = await resolveMostUsed(world.pool, conversationId, registry, first);
      expect(list).toEqual(selectMostUsed(registry, usage({ table_create: 12, update_objective: 9, table_delete_table: 4 })));
      expect(list.slice(0, 3)).toEqual(['table_create', 'update_objective', 'table_delete_table']);
      // Função só da âncora e do que veio antes dela: reler dá a mesma lista (A43), e uso novo depois do corte não a muda.
      expect(await resolveMostUsed(world.pool, conversationId, registry, first)).toEqual(list);
      await seedUse(world, conversationId, 'doc_rewrite', 200, new Date(cut.getTime() + 2 * DAY));
      expect(await resolveMostUsed(world.pool, conversationId, registry, await readMostUsedAnchor(world.pool, conversationId))).toEqual(list);
      // Outra compactação (A42): o uso entre as duas passa a valer e a lista é recalculada.
      await compact(world, conversationId, 'Checkpoint 2.', new Date(cut.getTime() + 3 * DAY));
      const second = await readMostUsedAnchor(world.pool, conversationId);
      expect(second).toEqual(new Date(cut.getTime() + 3 * DAY));
      const recalculated = await resolveMostUsed(world.pool, conversationId, registry, second);
      expect(recalculated).not.toEqual(list);
      expect(recalculated.slice(0, 2)).toEqual(['doc_rewrite', 'doc_list']);
    } finally { await world.cleanup(); }
  }, 60_000);

  it('A43, A44, A45 e A42: a lista é a padrão numa conversa nova e idêntica entre etapas e rodadas mesmo com o uso mudando; só uma compactação a recalcula, e o índice do sistema não muda', async () => {
    const world = await createRunsWorld({ coreCatalog: true, contextWindow: 'product' });
    try {
      await world.models.test('opencode/glm-5.1');
      world.engine.start();
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const { seen, round } = driver(world);
      const portsAndDefault = [ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...DEFAULT_MOST_USED];
      // Rodada 1 (duas etapas: abre um grupo e responde) e rodada 2: a lista padrão, byte a byte igual em toda etapa e rodada (A44, A43).
      const first = await round(bot, 'Abra os docs', [[event(ABRIR_GRUPO, { path: 'artefatos/docs' })]]);
      const second = await round(bot, 'Outra mensagem');
      expect(first).toHaveLength(2);
      for (const request of [...first, ...second]) expect(toolNames(request)).toEqual(portsAndDefault);
      const baseline = toolsBytes('chat_completions', first[0]!);
      for (const request of [...first, ...second]) expect(toolsBytes('chat_completions', request)).toBe(baseline);
      // O uso do bot muda (outras ferramentas passam a ser as mais chamadas), mas sem compactação a lista não se mexe (A43).
      const yesterday = new Date(Date.now() - 86_400_000);
      const sinceBaselineUse = { table_create: 12, update_objective: 9 };
      for (const [tool, count] of Object.entries(sinceBaselineUse)) await seedUse(world, conversationId, tool, count, yesterday);
      const third = await round(bot, 'Mais uma');
      expect(toolsBytes('chat_completions', third[0]!)).toBe(baseline);
      // Compactação aplicada (cobre a primeira rodada): a lista é recalculada AGORA, pelo uso anterior a ela, e fica a mesma depois (A42).
      const managed = await loadManagedContext(world.pool, conversationId);
      const secondOpening = managed.rows.filter((row) => row.opens_round)[1]!.id!;
      const covered = managed.rows.filter((row) => BigInt(row.id!) < BigInt(secondOpening));
      expect(await commitContextSummary(world.pool, conversationId, managed.checkpoint.revision, 'Checkpoint da rodada 1.', covered, mergeEvidence(), new Date())).toBe(true);
      const fourth = await round(bot, 'Depois da compactação', [[event(ABRIR_GRUPO, { path: 'ferramentas/objetivo' })]]);
      const expected = [ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...selectMostUsed(new Map(INTERNAL_TOOLS.map((tool) => [tool.definition.name, tool])), new Map(Object.entries(sinceBaselineUse)))];
      expect(toolNames(fourth[0]!)).toEqual(expected);
      expect(toolNames(fourth[0]!)).not.toEqual(portsAndDefault);
      expect(toolNames(fourth[0]!).slice(3, 5)).toEqual(['table_create', 'update_objective']);
      // A porta abrir_grupo acompanha a lista nova: update_objective, que o uso trouxe para a lista, já está nela e não vem de novo (antes da compactação ela teria sido aberta).
      expect(JSON.parse(fourth[1]!.turns.filter((turn) => turn.role === 'tool').at(-1)!.text)).toEqual({ path: 'ferramentas/objetivo', opened: [], inYourList: ['update_objective'], note: 'Todas já estão na sua lista: chame direto.' });
      const afterCompaction = toolsBytes('chat_completions', fourth[0]!);
      expect(afterCompaction).not.toBe(baseline);
      const fifth = await round(bot, 'E outra');
      for (const request of [...fourth, ...fifth]) expect(toolsBytes('chat_completions', request)).toBe(afterCompaction);
      // A45: o índice da árvore está no sistema e não marca o que está carregado; o sistema é o mesmo byte a byte antes e depois de a lista mudar, e o índice nunca citou a mudança.
      const system = seen[0]!.turns[0]!.text;
      expect(system).toContain('\n- ferramentas/rotinas: ');
      for (const request of seen) expect(request.turns[0]!.text).toBe(system);
    } finally { await world.cleanup(); }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// Recálculo das mais usadas na conversa fria (phase 15, passo 12, correção do checkpoint 2; decisão 24 revisada em 2026-11-08, A42 a A45)
// ---------------------------------------------------------------------------------------------
describe('as mais usadas recalculam quando a conversa esfria ou é compactada, e só então, pela contagem congelada no momento do recálculo (decisão 24, A42, A43)', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const BASE = new Date('2026-03-10T12:00:00Z');
  const registry = new Map<string, ToolHandler>(INTERNAL_TOOLS.map((tool) => [tool.definition.name, tool]));
  const usage = (entries: Record<string, number>): Map<string, number> => new Map(Object.entries(entries));
  const portsAnd = (list: readonly string[]): string[] => [ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...list];
  /** Relógio do domínio que o teste move (como o de `cold-maintenance.test.ts`): a data da execução, da chamada ao modelo e da compactação. */
  function createClock() {
    let value = BASE;
    return { now: (): Date => value, advance: (ms: number): void => { value = new Date(value.getTime() + ms); } };
  }
  const count = async (world: World, sql: string): Promise<number> => (await world.pool.query<{ n: number }>(sql)).rows[0]!.n;

  it('uma conversa que esfria recalcula a lista pelo uso, mesmo sem compactação e sem nenhum resultado a mascarar; quente, a lista não muda por mais uso que haja, e a lista nova vale até a conversa esfriar de novo', async () => {
    const clock = createClock();
    const world = await createRunsWorld({ coreCatalog: true, contextWindow: 'product', now: clock.now });
    try {
      await world.models.test('opencode/glm-5.1');
      world.engine.start();
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const { round } = driver(world);
      // Uma execução de quatro horas atrás, encerrada, com a última chamada ao modelo e o uso do bot; nenhum resultado grande, nenhuma compactação.
      const old = new Date(BASE.getTime() - 4 * HOUR);
      await seedUse(world, conversationId, 'table_create', 12, old, 'completed', { finishedAt: new Date(old.getTime() + 5 * MINUTE), callAt: new Date(old.getTime() + 4 * MINUTE) });
      await seedUse(world, conversationId, 'update_objective', 9, new Date(old.getTime() + 6 * MINUTE));

      // A mensagem chega com a conversa fria: a lista é recalculada pelo uso (A42), e não é a padrão.
      const first = await round(bot, 'Primeira');
      const usedSoFar = portsAnd(selectMostUsed(registry, usage({ table_create: 12, update_objective: 9 })));
      expect(toolNames(first[0]!)).toEqual(usedSoFar);
      expect(toolNames(first[0]!)).not.toEqual(portsAnd(DEFAULT_MOST_USED));
      expect(await count(world, 'SELECT count(*)::int AS n FROM context_cold_masks')).toBe(0);
      expect(await count(world, 'SELECT coalesce(max(revision), 0)::int AS n FROM conversation_context')).toBe(0);
      const baseline = toolsBytes('chat_completions', first[0]!);

      // Quente (cinco minutos depois da última chamada): o uso novo, gravado depois do recálculo, não muda a lista (A43).
      clock.advance(5 * MINUTE);
      await seedUse(world, conversationId, 'doc_rewrite', 50, new Date(BASE.getTime() + MINUTE));
      for (const request of await round(bot, 'Segunda')) expect(toolsBytes('chat_completions', request)).toBe(baseline);

      // A conversa esfria (três horas sem chamada): a mensagem seguinte recalcula, agora com o uso novo, e a lista nova fica igual na rodada seguinte.
      clock.advance(3 * HOUR);
      const third = await round(bot, 'Terceira');
      const afterCold = portsAnd(selectMostUsed(registry, usage({ table_create: 12, update_objective: 9, doc_rewrite: 50 })));
      expect(toolNames(third[0]!)).toEqual(afterCold);
      expect(afterCold[3]).toBe('doc_rewrite');
      expect(toolsBytes('chat_completions', third[0]!)).not.toBe(baseline);
      clock.advance(MINUTE);
      for (const request of [...third, ...(await round(bot, 'Quarta'))]) expect(toolsBytes('chat_completions', request)).toBe(toolsBytes('chat_completions', third[0]!));
      expect(await count(world, 'SELECT count(*)::int AS n FROM context_cold_masks')).toBe(0);
    } finally { await world.cleanup(); }
  }, 120_000);

  it('a contagem fica congelada no momento do recálculo: a atividade criada antes da âncora e concluída depois dela não muda a lista em nenhuma etapa, rodada nem execução seguinte', async () => {
    const clock = createClock();
    const world = await createRunsWorld({ coreCatalog: true, contextWindow: 'product', now: clock.now });
    try {
      await world.models.test('opencode/glm-5.1');
      world.engine.start();
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const { round } = driver(world);
      const anchorAt = new Date(BASE.getTime() - HOUR);
      await seedUse(world, conversationId, 'table_create', 12, new Date(BASE.getTime() - 5 * HOUR)); // encerrada bem antes da âncora: conta
      // A execução que estava aberta na âncora: as atividades nasceram antes dela (90 minutos antes de agora), a execução só encerrou 30 minutos antes de agora.
      const open = await seedUse(world, conversationId, 'update_objective', 20, new Date(BASE.getTime() - 90 * MINUTE), 'running', { finishedAt: new Date(BASE.getTime() - 30 * MINUTE) });
      await compact(world, conversationId, 'Checkpoint do recálculo.', anchorAt);

      const first = await round(bot, 'Primeira');
      expect(toolNames(first[0]!)).toEqual(portsAnd(selectMostUsed(registry, usage({ table_create: 12 }))));
      const baseline = toolsBytes('chat_completions', first[0]!);
      // As atividades abertas na âncora são concluídas agora: depois do instante do recálculo, e por isso fora da contagem dele.
      await world.pool.query("UPDATE messages SET status = 'completed' WHERE run_id = $1", [open]);
      clock.advance(MINUTE);
      for (const request of await round(bot, 'Segunda')) expect(toolsBytes('chat_completions', request)).toBe(baseline);
    } finally { await world.cleanup(); }
  }, 120_000);

  it('uma execução parada esperando aprovação mantém a conversa quente: a lista não muda quando ela retoma horas depois, mesmo com a chamada seguinte a mais de 40 minutos da anterior', async () => {
    const guarded = defineTool({
      definition: { name: 'ferramenta_guardada', description: 'Exige aprovação do dono.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      argsSchema: z.strictObject({}), approvalRequired: true, action: { slug: 'TEST_GUARDADA', label: 'Ferramenta guardada', appSlug: 'local', appName: 'Local' },
      label: () => 'Ferramenta guardada', execute: async () => ({ result: 'feito' }),
    });
    const clock = createClock();
    const world = await createRunsWorld({ tools: [...INTERNAL_TOOLS, guarded], coreCatalog: true, contextWindow: 'product', now: clock.now });
    try {
      await world.models.test('opencode/glm-5.1');
      world.engine.start();
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const old = new Date(BASE.getTime() - 4 * HOUR);
      await seedUse(world, conversationId, 'table_create', 12, old, 'completed', { callAt: new Date(old.getTime() + 4 * MINUTE) });
      const seen: ChatRequest[] = [];
      const plan: ChatEvent[][] = [[event(USE_TOOL, { name: 'ferramenta_guardada', arguments: {} })]];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
        seen.push(structuredClone(request));
        yield* plan.shift() ?? [{ type: 'text', text: 'Concluído' }];
        yield { type: 'done', reason: 'stop' };
      });
      const run = await world.send(bot, 'Use a ferramenta guardada');
      await world.waitForStatus(run, 'waiting_approval');
      // A mensagem acordou a conversa fria: a lista vem do uso (table_create), e o dono demora três horas para aprovar.
      expect(toolNames(seen[0]!)).toEqual(portsAnd(selectMostUsed(registry, usage({ table_create: 12 }))));
      // Enquanto isso, outro trabalho encerrado do bot é gravado depois do instante do recálculo, a mais de 40 minutos da última chamada ao modelo (a execução está ativa: a conversa não esfriou).
      await seedUse(world, conversationId, 'doc_rewrite', 50, new Date(BASE.getTime() + HOUR));
      clock.advance(3 * HOUR);
      await world.approvals.respond((await world.approvalOf(run))!.id, 'allow_once', ORIGIN);
      await world.waitForStatus(run, 'completed');
      expect(seen).toHaveLength(2);
      expect(toolsBytes('chat_completions', seen[1]!)).toBe(toolsBytes('chat_completions', seen[0]!));
    } finally { await world.cleanup(); }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// O instante do recálculo (`readMostUsedAnchor`): a regra de conversa fria lida do que está gravado (phase 15, passo 12, correção do checkpoint 2; decisão 24, A42)
// ---------------------------------------------------------------------------------------------
describe('o instante do recálculo das mais usadas: a conversa fria lida do histórico gravado, e a compactação (decisão 24, A42)', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const T = COLD_AFTER_MS;
  const t0 = new Date('2026-03-10T08:00:00Z');
  const at = (ms: number): Date => new Date(t0.getTime() + ms);
  const registry = new Map<string, ToolHandler>(INTERNAL_TOOLS.map((tool) => [tool.definition.name, tool]));
  const usage = (entries: Record<string, number>): Map<string, number> => new Map(Object.entries(entries));

  it('a conversa esfria quando a execução é criada mais de 40 minutos (estritamente) depois da última chamada ao modelo e sem nenhuma execução anterior ativa; dentro disso, nada recalcula', async () => {
    const world = await createRunsWorld({ coreCatalog: true });
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const anchor = (): Promise<Date | null> => readMostUsedAnchor(world.pool, conversationId);
      // A primeira execução da conversa não tem chamada anterior: não há instante para medir a frieza, e vale a lista padrão (A44).
      await seedRun(world, conversationId, { createdAt: t0, finishedAt: at(2 * MINUTE), callAt: at(MINUTE) });
      expect(await anchor()).toBeNull();
      // Criada exatamente T depois da última chamada: ainda quente, como na regra do laço do worker (`coldConversations`).
      const exactly = at(MINUTE + T);
      await seedRun(world, conversationId, { createdAt: exactly, finishedAt: new Date(exactly.getTime() + MINUTE), callAt: new Date(exactly.getTime() + 30_000) });
      expect(await anchor()).toBeNull();
      // Um milissegundo além de T depois da última chamada (a dessa execução): fria, e o instante do recálculo é a criação da execução.
      const cold = new Date(exactly.getTime() + 30_000 + T + 1);
      await seedRun(world, conversationId, { createdAt: cold, finishedAt: new Date(cold.getTime() + 2 * MINUTE), callAt: new Date(cold.getTime() + MINUTE) });
      expect(await anchor()).toEqual(cold);
      // Mensagens seguintes dentro de T da última chamada não recalculam: o instante é o mesmo, mesmo com o uso mudando.
      const warm = new Date(cold.getTime() + 20 * MINUTE);
      await seedRun(world, conversationId, { createdAt: warm, finishedAt: new Date(warm.getTime() + MINUTE), callAt: new Date(warm.getTime() + 30_000) });
      expect(await anchor()).toEqual(cold);
      expect(await anchor()).toEqual(cold); // lido de novo: o mesmo, porque é dado gravado e não o relógio de agora
      // Esfriou de novo: o instante passa a ser o da execução nova, e ele vale mais que o anterior.
      const colder = new Date(warm.getTime() + 30_000 + 3 * HOUR);
      await seedRun(world, conversationId, { createdAt: colder, finishedAt: new Date(colder.getTime() + MINUTE), callAt: new Date(colder.getTime() + 30_000) });
      expect(await anchor()).toEqual(colder);
      // Nenhuma limpeza fria e nenhuma compactação entraram na conta.
      expect((await world.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM context_cold_masks')).rows[0]!.n).toBe(0);
      expect((await world.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM conversation_context WHERE revision > 0')).rows[0]!.n).toBe(0);
    } finally { await world.cleanup(); }
  }, 60_000);

  it('uma execução ativa (inclusive parada esperando aprovação) mantém a conversa quente: quem entra na fila atrás dela não a acorda, nem depois de ela encerrar, e o instante é o da criação dela, não o da retomada', async () => {
    const world = await createRunsWorld({ coreCatalog: true });
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const anchor = (): Promise<Date | null> => readMostUsedAnchor(world.pool, conversationId);
      await seedRun(world, conversationId, { createdAt: t0, finishedAt: at(MINUTE), callAt: at(30_000) });
      // A execução que acorda a conversa e fica esperando a aprovação do dono (aberta: `finished_at` nulo).
      const waking = at(4 * HOUR);
      const waiting = await seedRun(world, conversationId, { createdAt: waking, finishedAt: null, callAt: new Date(waking.getTime() + MINUTE) });
      expect(await anchor()).toEqual(waking);
      // Duas horas depois, outra execução entra na fila atrás dela: a conversa tem execução ativa, então não esfriou e o instante não se mexe.
      await seedRun(world, conversationId, { createdAt: at(6 * HOUR), finishedAt: at(6 * HOUR + MINUTE) });
      expect(await anchor()).toEqual(waking);
      // O dono aprova três horas depois e a execução retoma: uma chamada nova, a mais de 40 minutos da anterior, não acorda a conversa; e, encerrada a execução, a que ficou na fila continua sem acordá-la.
      await world.pool.query("UPDATE runs SET status = 'completed', finished_at = $2 WHERE id = $1", [waiting, at(7 * HOUR)]);
      await world.pool.query("INSERT INTO model_call_usage(id, conversation_id, run_id, purpose, model, protocol, state, created_at) VALUES($1, $2, $3, 'main', 'opencode/glm-5.1', 'chat_completions', 'unknown', $4)", [randomUUID(), conversationId, waiting, at(7 * HOUR - MINUTE)]);
      expect(await anchor()).toEqual(waking);
    } finally { await world.cleanup(); }
  }, 60_000);

  it('a compactação aplicada também é um instante de recálculo: vale o maior entre ela e a última conversa fria, e o checkpoint de uma revisão não adianta a contagem de outra', async () => {
    const world = await createRunsWorld({ coreCatalog: true });
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const anchor = (): Promise<Date | null> => readMostUsedAnchor(world.pool, conversationId);
      await seedRun(world, conversationId, { createdAt: t0, finishedAt: at(MINUTE), callAt: at(30_000) });
      const waking = at(3 * HOUR);
      await seedRun(world, conversationId, { createdAt: waking, finishedAt: at(3 * HOUR + 10 * MINUTE), callAt: at(3 * HOUR + MINUTE) });
      expect(await anchor()).toEqual(waking);
      // Compactação aplicada depois (a conversa segue quente): o instante dela vale mais.
      const compacted = at(3 * HOUR + 5 * MINUTE);
      await compact(world, conversationId, 'Checkpoint 1.', compacted);
      expect(await anchor()).toEqual(compacted);
      // A conversa esfria de novo: a execução nova vale mais que a compactação.
      const colder = at(8 * HOUR);
      await seedRun(world, conversationId, { createdAt: colder, finishedAt: at(8 * HOUR + MINUTE), callAt: at(8 * HOUR + 30_000) });
      expect(await anchor()).toEqual(colder);
      // E uma compactação posterior ainda vale mais.
      await compact(world, conversationId, 'Checkpoint 2.', at(8 * HOUR + 2 * MINUTE));
      expect(await anchor()).toEqual(at(8 * HOUR + 2 * MINUTE));
    } finally { await world.cleanup(); }
  }, 60_000);

  it('a contagem fica congelada no instante do recálculo: só entram as execuções encerradas até ele, e a atividade nascida antes dele e concluída depois não muda a lista', async () => {
    const world = await createRunsWorld({ coreCatalog: true });
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const anchorAt = at(10 * HOUR);
      await seedUse(world, conversationId, 'table_create', 12, at(2 * HOUR)); // encerrada antes do instante: conta
      await seedUse(world, conversationId, 'doc_create', 7, anchorAt); // encerrada exatamente no instante: conta
      // As atividades nasceram antes do instante, mas a execução que as guarda só encerrou depois (e a atividade, concluída depois): ficam fora da contagem do instante.
      const openRun = await seedUse(world, conversationId, 'update_objective', 30, at(9 * HOUR), 'running', { finishedAt: at(10 * HOUR + 20 * MINUTE) });
      const stillOpen = await seedUse(world, conversationId, 'doc_rewrite', 30, at(9 * HOUR), 'running', { finishedAt: null });
      const frozen = await resolveMostUsed(world.pool, conversationId, registry, anchorAt);
      expect(frozen).toEqual(selectMostUsed(registry, usage({ table_create: 12, doc_create: 7 })));
      // Concluídas depois do instante: a lista do mesmo instante é a mesma (a leitura anterior filtrava pelo estado de agora e mudaria).
      await world.pool.query("UPDATE messages SET status = 'completed' WHERE run_id = ANY($1::bigint[])", [[openRun, stillOpen]]);
      expect(await resolveMostUsed(world.pool, conversationId, registry, anchorAt)).toEqual(frozen);
      // Já num instante posterior ao encerramento da primeira, ela entra (a mudança só acontece num novo recálculo).
      const later = await resolveMostUsed(world.pool, conversationId, registry, at(11 * HOUR));
      expect(later[0]).toBe('update_objective');
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('A25: depois de uma compactação o esquema sai do pedido e o modelo o recupera abrindo o caminho de novo (phase 15, passo 12)', () => {
  it('o esquema aberto sai do pedido com o checkpoint; abrir o mesmo caminho devolve o esquema outra vez e a chamada por use_tool termina com o efeito esperado', async () => {
    const world = await createRunsWorld({ contextWindow: 'product' });
    try {
      await world.models.test('opencode/glm-5.1');
      world.engine.start();
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const seen: ChatRequest[] = [];
      let plan: ChatEvent[][] = [];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
        seen.push(structuredClone(request));
        yield* plan.shift() ?? [{ type: 'text', text: 'Concluído' }];
        yield { type: 'done', reason: 'stop' };
      });
      const round = async (text: string, steps: ChatEvent[][] = []): Promise<ChatRequest[]> => { const from = seen.length; plan = [...steps]; await world.waitForStatus(await world.send(bot, text), 'completed'); return seen.slice(from); };
      /** O esquema de `edit_memory` como resultado de ferramenta no pedido (a abertura rende um resultado próprio por ferramenta). */
      const hasSchema = (request: ChatRequest): boolean => request.turns.some((turn) => turn.role === 'tool' && turn.text.includes('"name":"edit_memory"') && turn.text.includes('"parameters"'));

      const opened = await round('Abra a memória', [[event(ABRIR_GRUPO, { path: 'ferramentas/memoria' })]]);
      expect(hasSchema(opened[0]!)).toBe(false);
      expect(hasSchema(opened[1]!)).toBe(true);
      // Compactação aplicada: o checkpoint cobre a rodada da abertura, e o esquema sai do pedido (só resta o resumo).
      const managed = await loadManagedContext(world.pool, conversationId);
      expect(await commitContextSummary(world.pool, conversationId, managed.checkpoint.revision, 'Checkpoint: o dono pediu para abrir o grupo da memória.', managed.rows, mergeEvidence(), new Date())).toBe(true);
      const gone = await round('Anote algo na memória');
      expect(gone[0]!.turns.some((turn) => turn.role === 'user' && turn.text.startsWith('# Resumo derivado'))).toBe(true);
      expect(hasSchema(gone[0]!)).toBe(false);
      // O modelo precisa da ferramenta: reabre o caminho (os esquemas voltam como resultados novos) e chama pela porta; a memória é gravada.
      const note = 'ZQ-A25-compactado';
      const again = await round('Anote ' + note, [[event(ABRIR_GRUPO, { path: 'ferramentas/memoria' })], [event(USE_TOOL, { name: 'edit_memory', arguments: { operation: 'append', content: note } })]]);
      expect(again).toHaveLength(3);
      expect(hasSchema(again[0]!)).toBe(false);
      expect(hasSchema(again[1]!)).toBe(true); // o esquema volta a partir do pedido seguinte à abertura
      const run = (await world.pool.query<{ id: string }>('SELECT max(id)::text AS id FROM runs')).rows[0]!.id;
      const rows = (await world.pool.query<{ status: string; data: { tool: string; via?: string } }>("SELECT status, data FROM messages WHERE run_id = $1 AND kind = 'activity' ORDER BY id", [run])).rows;
      expect(rows.map((row) => [row.data.tool, row.data.via ?? null, row.status])).toEqual([[ABRIR_GRUPO, null, 'completed'], ['edit_memory', USE_TOOL, 'completed']]);
      expect((await world.pool.query<{ content: string }>('SELECT content FROM bot_memories WHERE bot_id = $1', [bot.id])).rows[0]!.content).toContain(note);
    } finally { await world.cleanup(); }
  }, 90_000);
});

describe('A32: ferramenta nova num galho existente é um único registro que o sistema, abrir_grupo e o portão enxergam (phase 15, passo 12)', () => {
  it('o nome entra no galho certo de TOOL_TREE: aparece no índice do sistema, é aberta com o galho e a chamada por use_tool pede aprovação pela ação dela', async () => {
    const extra = defineTool({
      definition: { name: 'memoria_extra', description: 'Apaga a memória por inteiro.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      argsSchema: z.strictObject({}), approvalRequired: true, action: { slug: 'TEST_MEMORIA_EXTRA', label: 'Apagar memória', appSlug: 'local', appName: 'Local' },
      label: () => 'Apagar memória', execute: async () => ({ result: 'apagada' }),
    });
    const branch = TOOL_TREE.find((group) => group.path === 'ferramentas/memoria')! as unknown as { tools: readonly string[] };
    const original = branch.tools;
    branch.tools = [...original, 'memoria_extra']; // o único registro: o nome no galho certo
    const world = await createRunsWorld({ tools: [...INTERNAL_TOOLS, extra] });
    try {
      await world.models.test('opencode/glm-5.1');
      world.engine.start();
      const bot = await world.createBot();
      const seen: ChatRequest[] = [];
      const plan: ChatEvent[][] = [[event(ABRIR_GRUPO, { path: 'ferramentas/memoria' })], [event(USE_TOOL, { name: 'memoria_extra', arguments: {} })]];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
        seen.push(structuredClone(request));
        yield* plan.shift() ?? [{ type: 'text', text: 'Concluído' }];
        yield { type: 'done', reason: 'stop' };
      });
      const run = await world.send(bot, 'Apague a memória');
      await world.waitForStatus(run, 'waiting_approval');
      // Árvore no prompt: a linha do galho cita as duas ferramentas, sem outra edição.
      expect(seen[0]!.turns[0]!.text).toMatch(/^- ferramentas\/memoria: .*\(edit_memory, memoria_extra\)$/mu);
      // abrir_grupo: abre as duas (nenhuma está na lista padrão com o catálogo core desligado) em resultados próprios.
      const schemas = seen[1]!.turns.filter((turn) => turn.role === 'tool').map((turn) => { try { return (JSON.parse(turn.text) as ChatTool).name; } catch { return null; } });
      expect(schemas).toEqual(expect.arrayContaining(['edit_memory', 'memoria_extra']));
      // Portão: a chamada pela porta pausa pedindo aprovação pela ação DELA, sem executar.
      const approval = (await world.approvalOf(run))!;
      const pending = (await world.pool.query<{ action_slug: string }>('SELECT action_slug FROM approvals WHERE id = $1', [approval.id])).rows[0]!;
      expect(pending.action_slug).toBe('TEST_MEMORIA_EXTRA');
      expect((await world.pool.query("SELECT 1 FROM messages WHERE run_id = $1 AND kind = 'activity' AND content = 'apagada'", [run])).rowCount).toBe(0);
    } finally { branch.tools = original; await world.cleanup(); }
  }, 90_000);
});
