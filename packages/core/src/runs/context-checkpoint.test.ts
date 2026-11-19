// Prova local com PostgreSQL e motor real; provider falso distingue chamadas principais das de resumo.
import { describe, expect, it, vi } from 'vitest';
import { ChatRejected, type ChatRequest, type ChatTurn } from '../models/chat-protocols';
import { commitContextSummary, contextFingerprint, finishModelUsage, loadManagedContext, requestBlockHashes, startModelUsage, validCheckpoint } from './context-checkpoint';
import { currentDataBlock } from './context';
import { mergeEvidence } from './evidence-provenance';
import { estimateChatPayload, contextEnvelope, MAX_OUTPUT_TOKENS, SUMMARY_MAX_OUTPUT_TOKENS } from './context-budget';
import { SUMMARY_SECTIONS } from './compaction';
import { defineTool, ToolFailure } from './tools';
import { z } from 'zod';
import { createRunsWorld } from './test-support';
import { randomUUID } from 'node:crypto';
import { tableCreateSchema, tableWriteSchema } from '@aion/shared';
import { TableService } from '../tables/service';
import { startFakeSandbox } from '../testing/fake-sandbox';
import { attachmentEvidence } from './evidence-provenance';
import { activityReadTool } from './activity-read';
import { AttachmentService } from '../attachments/service';
import { ORIGIN, waitFor } from './test-support';
import { tableTools } from './table-tools';
import type { ToolHandler } from './tools';
import { summaryOutcomeMigration } from '../db/migrations/0038_summary_outcome';
import * as objectives from '../bots/objectives';
import { tableMarker } from '../testing/fake-upstreams';
import { GeneralChatService } from '../general-chat/service';

/** Resumo bem formado (as sete seções); `label` identifica de qual chamada ele veio. As provas de formato e de recusa estão em `compaction.test.ts`. */
const checkpointText = (label: string): string => SUMMARY_SECTIONS.map((title, index) => `## ${title}\n${index === 0 ? label : 'Nada.'}`).join('\n\n');

/**
 * Tamanho do segundo pedido que deixa o pedido completo em ~92% do orçamento de entrada de 64k: acima do limiar de compactação (90%) e ainda
 * cabendo, de modo que a falha do resumo não precise do colapso. Parte da estimativa REAL do primeiro pedido (sistema, catálogo e
 * a primeira mensagem), então não depende do tamanho do turno de sistema.
 */
const preventiveSize = (first: ChatRequest): number => Math.max(500, Math.floor(0.92 * contextEnvelope(65536, MAX_OUTPUT_TOKENS).inputBudget - estimateChatPayload(first, 'chat_completions').estimatedInputTokens));

it('primeira abertura apresenta convite durante preparacao sem invalidar objetivo ou proposta de rotina',async()=>{
  const world=await createRunsWorld({ contextWindow: 65536 });
  const original=objectives.readBotObjective;
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');
    const spy=vi.spyOn(objectives,'readBotObjective').mockImplementationOnce(async(db,id)=>{
      const view=await original(db,id);
      expect(view.invitationPresented).toBe(false);
      await new objectives.ObjectiveService(world.pool).presentInvitation(id);
      return view;
    });
    world.engine.start();
    const run=await world.send(bot,tableMarker('propose_routine',{name:'Quinto dia util',instruction:'Consultar tabelas autorizadas.',schedule:{type:'monthly_business_day',position:5,time:'09:00'},timezone:'Asia/Tokyo',startsAt:null,endsAt:null,maxRuns:null}));
    await waitFor('desfecho proposta durante convite',async()=>['completed','failed'].includes((await world.runRow(run)).status));
    expect(await world.runRow(run)).toMatchObject({status:'completed',failure_code:null});
    expect(spy).toHaveBeenCalled();
    expect(await original(world.pool,bot.id)).toMatchObject({content:'',version:0,invitationPresented:true});
    expect((await world.timeline(bot)).filter(row=>row.kind==='card'&&row.data.type==='routine_proposal')).toHaveLength(1);
  }finally{vi.restoreAllMocks();await world.cleanup();}
});

it('0038 recusa apagar recibo definitivo e preserva rollback vazio',async()=>{
  const world=await createRunsWorld({ contextWindow: 65536 });
  try {
    await world.pool.query(summaryOutcomeMigration.rollback);await world.pool.query(summaryOutcomeMigration.up);
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');world.engine.start();
    const run=await world.send(bot,'Pedido inicial');await world.waitForStatus(run,'completed');
    const conversationId=await world.conversations.conversationIdOf(bot.id);
    const id=await startModelUsage(world.pool,conversationId,run,'summary',bot.model!,'chat_completions',new Date());
    await finishModelUsage(world.pool,id,{inputTokens:10,outputTokens:2048},true,new Date(),'output_limit');
    const before=(await world.pool.query('SELECT * FROM model_call_usage WHERE id=$1',[id])).rows;
    await expect(world.pool.query(summaryOutcomeMigration.rollback)).rejects.toThrow('Preserve desfechos');
    expect((await world.pool.query('SELECT * FROM model_call_usage WHERE id=$1',[id])).rows).toEqual(before);
  }finally{await world.cleanup();}
});

// Phase 12, T3 (A10): a gravação de cache informada pelo provedor (só o messages) vai para `model_call_usage.cache_write_tokens` pelo mesmo caminho do uso de sempre, sem mexer na entrada total
// (CTX-08: o `input_tokens` continua leitura mais gravação mais o resto); provedor sem a informação grava NULL, nunca 0.
it('a gravação de cache vai para cache_write_tokens com a entrada total íntegra, e NULL quando o provedor não a informa', async () => {
  const world = await createRunsWorld();
  const ledger = async (botId: string) => (await world.pool.query<{ purpose: string; input: number; cached: number; written: number | null }>(
    "SELECT u.purpose, u.input_tokens::int AS input, u.cached_tokens::int AS cached, u.cache_write_tokens::int AS written FROM model_call_usage u JOIN conversations c ON c.id = u.conversation_id WHERE c.bot_id = $1 ORDER BY u.created_at, u.id", [botId])).rows;
  try {
    world.engine.start();
    const kimi = await world.createBot({ model: 'opencode/kimi-k2.7-code' }), glm = await world.createBot({ model: 'opencode/glm-5.1' });
    // O falso informa 100 de entrada (80 lidos do cache) em toda chamada; com o marcador, o messages informa 15 gravados dentro dos 100.
    for (const [bot, text] of [[kimi, '[cache-gravacao:15] anote'], [kimi, 'sem marcador'], [glm, '[cache-gravacao:15] anote']] as const) await world.waitForStatus(await world.send(bot, text), 'completed');
    expect(await ledger(kimi.id)).toEqual([{ purpose: 'main', input: 100, cached: 80, written: 15 }, { purpose: 'main', input: 100, cached: 80, written: null }]);
    expect(await ledger(glm.id)).toEqual([{ purpose: 'main', input: 100, cached: 80, written: null }]);

    // A gravação do uso em si: o total, a leitura e a gravação saem separados, a linha concluída não é reescrita e a chamada sem a informação fica NULL.
    const conversationId = await world.conversations.conversationIdOf(kimi.id);
    const run = await world.send(kimi, 'outra');
    await world.waitForStatus(run, 'completed');
    const written = await startModelUsage(world.pool, conversationId, run, 'summary', 'opencode/claude-haiku-5-5', 'messages', new Date());
    await finishModelUsage(world.pool, written, { inputTokens: 1_000, cachedTokens: 800, cacheWriteTokens: 150, outputTokens: 5 }, true, new Date(), 'applied');
    await finishModelUsage(world.pool, written, { inputTokens: 9, cacheWriteTokens: 9 }, true, new Date());
    const silent = await startModelUsage(world.pool, conversationId, run, 'summary', 'opencode/claude-haiku-5-5', 'messages', new Date(), contextFingerprint('outro'));
    await finishModelUsage(world.pool, silent, { inputTokens: 1_000 }, true, new Date(), 'applied');
    const rows = (await world.pool.query('SELECT id, input_tokens::int AS input, cached_tokens::int AS cached, cache_write_tokens::int AS written FROM model_call_usage WHERE id = ANY($1::uuid[]) ORDER BY id', [[written, silent]])).rows;
    expect(rows.find((row) => row.id === written)).toMatchObject({ input: 1_000, cached: 800, written: 150 });
    expect(rows.find((row) => row.id === silent)).toMatchObject({ input: 1_000, cached: null, written: null });
  } finally { await world.cleanup(); }
});

it.each(['empty','output_limit'] as const)('hard overflow depois de resumo %s definitivo segue em índice: a execução conclui, sem checkpoint e sem novo pedido principal repetido',async(mode)=>{
  const world=await createRunsWorld({ contextWindow: 65536 });
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');let main=0,summary=0;const requests:ChatRequest[]=[];
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(_key,_protocol,request){
      if(request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS){summary++;yield{type:'usage',usage:{inputTokens:20,outputTokens:2048}};yield{type:'done',reason:mode==='empty'?'stop':'output_limit'};}
      else {main++;requests.push(structuredClone(request));yield{type:'text',text:'Resposta anterior'};yield{type:'done',reason:'stop'};}
    });
    world.engine.start();await world.waitForStatus(await world.send(bot,'a'.repeat(28000)),'completed');
    const run=await world.send(bot,'b'.repeat(20000));await world.waitForStatus(run,'completed');
    // C3 (spec): a falha do resumo automático não derruba a execução; o pedido estoura o orçamento, então o colapso em índice o segura.
    expect(await world.runRow(run)).toMatchObject({status:'completed',failure_code:null});expect(main).toBe(2);
    expect(summary).toBeGreaterThanOrEqual(1);expect(summary).toBeLessThanOrEqual(4);
    expect(requests[1]!.turns.some((turn)=>turn.role==='user'&&turn.text.startsWith('# Histórico anterior colapsado'))).toBe(true);
    expect(estimateChatPayload(requests[1]!,'chat_completions').estimatedInputTokens).toBeLessThanOrEqual(contextEnvelope(65536, MAX_OUTPUT_TOKENS).inputBudget);
    expect((await world.pool.query('SELECT revision,summary FROM conversation_context')).rows).toEqual([{revision:0,summary:''}]);
  }finally{await world.cleanup();}
});

it('restart preserva a recusa conhecida, contabiliza o custo completo e não repete o resumo',async()=>{
  const world=await createRunsWorld({ contextWindow: 65536 });let resumed:ReturnType<typeof world.createEngine>|undefined;
  let release=()=>undefined as void;const gate=new Promise<void>(resolve=>{release=resolve;});
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');let main=0,summary=0;let firstRequest:ChatRequest|undefined;
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(_key,_protocol,request){
      if(request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS){summary++;yield{type:'usage',usage:{inputTokens:2204,outputTokens:2048}};yield{type:'done',reason:'output_limit'};}
      else {firstRequest??=request;main++;if(main===2)await gate;yield{type:'text',text:'Resposta final'};yield{type:'usage',usage:{inputTokens:100,outputTokens:10}};yield{type:'done',reason:'stop'};}
    });
    world.engine.start();await world.waitForStatus(await world.send(bot,'a'.repeat(20000)),'completed');
    const conversationId=await world.conversations.conversationIdOf(bot.id);
    const before=(await world.pool.query('SELECT id,content,tool_arguments FROM messages WHERE conversation_id=$1 ORDER BY id',[conversationId])).rows;
    const run=await world.send(bot,'b'.repeat(preventiveSize(firstRequest!)));await waitFor('principal depois da rejeicao',async()=>main===2);
    // As tentativas de resumo (a escada de entradas menores) aconteceram ANTES da segunda chamada principal; a recusa já está gravada com a execução.
    const attempts=summary;expect(attempts).toBeGreaterThanOrEqual(1);
    expect((await world.pool.query('SELECT count(*) AS total FROM context_summary_refusals WHERE run_id=$1',[run])).rows[0]!.total).toBe('1');
    await world.engine.stop();resumed=world.createEngine();resumed.start();await world.waitForStatus(run,'completed');release();
    expect(summary).toBe(attempts);expect(main).toBe(3); // a retomada repete só a chamada principal, nunca o resumo
    expect((await world.conversations.contextState(bot.id)).usage.last?.summary).toMatchObject({calls:attempts,inputTokens:2204*attempts,outputTokens:2048*attempts,coverage:'complete'});
    expect((await world.pool.query("SELECT state,summary_outcome FROM model_call_usage WHERE run_id=$1 AND purpose='summary'",[run])).rows).toEqual(Array(attempts).fill({state:'completed',summary_outcome:'output_limit'}));
    expect((await world.pool.query('SELECT revision,summary FROM conversation_context')).rows).toEqual([{revision:0,summary:''}]);
    expect((await world.pool.query('SELECT id,content,tool_arguments FROM messages WHERE id=ANY($1::bigint[]) ORDER BY id',[before.map(r=>r.id)])).rows).toEqual(before);
  }finally{release();await resumed?.stop();await world.cleanup();}
});

it('retomada reconhece recibo já gravado mesmo com nova regra deny, sem repetir exclusão nem perder outras fontes', async () => {
  const deletion = tableTools.find((tool) => tool.definition.name === 'table_delete_table')!;
  let effects = 0, committed = false;
  // Simula queda exatamente depois do commit do efeito e antes do settle da atividade.
  const crashing: ToolHandler = { ...deletion, prepare(raw) {
    const prepared = deletion.prepare(raw);
    return { ...prepared, async execute(context) {
      effects++;
      const outcome = await prepared.execute(context);
      committed = true;
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
      });
      return outcome;
    } };
  } };
  const world = await createRunsWorld({ contextWindow: 65536, tools: [tableTools.find((tool) => tool.definition.name === 'table_get')!, crashing] });
  let resumed: ReturnType<typeof world.createEngine> | undefined;
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
    const service = new TableService({ pool: world.pool }), actor = { kind: 'bot' as const, botId: bot.id };
    const target = await service.create(tableCreateSchema.parse({ operationId: randomUUID(), name: 'Alvo removido' }), actor);
    const retained = await service.create(tableCreateSchema.parse({ operationId: randomUUID(), name: 'Fonte preservada' }), actor);
    const preparation = await service.prepareDestructive(target.id, { kind: 'delete_table', expectedVersion: target.version }, actor);
    const action = deletion.action!;
    await world.approvals.resolve(world.pool, bot.id, action);
    await world.approvals.setBotRule(bot.id, action.slug, 'allow', ORIGIN);
    let calls = 0;
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* () {
      if (calls++ === 0) yield { type: 'tool_call', id: 'other-source', name: 'table_get', arguments: JSON.stringify({ tableId: retained.id }) };
      else if (calls === 2) yield { type: 'tool_call', id: 'delete', name: 'table_delete_table', arguments: JSON.stringify({ tableId: target.id, preparationId: preparation.preparationId, operationId: randomUUID(), confirmation: true }) };
      else yield { type: 'text', text: 'Efeito confirmado anteriormente.' };
      yield { type: 'done', reason: 'stop' };
    });
    world.engine.start();
    const run = await world.send(bot, 'Leia a outra fonte e remova o alvo autorizado.');
    await waitFor('commit antes de settle', async () => committed);
    await world.engine.stop();
    const receipts = (await world.pool.query('SELECT * FROM table_mutation_receipts ORDER BY operation_id')).rows;
    await world.approvals.setBotRule(bot.id, action.slug, 'deny', ORIGIN);
    resumed = world.createEngine(); resumed.start();
    await world.waitForStatus(run, 'completed');
    expect(effects).toBe(1);
    expect((await world.pool.query('SELECT * FROM table_mutation_receipts ORDER BY operation_id')).rows).toEqual(receipts);
    expect((await world.pool.query('SELECT id FROM data_tables WHERE id=$1', [target.id])).rowCount).toBe(0);
    const activity = (await world.pool.query<{ status: string; content: string; evidence_provenance: { tables: { tableId: string }[] } }>("SELECT status,content,evidence_provenance FROM messages WHERE run_id=$1 AND kind='activity' AND data->>'tool'='table_delete_table'", [run])).rows[0]!;
    expect(activity.status).toBe('completed');
    expect(JSON.parse(activity.content)).toEqual({ removed: true, tableId: target.id, kind: 'delete_table' });
    expect(activity.evidence_provenance.tables.map((table) => table.tableId)).toEqual([retained.id]);
    expect((await world.pool.query('SELECT id FROM approvals WHERE run_id=$1', [run])).rowCount).toBe(0);
  } finally { await resumed?.stop(); await world.cleanup(); }
});

it('cobertura começa nas cinco rodadas legadas, avança sem expiração, CAS não altera originais e usage desconhecido não duplica', async () => {
  const world = await createRunsWorld({ contextWindow: 65536 });
  try {
    const bot = await world.createBot();
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    for (let index = 0; index < 8; index++) await world.pool.query("INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,$2,now())", [conversationId, `Origem ${index}`]);
    const first = await loadManagedContext(world.pool, conversationId);
    expect(first.rows.map((row) => row.content)).toEqual(['Origem 3', 'Origem 4', 'Origem 5', 'Origem 6', 'Origem 7']);
    expect(first.wholeConversation).toBe(false);
    const covered = first.rows.slice(0, 2), original = await world.pool.query('SELECT * FROM messages ORDER BY id');
    expect(await commitContextSummary(world.pool, conversationId, 0, 'Resumo derivado', covered, mergeEvidence(), new Date())).toBe(true);
    expect(await commitContextSummary(world.pool, conversationId, 0, 'Sobrescrita atrasada', covered, mergeEvidence(), new Date())).toBe(false);
    expect((await world.pool.query('SELECT * FROM messages ORDER BY id')).rows).toEqual(original.rows);
    await world.pool.query("INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,'Novo',now())", [conversationId]);
    const next = await loadManagedContext(world.pool, conversationId);
    expect(next.rows).toHaveLength(6);
    // CTX-09: o checkpoint vale pelo conteúdo que cobre; nada de configuração entra na validade (editar memória, objetivo, janela ou modelo não o invalida).
    expect(await validCheckpoint(world.pool, conversationId, bot.id, next.checkpoint, next.rows)).toBe(true);
    const changed = next.rows.map((row) => (row.id === covered[0]!.id ? { ...row, content: `${row.content} editado` } : row));
    expect(await validCheckpoint(world.pool, conversationId, bot.id, next.checkpoint, changed)).toBe(false); // linha coberta alterada
    expect(await validCheckpoint(world.pool, conversationId, bot.id, next.checkpoint, next.rows.filter((row) => row.id !== covered[0]!.id))).toBe(false); // linha coberta fora do caminho
    const run = await world.send(bot, 'Pedido');
    const usageId = await startModelUsage(world.pool, conversationId, run, 'summary', 'opencode/deepseek-v4.1-flash', 'chat_completions', new Date(), contextFingerprint('source'));
    await finishModelUsage(world.pool, usageId, { inputTokens: 10 }, false, new Date());
    await finishModelUsage(world.pool, usageId, { inputTokens: 999, outputTokens: 999 }, true, new Date());
    expect((await world.pool.query('SELECT state,input_tokens,output_tokens FROM model_call_usage WHERE id=$1', [usageId])).rows).toEqual([{ state: 'unknown', input_tokens: '10', output_tokens: null }]);
    await expect(startModelUsage(world.pool, conversationId, run, 'summary', 'opencode/deepseek-v4.1-flash', 'chat_completions', new Date(), contextFingerprint('source'))).rejects.toMatchObject({ code: 'CONTEXT_COMPACTION_FAILED' });
  } finally { await world.cleanup(); }
});

// A recarga depois da recusa do provedor descarrega as opcionais selecionadas só daquele pedido. Opcional publicada existe no Chat geral (`discover_tools`); a lista do bot é fixa (portas e mais usadas), então não há o que descarregar nele (o teste seguinte).
it.each(['once', 'twice', 'other400', 'partial'] as const)('recusa de tamanho %s repete no máximo uma preparação e nunca stream parcial', async (mode) => {
  const probe = defineTool({ definition: { name: 'probe_search', description: 'Ferramenta opcional de teste.', parameters: { type: 'object', properties: {}, additionalProperties: false } }, argsSchema: z.strictObject({}), label: () => 'Sonda', execute: async () => ({ result: 'ok' }) });
  const world = await createRunsWorld({ contextWindow: 65536, tools: [probe] });
  try {
    const session = { sessionId: (await new GeneralChatService({ pool: world.pool }).create()).id };
    await world.models.test('opencode/glm-5.1'); await world.conversations.setPreference(session, 'opencode/glm-5.1', null);
    let calls = 0;
    const requests: ChatRequest[] = [];
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
      requests.push(structuredClone(request));
      if (calls++ === 0) { yield { type: 'tool_call', id: 'select', name: 'discover_tools', arguments: '{"names":["probe_search"]}' }; yield { type: 'done', reason: 'stop' }; return; }
      if (calls === 2 || mode === 'twice') {
        if (mode === 'partial') yield { type: 'text', text: 'Texto parcial' };
        throw new ChatRejected(400, false, mode !== 'other400');
      }
      yield { type: 'text', text: 'Resposta concluída' }; yield { type: 'done', reason: 'stop' };
    });
    world.engine.start();
    const run = (await world.conversations.send(session, 'Trabalho com catálogo selecionado.')).id;
    await world.waitForStatus(run, mode === 'once' ? 'completed' : 'failed');
    expect(calls).toBe(mode === 'once' || mode === 'twice' ? 3 : 2);
    expect(requests.every((request) => request.model === 'opencode/glm-5.1')).toBe(true);
    if (mode === 'once' || mode === 'twice') {
      expect(requests[1]!.tools!.some((tool) => tool.name === 'probe_search')).toBe(true);
      expect(requests[2]!.tools!.some((tool) => tool.name === 'probe_search')).toBe(false);
      expect(requests[2]!.turns.some((turn) => turn.text.includes('Schemas descarregados por espaço: probe_search'))).toBe(true);
    }
    const selections = (await world.pool.query("SELECT 1 FROM messages WHERE run_id = $1 AND kind = 'activity'", [run])).rows;
    expect(selections).toHaveLength(1);
    if (mode !== 'once') expect((await world.runRow(run)).failure_code).toBe(mode === 'twice' ? 'CONTEXT_TOO_LARGE' : 'PROVIDER_ERROR');
  } finally { await world.cleanup(); }
});

// BOT (phase 15, passo 11): a lista é fixa, então a recarga depois da recusa do provedor repete a chamada com a MESMA lista (nada a descarregar) e sem o aviso de omitidas; abrir um grupo antes não a muda.
it('bot: a recusa de tamanho do provedor repete a chamada com a mesma lista fixa, sem aviso de ferramentas descarregadas', async () => {
  const world = await createRunsWorld({ contextWindow: 65536 });
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
    let calls = 0;
    const requests: ChatRequest[] = [];
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
      requests.push(structuredClone(request));
      if (calls++ === 0) { yield { type: 'tool_call', id: 'open', name: 'abrir_grupo', arguments: '{"path":"ferramentas/memoria"}' }; yield { type: 'done', reason: 'stop' }; return; }
      if (calls === 2) throw new ChatRejected(400, false, true);
      yield { type: 'text', text: 'Resposta concluída' }; yield { type: 'done', reason: 'stop' };
    });
    world.engine.start();
    await world.waitForStatus(await world.send(bot, 'Trabalho com um grupo aberto.'), 'completed');
    expect(requests).toHaveLength(3);
    const names = (request: ChatRequest): string[] => (request.tools ?? []).map((tool) => tool.name);
    expect(names(requests[0]!)).toEqual(['abrir_grupo', 'use_tool', 'read_activity']);
    for (const request of requests.slice(1)) expect(JSON.stringify(request.tools)).toBe(JSON.stringify(requests[0]!.tools));
    for (const request of requests) expect(request.turns.some((turn) => turn.text.includes('Schemas descarregados por espaço'))).toBe(false);
    // O esquema aberto fica no histórico das duas tentativas seguintes (a recarga não o descarrega).
    for (const request of requests.slice(1)) expect(request.turns.some((turn) => turn.role === 'tool' && turn.text.includes('"name":"edit_memory"'))).toBe(true);
  } finally { await world.cleanup(); }
});

it.each(['stop', 'restart'] as const)('resumo pendente %s interrompe mesmo provider que ignora abort e não paga repetição desconhecida', async (mode) => {
  const world = await createRunsWorld({ contextWindow: 65536 });
  let resumed: ReturnType<typeof world.createEngine> | undefined;
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
    let summaries = 0;
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
      if (request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS) { summaries++; await gate; yield { type: 'text', text: checkpointText('Resultado tardio') }; }
      else yield { type: 'text', text: 'Resposta inicial' };
      yield { type: 'done', reason: 'stop' };
    });
    world.engine.start();
    await world.waitForStatus(await world.send(bot, 'Pedido anterior ' + 'a'.repeat(22000)), 'completed');
    const run = await world.send(bot, 'Pedido atual ' + 'b'.repeat(20000));
    await waitFor('resumo pendente', async () => summaries === 1);
    if (mode === 'stop') { await world.conversations.stop(bot.id, run); await world.waitForStatus(run, 'interrupted'); }
    else {
      // C3: a chamada paga ficou incerta (nem aplicada nem recusada); a retomada NÃO a repete e segue sem checkpoint (o colapso segura o pedido), sem falhar a execução.
      await world.engine.stop();
      resumed = world.createEngine(); resumed.start(); await world.waitForStatus(run, 'completed');
      expect(await world.runRow(run)).toMatchObject({ status: 'completed', failure_code: null });
    }
    release();
    expect(summaries).toBe(1);
    expect((await world.pool.query('SELECT revision,summary FROM conversation_context')).rows).toEqual([{ revision: 0, summary: '' }]);
    expect((await world.pool.query("SELECT state FROM model_call_usage WHERE purpose='summary'")).rows).toEqual([{ state: 'unknown' }]);
  } finally { release(); await resumed?.stop(); await world.cleanup(); }
});

it.each(['empty', 'output_limit', 'tool_call'] as const)('resumo %s falha sem derrubar a execução: sem checkpoint, com todo o custo contabilizado', async (mode) => {
  const world = await createRunsWorld({ contextWindow: 65536 });
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
    let summaries = 0, firstRequest: ChatRequest | undefined;
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
      if (request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS) {
        summaries++;
        if (mode === 'tool_call') yield { type: 'tool_call', id: 'invalid-summary', name: 'table_write', arguments: '{}' };
        if (mode === 'output_limit') yield { type: 'text', text: 'Resumo cortado' };
        yield { type: 'usage', usage: { inputTokens: 2204, outputTokens: 2048 } };
        yield { type: 'done', reason: mode === 'output_limit' ? 'output_limit' : 'stop' };
      } else { firstRequest ??= request; yield { type: 'text', text: 'Resposta válida' }; yield { type: 'done', reason: 'stop' }; }
    });
    world.engine.start();
    await world.waitForStatus(await world.send(bot, 'Primeiro pedido ' + 'x'.repeat(20000)), 'completed');
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    const before = (await world.pool.query('SELECT revision,summary FROM conversation_context WHERE conversation_id=$1', [conversationId])).rows;
    const failed = await world.send(bot, 'Segundo pedido ' + 'y'.repeat(preventiveSize(firstRequest!)));
    await world.waitForStatus(failed, 'completed');
    // S1/C3: nenhum motivo de falha do resumo (vazio, limite de saída, chamada de ferramenta fora de hora) falha a execução.
    expect(await world.runRow(failed)).toMatchObject({ status: 'completed', failure_code: null });
    const ledger = (await world.pool.query("SELECT state,summary_outcome,input_tokens,output_tokens FROM model_call_usage WHERE run_id=$1 AND purpose='summary' ORDER BY created_at", [failed])).rows;
    expect(ledger).toHaveLength(summaries);
    expect(summaries).toBeGreaterThanOrEqual(1);
    // Formato inválido (chamada de ferramenta) tem uma segunda tentativa com lembrete; vazio e limite de saída seguem direto para a entrada menor.
    expect(summaries).toBeLessThanOrEqual(5);
    expect(ledger.every((row) => row.state === 'completed' && row.summary_outcome === (mode === 'tool_call' ? null : mode) && row.input_tokens === '2204' && row.output_tokens === '2048')).toBe(true);
    expect((await world.pool.query('SELECT revision,summary FROM conversation_context WHERE conversation_id=$1', [conversationId])).rows).toEqual(before);
    const answers = (await world.timeline(bot)).filter((row) => row.runId === failed && row.role === 'assistant' && row.kind === 'text');
    expect(answers).toHaveLength(1);
    expect(answers[0]!.content).toBe('Resposta v\u00e1lida');
    expect((await world.conversations.contextState(bot.id)).usage.last?.summary).toMatchObject({ calls: summaries, inputTokens: 2204 * summaries, outputTokens: 2048 * summaries, coverage: 'complete' });
  } finally { await world.cleanup(); }
});

it('reserva principal protege anexo histórico fora do trigger sem atividade de leitura nesta execução', async () => {
  const world = await createRunsWorld({ contextWindow: 65536 });
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
    const files = new AttachmentService({ pool: world.pool, conversations: world.conversations });
    const file = await files.upload(bot.id, 'historico.txt', Buffer.from('SEGREDO-HISTORICO-SINTETICO'));
    world.engine.start();
    const original = await world.conversations.send(bot.id, 'Leia o anexo.', [file.id]); await world.waitForStatus(original.id, 'completed');
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* () {
      entered = true; await gate;
      yield { type: 'text', text: 'Concluído' }; yield { type: 'done', reason: 'stop' };
    });
    const current = await world.send(bot, 'Prossiga sem anexar arquivos.');
    await waitFor('chamada principal reservada', async () => entered);
    const run = (await world.pool.query<{ trigger_message_id: string }>('SELECT trigger_message_id::text FROM runs WHERE id=$1', [current])).rows[0]!;
    expect(run.trigger_message_id).not.toBe((await world.pool.query<{ message_id: string }>('SELECT message_id::text FROM attachments WHERE id=$1', [file.id])).rows[0]!.message_id);
    expect((await world.pool.query('SELECT 1 FROM message_attachment_links WHERE message_id=$1', [run.trigger_message_id])).rowCount).toBe(0);
    expect((await world.pool.query('SELECT 1 FROM messages WHERE run_id=$1 AND kind=\'activity\'', [current])).rowCount).toBe(0);
    const reserve = (await world.pool.query<{ evidence_provenance: { attachments: string[] } }>("SELECT evidence_provenance FROM model_call_usage WHERE run_id=$1 AND state='started'", [current])).rows[0]!;
    expect(reserve.evidence_provenance.attachments).toContain(file.id);
    expect(await files.removeBatch([file.id], ORIGIN)).toMatchObject({ deleted: [], inUse: [file.id] });
    release(); await world.waitForStatus(current, 'completed');
    await files.removeBatch([file.id], ORIGIN);
    expect((await world.pool.query('SELECT stored_bytes FROM attachments WHERE id=$1 AND conversation_id=$2', [file.id, conversationId])).rows[0]!.stored_bytes).toBe(0);
  } finally { await world.cleanup(); }
});

it('exclusão após preparar e antes reservar impede gateway; reserva de resumo também protege fonte histórica', async () => {
  const world = await createRunsWorld({ contextWindow: 65536 });
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
    const files = new AttachmentService({ pool: world.pool, conversations: world.conversations });
    const file = await files.upload(bot.id, 'fonte.txt', Buffer.from('SEGREDO-FONTE-SINTETICO'));
    world.engine.start();
    const original = await world.conversations.send(bot.id, 'Leia.', [file.id]); await world.waitForStatus(original.id, 'completed');
    const originalQuery = world.pool.query.bind(world.pool);
    let deleted = false;
    // Interleaving no último SELECT antes da transação de reserva, sem modificar o lifecycle real.
    const intercepted = async (sql: string, values?: unknown[]) => {
      if (!deleted && typeof sql === 'string' && sql.includes('SELECT coalesce(max(step)')) {
        deleted = true;
        expect(await files.removeBatch([file.id], ORIGIN)).toMatchObject({ deleted: [file.id], inUse: [] });
      }
      return originalQuery(sql, values);
    };
    world.pool.query = intercepted as typeof world.pool.query;
    const before = world.conversationRequests().length;
    const failed = await world.send(bot, 'Continue com a fonte antiga.'); await world.waitForStatus(failed, 'failed');
    world.pool.query = originalQuery;
    expect(deleted).toBe(true);
    expect((await world.runRow(failed)).failure_code).toBe('CONTEXT_EVIDENCE_UNAVAILABLE');
    expect(world.conversationRequests()).toHaveLength(before);

    const second = await world.createBot();
    const source = await files.upload(second.id, 'historico-resumo.txt', Buffer.from('SEGREDO-RESUMO-SINTETICO'));
    const first = await world.conversations.send(second.id, 'Leia.', [source.id]); await world.waitForStatus(first.id, 'completed');
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
      if (request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS) { entered = true; await gate; yield { type: 'text', text: checkpointText('Resumo permitido.') }; }
      else yield { type: 'text', text: 'Resposta permitida.' };
      yield { type: 'done', reason: 'stop' };
    });
    await world.waitForStatus(await world.send(second, 'Pedido A ' + 'a'.repeat(22000)), 'completed');
    const pending = await world.send(second, 'Pedido B ' + 'b'.repeat(20000));
    await waitFor('resumo reservado', async () => entered);
    const ledger = (await world.pool.query<{ evidence_provenance: { attachments: string[] } }>("SELECT evidence_provenance FROM model_call_usage WHERE run_id=$1 AND purpose='summary' AND state='started'", [pending])).rows[0]!;
    expect(ledger.evidence_provenance.attachments).toContain(source.id);
    expect(await files.removeBatch([source.id], ORIGIN)).toMatchObject({ deleted: [], inUse: [source.id] });
    release(); await world.waitForStatus(pending, 'completed');
  } finally { await world.cleanup(); }
});

it('revogação posterior à reserva permite cancelar acesso, mas impede persistir resposta derivada', async () => {
  const world = await createRunsWorld({ contextWindow: 65536 });
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
    const tables = new TableService({ pool: world.pool }), owner = { kind: 'owner' } as const;
    const table = await tables.create(tableCreateSchema.parse({ operationId: randomUUID(), name: 'ACL', columns: [{ name: 'Fato', type: 'text' }] }), owner, bot.id);
    let step = 0;
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* () {
      if (step++ === 0) yield { type: 'tool_call', id: 'query', name: 'table_query', arguments: JSON.stringify({ tableId: table.id, query: {} }) };
      else {
        const current = await tables.get(table.id, owner);
        await tables.share(table.id, { operationId: randomUUID(), expectedVersion: current.version, botIds: [] }, owner);
        yield { type: 'text', text: 'Resposta baseada na tabela revogada' };
      }
      yield { type: 'done', reason: 'stop' };
    });
    world.engine.start();
    const run = await world.send(bot, 'Consulte e responda.'); await world.waitForStatus(run, 'failed');
    expect((await world.runRow(run)).failure_code).toBe('CONTEXT_EVIDENCE_UNAVAILABLE');
    expect((await world.timeline(bot)).filter((row) => row.runId === run && row.role === 'assistant' && row.kind === 'text')).toHaveLength(0);
    expect((await world.pool.query("SELECT state FROM model_call_usage WHERE run_id=$1 AND purpose='main'", [run])).rows).toHaveLength(2);
  } finally { await world.cleanup(); }
});

it('tabela→Python sem anexos→resumos sucessivos conserva closure; revoke redige contexto e recall sem apagar originais', async () => {
  const sandbox = await startFakeSandbox();
  sandbox.handler = () => ({ output: 'derivado', files: [{ name: 'resultado.txt', data: Buffer.from('FATO-PRIVADO-SINTETICO') }] });
  const world = await createRunsWorld({ contextWindow: 65536, python: { url: sandbox.url, token: sandbox.token } });
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
    const conversationId = await world.conversations.conversationIdOf(bot.id), owner = { kind: 'owner' } as const;
    const tables = new TableService({ pool: world.pool });
    const table = await tables.create(tableCreateSchema.parse({ operationId: randomUUID(), name: 'Fonte sintética', columns: [{ name: 'Fato', type: 'text' }] }), owner, bot.id);
    await tables.write(table.id, tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: { [table.columns[0]!.id]: 'FATO-PRIVADO-SINTETICO' } }] }), owner);
    let step = 0;
    const requests: ChatRequest[] = [];
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request) {
      requests.push(structuredClone(request));
      if (request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS) yield { type: 'text', text: checkpointText(JSON.stringify(request).includes('FATO-PRIVADO-SINTETICO') ? 'Resumo com FATO-PRIVADO-SINTETICO e evidências.' : 'Resumo de mensagens permitidas.') };
      else if (step++ === 0) yield { type: 'tool_call', id: 'query', name: 'table_query', arguments: JSON.stringify({ tableId: table.id, query: { columns: [table.columns[0]!.id] } }) };
      else if (step === 2) yield { type: 'tool_call', id: 'python', name: 'run_python', arguments: JSON.stringify({ code: "open('/out/resultado.txt','w').write('FATO-PRIVADO-SINTETICO')", attachments: [] }) };
      else yield { type: 'text', text: JSON.stringify(request).includes('FATO-PRIVADO-SINTETICO') ? 'Resposta com FATO-PRIVADO-SINTETICO.' : 'Resposta somente com fontes permitidas.' };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }; yield { type: 'done', reason: 'stop' };
    });
    world.engine.start();
    const first = await world.send(bot, 'Consulte a tabela e derive arquivo.'); await world.waitForStatus(first, 'completed');
    const generated = (await world.pool.query<{ id: string; source_provenance: { tables: { tableId: string }[] }; file_bytes: Buffer }>("SELECT id::text,source_provenance,file_bytes FROM attachments WHERE run_id=$1 AND kind='generated'", [first])).rows[0]!;
    expect(generated.source_provenance.tables.map((source) => source.tableId)).toContain(table.id);
    expect((await attachmentEvidence(world.pool, conversationId, bot.id, [generated.id]))?.tables).toHaveLength(1);
    for (let index = 0; index < 10; index++) await world.waitForStatus(await world.send(bot, `Pedido ${index}: ` + 'continuidade do dono '.repeat(600)), 'completed');
    const state = (await world.pool.query<{ revision: number; evidence_provenance: { tables: { tableId: string }[] } }>('SELECT revision,evidence_provenance FROM conversation_context WHERE conversation_id=$1', [conversationId])).rows[0]!;
    expect(state.revision).toBeGreaterThan(1);
    expect(state.evidence_provenance.tables.map((source) => source.tableId)).toContain(table.id);
    const originals = (await world.pool.query('SELECT id,content,tool_arguments,evidence_provenance FROM messages WHERE conversation_id=$1 ORDER BY id', [conversationId])).rows;
    const current = await tables.get(table.id, owner);
    await tables.share(table.id, { operationId: randomUUID(), expectedVersion: current.version, botIds: [] }, owner);
    const since = requests.length;
    await world.waitForStatus(await world.send(bot, 'Agora prossiga apenas com fontes disponíveis.'), 'completed');
    expect(JSON.stringify(requests.slice(since))).not.toContain('FATO-PRIVADO-SINTETICO');
    // Resposta de texto saneada sai do pedido: o marcador nunca vira fala do bot (o modelo o imitava como resposta ao dono).
    const after = requests.slice(since).filter((request) => request.maxTokens !== SUMMARY_MAX_OUTPUT_TOKENS).flatMap((request) => request.turns);
    expect(after.filter((turn) => turn.role === 'assistant' && turn.text.includes('Evidência automática indisponível'))).toEqual([]);
    expect(await attachmentEvidence(world.pool, conversationId, bot.id, [generated.id])).toBeNull();
    const sourceActivity = (await world.pool.query<{ id: string }>("SELECT id::text FROM messages WHERE run_id=$1 AND data->>'tool'='run_python'", [first])).rows[0]!.id;
    // A15: a fonte revogada torna o recall uma FALHA da atividade (o modelo recebe um erro), e o dado privado não volta nem na mensagem.
    const recall = await activityReadTool.prepare(JSON.stringify({ messageId: sourceActivity })).execute({ pool: world.pool, conversationId, botId: bot.id, runId: first, signal: new AbortController().signal, now: () => new Date() }).catch((error: unknown) => error);
    expect(recall).toBeInstanceOf(ToolFailure);
    expect((recall as ToolFailure).message).toContain('indisponível'); expect((recall as ToolFailure).message).not.toContain('FATO-PRIVADO-SINTETICO');
    expect((await world.pool.query('SELECT id,content,tool_arguments,evidence_provenance FROM messages WHERE conversation_id=$1 AND id=ANY($2::bigint[]) ORDER BY id', [conversationId, originals.map((row) => row.id)])).rows).toEqual(originals);
    expect((await world.pool.query('SELECT file_bytes FROM attachments WHERE id=$1', [generated.id])).rows[0]!.file_bytes).toEqual(generated.file_bytes);
  } finally { await world.cleanup(); await sandbox.stop(); }
});

it('motor limita o corpo ao orçamento de 64k, resume sem tools, conserva mensagens e contabiliza cada chamada uma vez', async () => {
  const world = await createRunsWorld({ contextWindow: 65536 });
  try {
    const bot = await world.createBot();
    await world.models.test('opencode/glm-5.1');
    const requests: ChatRequest[] = [];
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, protocol, request) {
      requests.push(structuredClone(request));
      expect(estimateChatPayload(request, protocol).estimatedInputTokens).toBeLessThanOrEqual(contextEnvelope(65536, request.maxTokens).inputBudget);
      if (request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS) {
        expect(request.tools).toBeUndefined();
        yield { type: 'text', text: checkpointText('Resumo sintético de decisões; IDs dos originais permanecem recuperáveis.') };
      } else yield { type: 'text', text: 'Resposta sintética '.repeat(30) };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 10 } };
      yield { type: 'done', reason: 'stop' };
    });
    world.engine.start();
    const expected: string[] = [];
    for (let index = 0; index < 7; index++) {
      const text = `Restrição ${index}: ` + 'dado explícito do dono '.repeat(640);
      expected.push(text);
      await world.waitForStatus(await world.send(bot, text), 'completed');
    }
    const timeline = await world.timeline(bot);
    expect(timeline.filter((row) => row.role === 'user').map((row) => row.content)).toEqual(expected);
    expect(timeline.filter((row) => row.role === 'assistant' && row.kind === 'text')).toHaveLength(7);
    expect(timeline.filter((row) => row.kind === 'card')).toHaveLength(0);
    const summaryCalls = requests.filter((request) => request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS);
    expect(summaryCalls.length).toBeGreaterThan(0);
    expect(summaryCalls.length).toBeLessThanOrEqual(14);
    expect(requests.some((request) => request.turns.some((turn) => turn.text.startsWith('# Resumo derivado')))).toBe(true);
    const usage = (await world.pool.query('SELECT purpose,state,input_tokens,output_tokens,cached_tokens,preparation_id FROM model_call_usage ORDER BY created_at,id')).rows;
    expect(usage).toHaveLength(requests.length);
    expect(usage.filter((row) => row.purpose === 'main')).toHaveLength(7);
    expect(usage.every((row) => row.state === 'completed' && row.input_tokens === '100' && row.output_tokens === '20' && row.cached_tokens === '10')).toBe(true);
    const preparations=[...new Set(usage.map((row)=>row.preparation_id))];
    expect(preparations).toHaveLength(7);expect(preparations).not.toContain(null);
    for(const preparation of preparations){const calls=usage.filter((row)=>row.preparation_id===preparation);expect(calls.filter((row)=>row.purpose==='main')).toHaveLength(1);expect(calls.filter((row)=>row.purpose==='summary').length).toBeLessThanOrEqual(2);}
  } finally { await world.cleanup(); }
});

it('ledger identifica o resumo e o main da mesma preparação e separa a preparação seguinte',async()=>{
  const world=await createRunsWorld({ contextWindow: 65536 });
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');
    const conversationId=await world.conversations.conversationIdOf(bot.id);
    await loadManagedContext(world.pool,conversationId); // cobertura de conversa nova: começa do zero
    for(let index=0;index<6;index++)await world.pool.query("INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,$2,now())",[conversationId,`Histórico ${index}: `+'a'.repeat(8000)]); // ~48 mil bytes: com o piso do pedido passa do limiar do orçamento de 64k
    let summaries=0;const seen:ChatRequest[]=[];
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(_key,protocol,request){
      seen.push(structuredClone(request));
      expect(estimateChatPayload(request,protocol).estimatedInputTokens).toBeLessThanOrEqual(contextEnvelope(65536, request.maxTokens).inputBudget);
      if(request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS){summaries++;yield{type:'text',text:checkpointText('Decisões antigas preservadas no resumo.')};}else yield{type:'text',text:'Resposta atual.'};
      yield{type:'usage',usage:{inputTokens:100,outputTokens:20}};yield{type:'done',reason:'stop'};
    });
    world.engine.start();const first=await world.send(bot,'Pedido atual '+ 'b'.repeat(1000));await world.waitForStatus(first,'completed');
    const rows=(await world.pool.query<{preparation_id:string;purpose:string}>('SELECT preparation_id,purpose FROM model_call_usage WHERE run_id=$1',[first])).rows;
    // Uma compactação por preparação (o histórico antigo inteiro cabe num lote, achatado se preciso): um resumo e uma chamada principal, com a mesma identidade.
    expect(summaries).toBe(1);expect(rows.filter((row)=>row.purpose==='summary')).toHaveLength(1);expect(rows.filter((row)=>row.purpose==='main')).toHaveLength(1);
    const identity=rows[0]!.preparation_id;expect(identity).not.toBeNull();expect(rows.every((row)=>row.preparation_id===identity)).toBe(true);
    // Phase 15, passo 2 (A5): o resumo grava os hashes do pedido dele (prompt de sistema e texto do histórico a resumir; sem objetivo, ferramentas nem rodadas) e o effort mais baixo do modelo;
    // a chamada principal da mesma preparação grava os do pedido principal, com a lista de ferramentas.
    const summaryRequest=seen.find((request)=>request.maxTokens===SUMMARY_MAX_OUTPUT_TOKENS)!;const mainRequest=seen.find((request)=>request.maxTokens!==SUMMARY_MAX_OUTPUT_TOKENS)!;
    const blocks=async(purpose:string)=>(await world.pool.query('SELECT system_hash,objective_hash,tools_hash,history_hash,history_turns,history_round_hashes,history_prior_hash,effort FROM model_call_usage WHERE run_id=$1 AND purpose=$2',[first,purpose])).rows[0];
    expect(await blocks('summary')).toEqual({system_hash:contextFingerprint(summaryRequest.turns[0]!.text),objective_hash:null,tools_hash:null,history_hash:contextFingerprint([summaryRequest.turns[1]]),history_turns:1,history_round_hashes:[],history_prior_hash:null,effort:summaryRequest.effort??null});
    expect(await blocks('main')).toMatchObject({system_hash:contextFingerprint(mainRequest.turns[0]!.text),tools_hash:contextFingerprint(mainRequest.tools),effort:mainRequest.effort??null});
    const next=await world.send(bot,'Prossiga.');await world.waitForStatus(next,'completed');
    expect((await world.pool.query<{preparation_id:string}>('SELECT preparation_id FROM model_call_usage WHERE run_id=$1',[next])).rows.every((row)=>row.preparation_id!==identity&&row.preparation_id!==null)).toBe(true);
  }finally{await world.cleanup();}
});

it('resultado Unicode volumoso chega com o marcador do id e a recuperação por read_activity avança até o texto integral sob 64k, sem repetir a consulta', async () => {
  // Ferramenta genérica (sem limite próprio): o texto de 18.000 caracteres UTF-16 passa do teto de 12.000 do pedido, com emoji que o corte e a paginação nunca podem partir.
  const blob = 'abcdefg😀'.repeat(2000);
  const unicodeBlob = defineTool({
    definition: { name: 'unicode_blob', description: 'Devolve um texto longo de teste.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    argsSchema: z.strictObject({}), label: () => 'Texto longo', execute: async () => ({ result: blob }),
  });
  const world = await createRunsWorld({ contextWindow: 65536, tools: [unicodeBlob] });
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
    let step = 0, recovered = '', previousOffset = -1;
    let providerError: unknown = null;
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, protocol, request) {
      // A rodada com paginação passa do limiar: a compactação (resumo sem ferramentas) acontece no meio e não conta como etapa do roteiro.
      if (request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS) { yield { type: 'text', text: checkpointText('Resumo da paginação.') }; yield { type: 'done', reason: 'stop' }; return; }
      try {
      expect(estimateChatPayload(request, protocol).estimatedInputTokens).toBeLessThanOrEqual(contextEnvelope(65536, MAX_OUTPUT_TOKENS).inputBudget);
      // A ferramenta de teste não está na árvore de grupos: o bot a chama direto pelo nome, que o executor resolve pelo registry da execução.
      if (step++ === 0) yield { type: 'tool_call', id: 'query', name: 'unicode_blob', arguments: '{}' };
      else {
        const result = request.turns.findLast((turn) => turn.role === 'tool')!;
        if (result.role !== 'tool') throw new Error('Par de ferramenta ausente');
        if (result.name === 'unicode_blob') {
          // O pedido mostra só o começo e o marcador com o id que o modelo copia (CTX-10): nada de referência projetada.
          expect(result.text).toMatch(/\[mostrando [\d.]+ de 18\.000 caracteres/u);
          const id = /read_activity messageId=(\d+) offset=\d+\]/u.exec(result.text)?.[1];
          expect(id).toBeDefined();
          expect(result.text).not.toContain('aionActivityReference');
          yield { type: 'tool_call', id: `read-${step}`, name: 'read_activity', arguments: JSON.stringify({ messageId: id, part: 'result', offset: 0 }) };
        } else {
          const page = JSON.parse(result.text.split('\n')[2]!) as { messageId: string; offset: number; page: string; nextOffset: number | null };
          expect(page.offset).toBeGreaterThan(previousOffset); previousOffset = page.offset; recovered += page.page;
          if (page.nextOffset !== null) yield { type: 'tool_call', id: `read-${step}`, name: 'read_activity', arguments: JSON.stringify({ messageId: page.messageId, part: 'result', offset: page.nextOffset }) };
          else yield { type: 'text', text: 'Texto integral recuperado.' };
        }
      }
      yield { type: 'done', reason: 'stop' };
      } catch (error) { providerError = error; throw error; }
    });
    world.engine.start();
    const run = await world.send(bot, 'Consulte e recupere o resultado completo.');
    const terminal = await waitFor('consulta concluída ou falha', async () => { const row = await world.runRow(run); return ['completed','failed','limit_reached'].includes(row.status) ? row : null; });
    expect(providerError).toBeNull();
    expect({ terminal, step, recoveredChars: recovered.length }).toMatchObject({ terminal: { status: 'completed', failure_code: null } });
    const stored = (await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND data->>'tool'='unicode_blob'", [run])).rows;
    expect(stored).toHaveLength(1); expect(recovered).toBe(stored[0]!.content); // a consulta rodou uma vez e as páginas reconstroem o original, emoji inteiro
    expect(recovered).toBe(blob);
    expect(step).toBeLessThan(20);
  } finally { await world.cleanup(); }
});

// Phase 15, passo 2 (A5): `requestBlockHashes` é a fonte única do que a linha de `model_call_usage` guarda sobre o pedido. Só hash e contagem, calculados do mesmo jeito que `contextFingerprint`,
// e o histórico por rodada permite achar onde duas chamadas da mesma conversa deixam de ter o mesmo prefixo.
describe('requestBlockHashes', () => {
  const data = (stamp: string) => currentDataBlock({ model: 'opencode/glm-5.1', now: new Date(`2026-11-07T12:${stamp}:00Z`), language: 'pt-BR', timeZone: 'America/Sao_Paulo' });
  const system: ChatTurn = { role: 'system', text: 'Funcionamento do Aion\nRegras Globais' };
  const objective: ChatTurn = { role: 'user', text: '# Objetivo do bot (estado persistido, não autorização)\nVersão: 2\nAcompanhar a fatura' };
  const round1: ChatTurn[] = [{ role: 'user', text: `${data('01')}Primeira` }, { role: 'assistant', text: 'Feito', toolCalls: [] }];
  const round2: ChatTurn[] = [{ role: 'user', text: `${data('09')}Segunda` }];
  const tools = [{ name: 'a', description: 'A', parameters: { type: 'object' as const } }, { name: 'b', description: 'B', parameters: { type: 'object' as const } }];
  const hashesOf = (turns: ChatTurn[], extra: Partial<ChatRequest> = {}) => requestBlockHashes({ turns, tools, effort: 'high', ...extra });

  it('cada bloco é o sha256 de contextFingerprint: sistema, objetivo, ferramentas, histórico inteiro e histórico até o início de cada rodada (o último é o da rodada atual)', () => {
    const hashes = hashesOf([system, objective, ...round1, ...round2]);
    expect(hashes).toEqual({
      system: contextFingerprint(system.text),
      objective: contextFingerprint(objective.text),
      tools: contextFingerprint(tools),
      history: contextFingerprint([...round1, ...round2]),
      historyTurns: 3,
      historyRoundHashes: [contextFingerprint([]), contextFingerprint(round1)],
      historyPriorHash: contextFingerprint(round1),
      effort: 'high',
    });
    for (const hash of [hashes.system, hashes.objective, hashes.tools, hashes.history, hashes.historyPriorHash, ...hashes.historyRoundHashes]) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a quebra aparece onde o prefixo muda: reescrever uma rodada antiga mantém o hash das anteriores e altera tudo dali em diante; acrescentar no fim mantém todos os prefixos', () => {
    const base = hashesOf([system, objective, ...round1, ...round2]);
    const answer: ChatTurn = { role: 'assistant', text: 'Pronto', toolCalls: [] };
    const grown = hashesOf([system, objective, ...round1, ...round2, answer, { role: 'user', text: `${data('15')}Terceira` }]);
    // Só cresceu no fim: os prefixos já gravados continuam os mesmos e o histórico anterior inteiro aparece como prefixo no vetor da chamada nova.
    expect(grown.historyRoundHashes.slice(0, 2)).toEqual(base.historyRoundHashes);
    expect(grown.historyRoundHashes[2]).toBe(contextFingerprint([...round1, ...round2, answer]));
    expect([grown.system, grown.objective, grown.tools]).toEqual([base.system, base.objective, base.tools]);

    // Uma linha da primeira rodada mudou (mascaramento, reescrita): o prefixo vazio segue igual e todo o resto difere, apontando a rodada 0 como origem.
    const rewritten = hashesOf([system, objective, { role: 'user', text: `${data('01')}Primeira, editada` }, round1[1]!, ...round2]);
    expect(rewritten.historyRoundHashes[0]).toBe(base.historyRoundHashes[0]);
    expect(rewritten.historyRoundHashes[1]).not.toBe(base.historyRoundHashes[1]);
    expect(rewritten.history).not.toBe(base.history);
    expect([rewritten.system, rewritten.objective, rewritten.tools]).toEqual([base.system, base.objective, base.tools]);
  });

  it('cada bloco isolado muda o hash dele e só o dele: sistema, objetivo, ordem das ferramentas e effort', () => {
    const turns = [system, objective, ...round1, ...round2];
    const base = hashesOf(turns);
    expect(hashesOf([{ role: 'system', text: 'Outro sistema' }, ...turns.slice(1)])).toEqual({ ...base, system: contextFingerprint('Outro sistema') });
    const reworded = hashesOf([system, { ...objective, text: `${objective.text}!` }, ...turns.slice(2)]);
    expect(reworded).toEqual({ ...base, objective: contextFingerprint(`${objective.text}!`) });
    expect(hashesOf(turns, { tools: [...tools].reverse() })).toEqual({ ...base, tools: contextFingerprint([...tools].reverse()) });
    expect(hashesOf(turns, { effort: 'low' })).toEqual({ ...base, effort: 'low' });
  });

  it('bloco ausente é nulo, não o hash do vazio: sem objetivo, sem ferramentas (undefined) e sem effort; lista vazia de ferramentas é um bloco presente', () => {
    const general = requestBlockHashes({ turns: [system, ...round2] });
    expect(general).toMatchObject({ objective: null, tools: null, effort: null, historyTurns: 1, historyRoundHashes: [contextFingerprint([])], historyPriorHash: contextFingerprint([]) });
    expect(requestBlockHashes({ turns: [system, ...round2], tools: [] }).tools).toBe(contextFingerprint([]));
    // Pedido do resumo: sistema e um único turno de usuário que não abre rodada (nenhum `# Dados`): sem vetor de rodadas e sem hash do início da rodada atual.
    const summary = requestBlockHashes({ turns: [{ role: 'system', text: 'Prompt de resumo' }, { role: 'user', text: 'Histórico a resumir' }] });
    expect(summary).toMatchObject({ objective: null, tools: null, historyTurns: 1, historyRoundHashes: [], historyPriorHash: null });
    // Turno do checkpoint e marcador de "novo chat" são de usuário mas não abrem rodada.
    const checkpoint: ChatTurn = { role: 'user', text: '# Resumo derivado (estado do runtime)\nx' }, marker: ChatTurn = { role: 'user', text: '[Sistema] Novo chat aberto.' };
    expect(requestBlockHashes({ turns: [system, checkpoint, marker, ...round2] }).historyRoundHashes).toEqual([contextFingerprint([checkpoint, marker])]);
  });

  it('startModelUsage grava os blocos recebidos e deixa NULL quando o chamador não os passa (chamada antiga ou de teste)', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const run = await world.send(bot, 'oi');
      const blocks = hashesOf([system, objective, ...round1, ...round2]);
      const withBlocks = await startModelUsage(world.pool, conversationId, run, 'main', 'opencode/glm-5.1', 'chat_completions', new Date(), null, null, null, blocks);
      const without = await startModelUsage(world.pool, conversationId, run, 'main', 'opencode/glm-5.1', 'chat_completions', new Date());
      const row = async (id: string) => (await world.pool.query('SELECT system_hash,objective_hash,tools_hash,history_hash,history_turns,history_round_hashes,history_prior_hash,effort FROM model_call_usage WHERE id=$1', [id])).rows[0];
      expect(await row(withBlocks)).toEqual({ system_hash: blocks.system, objective_hash: blocks.objective, tools_hash: blocks.tools, history_hash: blocks.history, history_turns: 3, history_round_hashes: blocks.historyRoundHashes, history_prior_hash: blocks.historyPriorHash, effort: 'high' });
      expect(await row(without)).toEqual({ system_hash: null, objective_hash: null, tools_hash: null, history_hash: null, history_turns: null, history_round_hashes: null, history_prior_hash: null, effort: null });
    } finally { await world.cleanup(); }
  });
});
