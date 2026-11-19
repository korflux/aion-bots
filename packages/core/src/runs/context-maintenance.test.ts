// Jornadas da manutenção com fila/worker reais e modelo falso; originais e efeitos ficam no banco descartável.
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createRunsWorld, waitFor,ORIGIN, type RunsWorld } from './test-support';
import * as checkpoints from './context-checkpoint';
import { queueContextMaintenance } from '../conversation/run-queue';
import { contextMaintenanceMigration } from '../db/migrations/0037_context_maintenance';
import { withTransaction } from '../db/pool';
import { SUMMARY_MAX_OUTPUT_TOKENS } from './context-budget';
import { SUMMARY_SECTIONS } from './compaction';

/**
 * Checkpoint válido que o modelo falso devolve no resumo: as sete seções da Decisão 9, com o rótulo na primeira. A T5 valida o formato (seções em ordem, até
 * 16.000 caracteres); um texto livre vira "formato inválido" e não é aplicado, então as jornadas que provam um resumo APLICADO precisam devolver um checkpoint de verdade.
 * `filler` só engorda a primeira seção (a jornada em que o resumo é maior que a origem).
 */
const checkpointText=(label:string,filler=''):string=>SUMMARY_SECTIONS.map((title,index)=>`## ${title}\n${index===0?label+filler:'Nada.'}`).join('\n\n');

/**
 * Histórico antigo semeado ANTES das rodadas reais da jornada: `count` mensagens do dono de `chars` caracteres, cada uma sua própria unidade. O resumo manual
 * (`cutHistory` ocioso) mantém íntegro um trecho final de até 25% do orçamento de entrada (janela de 64k dos mundos de teste, orçamento de 47.104 com a reserva de saída de 16.384 da
 * phase 12: ~11.800 tokens) e só cobre o que passa dele; com a conversa curta das jornadas o lote saía vazio ("nada a cobrir"). Cinco mensagens de ~3.500 caracteres (~17.500 tokens, bem
 * abaixo do limiar automático de 90%, então as rodadas reais não disparam resumo algum) deixam as três mais recentes no trecho final (~10.700 tokens) e as duas mais antigas viram o lote. A cobertura é criada ANTES de semear
 * para a conversa começar do zero (a primeira cobertura de uma conversa que já tem mensagens herda só as últimas cinco rodadas, `loadManagedContext`).
 */
async function seedOlderHistory(world:RunsWorld,botId:string,count=5,chars=3500):Promise<void>{
  const conversationId=await world.conversations.conversationIdOf(botId);
  await checkpoints.loadManagedContext(world.pool,conversationId);
  for(let index=0;index<count;index++) await world.pool.query("INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,$2,now())",[conversationId,`Histórico ${index}: ${'a'.repeat(chars)}`]);
}

it.each(['empty','output_limit'] as const)('resumo manual %s definitivo falha com consumo completo, sem checkpoint ou sucesso ficticio',async(mode)=>{
  const world=await createRunsWorld();
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');let summary=0;await seedOlderHistory(world,bot.id);
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(_key,_protocol,request){
      if(request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS){summary++;yield{type:'usage',usage:{inputTokens:100,outputTokens:2048}};yield{type:'done',reason:mode==='empty'?'stop':'output_limit'};}
      else {yield{type:'text',text:'Resposta inicial'};yield{type:'usage',usage:{inputTokens:10,outputTokens:2}};yield{type:'done',reason:'stop'};}
    });
    world.engine.start();await world.waitForStatus(await world.send(bot,'Pedido anterior'),'completed');
    await world.waitForStatus(await world.send(bot,'Pedido atual'),'completed');
    const state=await world.conversations.contextState(bot.id),requestId=randomUUID();
    await world.conversations.maintainContext(bot.id,{requestId,mode:'summarize',expectedRevision:state.revision},randomUUID());
    const run=(await world.pool.query<{id:string}>('SELECT id::text FROM runs WHERE context_operation_id=$1',[requestId])).rows[0]!.id;
    await world.waitForStatus(run,'failed');
    // Spec F3 passo 6: a recusa definitiva repete a chamada com a entrada reduzida (alvos de 70%, 50% e 35%), então são de UMA a quatro chamadas pagas (antes da T5 era
    // sempre uma). O que a jornada prova não muda: TODA chamada paga fica no ledger como completa e o consumo mostrado é a soma delas, sem checkpoint nem sucesso fictício.
    expect(summary).toBeGreaterThanOrEqual(1);expect(summary).toBeLessThanOrEqual(4);
    expect((await world.conversations.contextState(bot.id)).operation).toMatchObject({status:'failed',errorCode:'CONTEXT_COMPACTION_FAILED',result:{changed:false,summaryUsage:{calls:summary,inputTokens:100*summary,outputTokens:2048*summary,coverage:'complete'}}});
    expect((await world.pool.query('SELECT revision,summary FROM conversation_context')).rows).toEqual([{revision:0,summary:''}]);
    expect((await world.pool.query("SELECT state,summary_outcome FROM model_call_usage WHERE run_id=$1 AND purpose='summary'",[run])).rows).toEqual(Array.from({length:summary},()=>({state:'completed',summary_outcome:mode})));
  }finally{await world.cleanup();}
});

it('"Compactar agora" sem perfil validado ou sem chave é recusado e a elegibilidade diz o motivo, sem inferência nem trabalho novo',async()=>{
  const world=await createRunsWorld();
  try {
    const bot=await world.createBot(),state=await world.conversations.contextState(bot.id);
    await world.credentials.disconnect('provider',ORIGIN);
    const before=world.conversationRequests().length;
    expect((await world.pool.query('SELECT test_protocol FROM model_profiles WHERE model_id=$1',[bot.model])).rows[0]?.test_protocol ?? null).toBeNull();
    const next=await world.conversations.contextState(bot.id);
    expect(next.eligibility.summarizeEnabled).toBe(false);
    expect(next.eligibility.summarizeReason).toContain('Valide o modelo');
    // A elisão saiu do produto: nenhuma razão a menciona, e o texto fala em compactar.
    expect(next.eligibility.summarizeReason).not.toMatch(/elis/i);
    await expect(world.conversations.maintainContext(bot.id,{requestId:randomUUID(),mode:'summarize',expectedRevision:state.revision},randomUUID())).rejects.toMatchObject({code:'MODEL_UNAVAILABLE'});
    // Com o modelo validado mas sem a chave do provedor, a compactação continua recusada.
    await world.credentials.save('provider','valid-key-test-only',ORIGIN);await world.models.test('opencode/glm-5.1');await world.credentials.disconnect('provider',ORIGIN);
    const known=await world.conversations.contextState(bot.id),jobs=(await world.pool.query('SELECT id FROM runs')).rows;
    expect(known.eligibility.summarizeReason).toContain('Configure a chave');
    expect(known.eligibility.summarizeReason).not.toMatch(/elis/i);
    await expect(world.conversations.maintainContext(bot.id,{requestId:randomUUID(),mode:'summarize',expectedRevision:known.revision},randomUUID())).rejects.toMatchObject({code:'PROVIDER_NOT_CONFIGURED'});
    expect((await world.pool.query('SELECT id FROM runs')).rows).toEqual(jobs);
    expect(world.conversationRequests()).toHaveLength(before);
  }finally{await world.cleanup();}
});

it('rollback vazio de0037 é reversível; após operação preserva todos os metadados e rejeita remoção do schema',async()=>{
  const world=await createRunsWorld();
  try {
    await world.pool.query(contextMaintenanceMigration.rollback);
    await world.pool.query(contextMaintenanceMigration.up);
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');const state=await world.conversations.contextState(bot.id),requestId=randomUUID();
    await world.conversations.maintainContext(bot.id,{requestId,mode:'summarize',expectedRevision:state.revision},randomUUID());
    const before=(await world.pool.query('SELECT * FROM context_maintenance')).rows;
    await expect(world.pool.query(contextMaintenanceMigration.rollback)).rejects.toThrow('Preserve manutenção');
    expect((await world.pool.query('SELECT * FROM context_maintenance')).rows).toEqual(before);
    expect((await world.pool.query('SELECT context_operation_id FROM runs')).rows).toEqual([{context_operation_id:requestId}]);
  }finally{await world.cleanup();}
});

it('consulta e compactação sem histórico não inferem, manutenção não vira rodada/push e replay/cancelamento não alteram originais',async () => {
  const world = await createRunsWorld();
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
    const beforeCalls = world.conversationRequests().length;
    const initial = await world.conversations.contextState(bot.id);
    expect(initial.measurement).toBeNull(); expect(initial.usage.last).toBeNull();
    expect(initial.usage.total.calls).toBe(0);
    expect(world.conversationRequests()).toHaveLength(beforeCalls);
    const session = randomUUID(), input = {requestId:randomUUID(),mode:'summarize' as const,expectedRevision:initial.revision};
    const queued = await world.conversations.maintainContext(bot.id,input,session);
    expect(queued.operation?.status).toBe('queued');
    expect(await world.conversations.maintainContext(bot.id,input,session)).toEqual(queued);
    const other = await world.conversations.send(bot.id,'Pedido novo na fila.');
    expect(other.kind).toBe('run');
    expect((await world.pool.query('SELECT context_operation_id FROM runs ORDER BY id')).rows).toEqual([{context_operation_id:input.requestId},{context_operation_id:null}]);
    await world.conversations.cancelContextMaintenance(bot.id,input.requestId);
    expect((await world.conversations.contextState(bot.id)).operation?.status).toBe('cancelled');
    expect((await world.pool.query('SELECT * FROM messages')).rowCount).toBe(0);
    expect(world.conversationRequests()).toHaveLength(beforeCalls);
    // Outro destino vazio executa a compactação real (nada a cobrir) e mede, sem chamada principal nem resumo pago.
    const second = await world.createBot(); const state = await world.conversations.contextState(second.id);
    const request = {requestId:randomUUID(),mode:'summarize' as const,expectedRevision:state.revision};
    await world.conversations.maintainContext(second.id,request,session);
    const runId = (await world.pool.query<{id:string}>('SELECT id::text FROM runs WHERE context_operation_id=$1',[request.requestId])).rows[0]!.id;
    world.engine.start(); await world.waitForStatus(runId,'completed');
    const done = await world.conversations.contextState(second.id);
    expect(done.operation).toMatchObject({status:'completed',result:{changed:false,summaryUsage:{calls:0}}});
    expect(done.measurement).toMatchObject({stale:false});
    expect((await world.pool.query('SELECT * FROM messages WHERE run_id=$1',[runId])).rowCount).toBe(0);
    expect((await world.pool.query('SELECT * FROM push_events WHERE run_id=$1',[runId])).rowCount).toBe(0);
    expect((await world.pool.query('SELECT * FROM model_call_usage WHERE run_id=$1',[runId])).rowCount).toBe(0);
  } finally {await world.cleanup();}
});

it('pedido legado de elisão que ainda estava na fila conclui sem tocar o modelo nem a conversa',async()=>{
  const world=await createRunsWorld();
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');
    const state=await world.conversations.contextState(bot.id),requestId=randomUUID();
    await world.conversations.maintainContext(bot.id,{requestId,mode:'summarize',expectedRevision:state.revision},randomUUID());
    // A borda não aceita mais `elision` (VALIDATION_FAILED), mas uma versão anterior pode ter deixado esse pedido na fila: a linha da fila passa a ser a legada.
    await world.pool.query("UPDATE context_maintenance SET mode='elision' WHERE request_id=$1",[requestId]);
    const run=(await world.pool.query<{id:string}>('SELECT id::text FROM runs WHERE context_operation_id=$1',[requestId])).rows[0]!.id;
    const streamed=vi.spyOn(world.provider,'streamChat'),calls=world.conversationRequests().length;
    world.engine.start();await world.waitForStatus(run,'completed');
    expect(await world.runRow(run)).toMatchObject({status:'completed',failure_code:null});
    // Nenhuma chamada ao provedor, nenhuma linha de uso e nenhuma mensagem: o worker só encerra o pedido que o modo extinto deixou.
    expect(streamed).not.toHaveBeenCalled();
    expect(world.conversationRequests()).toHaveLength(calls);
    expect((await world.pool.query('SELECT 1 FROM model_call_usage')).rowCount).toBe(0);
    expect((await world.pool.query('SELECT 1 FROM messages')).rowCount).toBe(0);
    // O painel o mostra pelo desfecho genérico: concluído, sem resultado e sem código de erro.
    expect((await world.conversations.contextState(bot.id)).operation).toMatchObject({requestId,mode:'elision',status:'completed',result:null,errorCode:null});
  }finally{await world.cleanup();}
});

it('compactar de novo sem histórico novo é no-op sem inferência, e os originais (inclusive um resultado volumoso) seguem íntegros',async()=>{
  const world=await createRunsWorld();
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');await seedOlderHistory(world,bot.id);let summaries=0;
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(_key,_protocol,request){
      if(request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS){summaries++;yield{type:'text',text:checkpointText('Direção preservada.')};}
      else yield{type:'text',text:'Resposta normal.'};
      yield{type:'usage',usage:{inputTokens:100,outputTokens:10}};yield{type:'done',reason:'stop'};
    });
    world.engine.start();
    const run=await world.send(bot,'Origem preservada.');await world.waitForStatus(run,'completed');
    const conversationId=await world.conversations.conversationIdOf(bot.id),original=JSON.stringify({records:[{id:randomUUID(),value:'漢😀'.repeat(1500)}],hasMore:false});
    await world.pool.query("INSERT INTO messages(conversation_id,run_id,role,kind,status,opens_round,step,content,data,tool_arguments,evidence_provenance,created_at) VALUES($1,$2,'assistant','activity','completed',false,1,$3,$4,'{}','{\"attachments\":[],\"tables\":[]}',now())",[conversationId,run,original,JSON.stringify({callId:'large',tool:'table_query',label:'Consulta sintética',arguments:'{}',detail:null})]);
    const before=(await world.pool.query('SELECT * FROM messages ORDER BY id')).rows;
    const compact=async()=>{
      const state=await world.conversations.contextState(bot.id),requestId=randomUUID();
      await world.conversations.maintainContext(bot.id,{requestId,mode:'summarize',expectedRevision:state.revision},randomUUID());
      const id=(await world.pool.query<{id:string}>('SELECT id::text FROM runs WHERE context_operation_id=$1',[requestId])).rows[0]!.id;
      await world.waitForStatus(id,'completed');return world.conversations.contextState(bot.id);
    };
    const first=await compact();expect(first.operation?.result?.changed).toBe(true);expect(summaries).toBe(1);
    // Nada novo entrou: o histórico que sobra é só o trecho final, então a segunda operação não encontra lote e não paga outro resumo.
    const second=await compact();expect(second.operation?.result?.changed).toBe(false);expect(summaries).toBe(1);
    expect(second.operation?.result?.summaryUsage).toMatchObject({calls:0});
    expect((await world.pool.query('SELECT * FROM messages ORDER BY id')).rows).toEqual(before);
    expect((await world.pool.query("SELECT content FROM messages WHERE data->>'callId'='large'")).rows[0]!.content).toBe(original);
  }finally{await world.cleanup();}
});

it('resumo manual abaixo do limiar usa o mesmo modelo, conserva originais, contabiliza uma vez e enfileira novo envio sem complemento',async () => {
  const world = await createRunsWorld();
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => {release=resolve;});
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1'); await seedOlderHistory(world,bot.id);
    let summaryCalls=0;
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function* (_key,_protocol,request) {
      expect(request.model).toBe('opencode/glm-5.1');
      if(request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS) {summaryCalls++; expect(request.tools).toBeUndefined(); await gate; yield {type:'text',text:checkpointText('Direção e decisões preservadas.')};}
      else yield {type:'text',text:'Resposta normal.'};
      yield {type:'usage',usage:{inputTokens:100,outputTokens:10,cachedTokens:20}};
      yield {type:'done',reason:'stop'};
    });
    world.engine.start();
    for(let index=0;index<3;index++) await world.waitForStatus(await world.send(bot,`Decisão ${index}.`),'completed');
    const state=await world.conversations.contextState(bot.id), originals=(await world.pool.query('SELECT * FROM messages ORDER BY id')).rows;
    const input={requestId:randomUUID(),mode:'summarize' as const,expectedRevision:state.revision};
    await world.conversations.maintainContext(bot.id,input,randomUUID());
    await waitFor('resumo manual ativo',async()=>summaryCalls===1);
    const runId=(await world.pool.query<{id:string}>('SELECT id::text FROM runs WHERE context_operation_id=$1',[input.requestId])).rows[0]!.id;
    const next=await world.conversations.send(bot.id,'Pedido depois da manutenção.');
    expect(next.kind).toBe('run');
    expect((await world.pool.query('SELECT 1 FROM complements WHERE run_id=$1',[runId])).rowCount).toBe(0);
    release(); await world.waitForStatus(runId,'completed');
    // Pausa antes de comparar somente os originais; o envio seguinte pode já ter começado no mesmo dispatcher.
    expect((await world.pool.query('SELECT * FROM messages WHERE id=ANY($1::bigint[]) ORDER BY id',[originals.map((row)=>row.id)])).rows).toEqual(originals);
    const done=await world.conversations.contextState(bot.id);
    expect(done.operation).toMatchObject({status:'completed',result:{summaryUsage:{calls:1,inputTokens:100,outputTokens:10,cachedTokens:20}}});
    const calls=summaryCalls;
    await world.conversations.maintainContext(bot.id,input,randomUUID());
    expect(summaryCalls).toBe(calls);
    expect((await world.pool.query('SELECT 1 FROM messages WHERE run_id=$1',[runId])).rowCount).toBe(0);
  } finally {release();await world.cleanup();}
});

it.each(['cancel','restart'] as const)('resumo manual pendente %s preserva checkpoint e nunca repete inferência incerta',async(mode)=>{
  const world=await createRunsWorld();
  let resumed:ReturnType<typeof world.createEngine>|undefined;
  let release=()=>undefined as void;
  const gate=new Promise<void>((resolve)=>{release=resolve;});
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');await seedOlderHistory(world,bot.id);
    let summaries=0;
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(_key,_protocol,request){
      if(request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS){summaries++;await gate;yield{type:'text',text:'Resultado tardio descartado.'};}
      else yield{type:'text',text:'Resposta normal.'};
      yield{type:'done',reason:'stop'};
    });
    world.engine.start();
    for(let index=0;index<2;index++)await world.waitForStatus(await world.send(bot,`Decisão ${index}`),'completed');
    const state=await world.conversations.contextState(bot.id), checkpoint=(await world.pool.query('SELECT revision,summary FROM conversation_context')).rows;
    const input={requestId:randomUUID(),mode:'summarize' as const,expectedRevision:state.revision};
    await world.conversations.maintainContext(bot.id,input,randomUUID());
    await waitFor('resumo pendente',async()=>summaries===1);
    const run=(await world.pool.query<{id:string}>('SELECT id::text FROM runs WHERE context_operation_id=$1',[input.requestId])).rows[0]!.id;
    if(mode==='cancel') {
      await world.conversations.cancelContextMaintenance(bot.id,input.requestId);
      await world.waitForStatus(run,'interrupted');
      expect((await world.conversations.contextState(bot.id)).operation?.status).toBe('cancelled');
    } else {
      await world.engine.stop();resumed=world.createEngine();resumed.start();await world.waitForStatus(run,'failed');
      expect((await world.conversations.contextState(bot.id)).operation).toMatchObject({status:'unknown',errorCode:'CONTEXT_COMPACTION_FAILED'});
    }
    release();
    expect(summaries).toBe(1);expect((await world.pool.query('SELECT revision,summary FROM conversation_context')).rows).toEqual(checkpoint);
    expect((await world.pool.query("SELECT state FROM model_call_usage WHERE run_id=$1",[run])).rows).toEqual([{state:'unknown'}]);
    await world.conversations.maintainContext(bot.id,input,randomUUID());expect(summaries).toBe(1);
  }finally{release();await resumed?.stop();await world.cleanup();}
});

it('restart depois do commit reconhece resultado durável sem pagar outro resumo nem criar rodada',async()=>{
  const world=await createRunsWorld({engine:{pollMs:200}});
  let resumed:ReturnType<typeof world.createEngine>|undefined;
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');await seedOlderHistory(world,bot.id);let summaries=0;
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(_key,_protocol,request){
      if(request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS){summaries++;yield{type:'text',text:checkpointText('Direção conhecida e preservada.')};}
      else yield{type:'text',text:'Resposta normal.'};
      yield{type:'usage',usage:{inputTokens:100,outputTokens:10}};yield{type:'done',reason:'stop'};
    });
    world.engine.start();for(let index=0;index<2;index++)await world.waitForStatus(await world.send(bot,`Decisão ${index}`),'completed');
    // O banco simula perda da posse imediatamente depois do commit durável, antes do finish do worker.
    await world.pool.query(`CREATE FUNCTION lose_maintenance_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE runs SET lease_owner=gen_random_uuid(),lease_until=now()-interval '1 second' WHERE id=NEW.run_id;RETURN NEW;END $$;
      CREATE TRIGGER maintenance_commit_crash AFTER UPDATE OF outcome ON context_maintenance FOR EACH ROW WHEN(NEW.outcome='completed' AND OLD.outcome IS NULL) EXECUTE FUNCTION lose_maintenance_lease();`);
    const state=await world.conversations.contextState(bot.id),requestId=randomUUID();
    await world.conversations.maintainContext(bot.id,{requestId,mode:'summarize',expectedRevision:state.revision},randomUUID());
    const run=(await world.pool.query<{id:string}>('SELECT id::text FROM runs WHERE context_operation_id=$1',[requestId])).rows[0]!.id;
    await waitFor('resultado durável antes finish',async()=>!!(await world.pool.query("SELECT 1 FROM context_maintenance WHERE request_id=$1 AND outcome='completed'",[requestId])).rowCount);
    await world.engine.stop();
    const before=(await world.pool.query('SELECT result FROM context_maintenance WHERE request_id=$1',[requestId])).rows;
    resumed=world.createEngine({pollMs:20});resumed.start();await world.waitForStatus(run,'completed');
    expect(summaries).toBe(1);expect((await world.pool.query('SELECT result FROM context_maintenance WHERE request_id=$1',[requestId])).rows).toEqual(before);
    expect((await world.pool.query('SELECT 1 FROM model_call_usage WHERE run_id=$1',[run])).rowCount).toBe(1);
    expect((await world.pool.query('SELECT 1 FROM messages WHERE run_id=$1',[run])).rowCount).toBe(0);
  }finally{await resumed?.stop();await world.cleanup();}
});

it('resposta válida com CAS recusado e crash preserva uso observado e não paga a mesma fonte ao retomar',async()=>{
  const world=await createRunsWorld({engine:{pollMs:200}});
  let resumed:ReturnType<typeof world.createEngine>|undefined;
  let mock:ReturnType<typeof vi.spyOn>|undefined;
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');await seedOlderHistory(world,bot.id);let summaries=0;
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(_key,_protocol,request){
      if(request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS){summaries++;yield{type:'text',text:checkpointText('Resposta válida cuja aplicação falhará.')};}
      else yield{type:'text',text:'Resposta normal.'};
      yield{type:'usage',usage:{inputTokens:100,outputTokens:10,cachedTokens:5}};yield{type:'done',reason:'stop'};
    });
    world.engine.start();for(let index=0;index<2;index++)await world.waitForStatus(await world.send(bot,`Origem ${index}`),'completed');
    mock=vi.spyOn(checkpoints,'commitContextSummary').mockResolvedValue(false);
    // Perde worker depois de observar a resposta, antes de conseguir marcar a execução terminal.
    await world.pool.query(`CREATE FUNCTION lose_after_summary_settle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE runs SET lease_owner=gen_random_uuid(),lease_until=now()-interval '1 second' WHERE id=NEW.run_id;RETURN NEW;END $$;
      CREATE TRIGGER summary_commit_failure_crash AFTER UPDATE OF state ON model_call_usage FOR EACH ROW WHEN(NEW.purpose='summary' AND OLD.state='started' AND NEW.state<>'started') EXECUTE FUNCTION lose_after_summary_settle();`);
    const state=await world.conversations.contextState(bot.id),requestId=randomUUID(),before=(await world.pool.query('SELECT revision,summary FROM conversation_context')).rows;
    await world.conversations.maintainContext(bot.id,{requestId,mode:'summarize',expectedRevision:state.revision},randomUUID());
    const run=(await world.pool.query<{id:string}>('SELECT id::text FROM runs WHERE context_operation_id=$1',[requestId])).rows[0]!.id;
    await waitFor('uso após resposta e commit inválido',async()=>!!(await world.pool.query("SELECT 1 FROM model_call_usage WHERE run_id=$1 AND state<>'started'",[run])).rowCount);
    await world.engine.stop();resumed=world.createEngine({pollMs:20});resumed.start();await world.waitForStatus(run,'failed');
    expect(summaries).toBe(1);
    expect((await world.pool.query('SELECT revision,summary FROM conversation_context')).rows).toEqual(before);
    expect((await world.pool.query('SELECT state,input_tokens,output_tokens,cached_tokens,preparation_id FROM model_call_usage WHERE run_id=$1',[run])).rows).toEqual([{state:'unknown',input_tokens:'100',output_tokens:'10',cached_tokens:'5',preparation_id:requestId}]);
    expect((await world.conversations.contextState(bot.id)).operation).toMatchObject({status:'unknown',result:{summaryUsage:{calls:1,inputTokens:100,outputTokens:10,coverage:'partial'}}});
  }finally{mock?.mockRestore();await resumed?.stop();await world.cleanup();}
});

it('resumo válido maior que origem é mudança aplicada com consumo visível, sem alegar liberação de espaço',async()=>{
  const world=await createRunsWorld();
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');await seedOlderHistory(world,bot.id);let summaries=0;
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(_key,_protocol,request){
      if(request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS){summaries++;yield{type:'text',text:checkpointText('Resumo extenso sintético.',' Resumo extenso sintético.'.repeat(400))};}
      else yield{type:'text',text:'OK'};
      yield{type:'usage',usage:{inputTokens:100,outputTokens:1000}};yield{type:'done',reason:'stop'};
    });
    world.engine.start();for(let index=0;index<2;index++)await world.waitForStatus(await world.send(bot,`Origem ${index}`),'completed');
    const state=await world.conversations.contextState(bot.id),requestId=randomUUID();
    await world.conversations.maintainContext(bot.id,{requestId,mode:'summarize',expectedRevision:state.revision},randomUUID());
    const run=(await world.pool.query<{id:string}>('SELECT id::text FROM runs WHERE context_operation_id=$1',[requestId])).rows[0]!.id;
    await world.waitForStatus(run,'completed');
    const result=(await world.conversations.contextState(bot.id)).operation!.result!;
    expect(summaries).toBe(1);expect(result.changed).toBe(true);expect(result.afterInputTokens!).toBeGreaterThanOrEqual(result.beforeInputTokens!);
    expect(result.summaryUsage).toMatchObject({calls:1,inputTokens:100,outputTokens:1000});
    expect((await world.pool.query('SELECT revision FROM conversation_context')).rows[0]!.revision).toBe(1);
  }finally{await world.cleanup();}
});

it('duas sessões disputam uma operação; revisão, destino e limite por sessão são conferidos sem criar trabalho extra',async()=>{
  let at=new Date('2026-10-12T20:00:00Z');
  const world=await createRunsWorld({now:()=>at});
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');const state=await world.conversations.contextState(bot.id),session=randomUUID();
    const input={requestId:randomUUID(),mode:'summarize' as const,expectedRevision:state.revision};
    const results=await Promise.allSettled([world.conversations.maintainContext(bot.id,input,session),world.conversations.maintainContext(bot.id,{...input,requestId:randomUUID()},randomUUID())]);
    expect(results.filter((result)=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.find((result)=>result.status==='rejected')).toMatchObject({reason:{code:'CONTEXT_BUSY'}});
    const operation=(await world.pool.query<{request_id:string}>('SELECT request_id FROM context_maintenance')).rows[0]!;
    await world.conversations.cancelContextMaintenance(bot.id,operation.request_id);
    await expect(world.conversations.maintainContext(bot.id,{...input,requestId:randomUUID(),expectedRevision:state.revision+1},randomUUID())).rejects.toMatchObject({code:'CONTEXT_CONFLICT'});
    const another=await world.createBot();
    await expect(world.conversations.maintainContext(another.id,{...input,requestId:operation.request_id},session)).rejects.toMatchObject({code:'CONTEXT_CONFLICT'});
    await expect(world.conversations.cancelContextMaintenance(another.id,operation.request_id)).rejects.toMatchObject({code:'NOT_FOUND'});
    // Nova sessão tem cinco pedidos, enquanto replays do mesmo request não gastam o limite.
    const limited=randomUUID();
    for(let index=0;index<5;index++){
      const current=await world.conversations.contextState(another.id);
      const request={requestId:randomUUID(),mode:'summarize' as const,expectedRevision:current.revision};
      await world.conversations.maintainContext(another.id,request,limited);
      await world.conversations.maintainContext(another.id,request,limited);
      await world.conversations.cancelContextMaintenance(another.id,request.requestId);
    }
    const current=await world.conversations.contextState(another.id);
    await expect(world.conversations.maintainContext(another.id,{...input,requestId:randomUUID(),expectedRevision:current.revision},limited)).rejects.toMatchObject({code:'RATE_LIMITED'});
    at=new Date(at.getTime()+60001);
    await world.conversations.maintainContext(another.id,{...input,requestId:randomUUID(),expectedRevision:current.revision},limited);
  }finally{await world.cleanup();}
});

it('a manutenção fria (sem sessão do dono) não vira "operação" na tela e ocupa a fila; o pedido do dono segue gravando a sessão dele e a auditoria como dono',async()=>{
  const world=await createRunsWorld();
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');
    const conversationId=await world.conversations.conversationIdOf(bot.id),state=await world.conversations.contextState(bot.id),requestId=randomUUID(),session=randomUUID();
    await world.conversations.maintainContext(bot.id,{requestId,mode:'summarize',expectedRevision:state.revision},session);
    await world.conversations.cancelContextMaintenance(bot.id,requestId);
    // O que o dono pede continua gravando a sessão e auditado como dono, sem marca de gatilho frio (a inserção é a mesma da compactação fria).
    expect((await world.pool.query('SELECT session_id FROM context_maintenance WHERE request_id=$1',[requestId])).rows).toEqual([{session_id:session}]);
    expect((await world.pool.query("SELECT actor,details FROM audit_log WHERE action='context.maintenance_requested' AND target=$1",[conversationId])).rows).toEqual([{actor:'owner',details:{requestId,mode:'summarize'}}]);
    expect((await world.conversations.contextState(bot.id)).operation).toMatchObject({requestId,status:'cancelled'});

    // A fria entra depois (mais recente) e fica na fila: a tela segue mostrando a última operação DO DONO, a fase não muda, e a fila ocupada recusa o "Compactar agora".
    const cold=randomUUID();
    await withTransaction(world.pool,(tx)=>queueContextMaintenance(tx,{botId:bot.id,conversationId,requestId:cold,mode:'summarize',expectedRevision:state.revision,sessionId:null,at:new Date(Date.now()+60_000)}));
    expect((await world.pool.query('SELECT session_id FROM context_maintenance WHERE request_id=$1',[cold])).rows).toEqual([{session_id:null}]);
    expect((await world.pool.query("SELECT actor,details FROM audit_log WHERE action='context.maintenance_requested' AND target=$1 AND details->>'requestId'=$2",[conversationId,cold])).rows).toEqual([{actor:'system',details:{requestId:cold,mode:'summarize',trigger:'cold'}}]);
    const shown=await world.conversations.contextState(bot.id);
    expect(shown.operation).toMatchObject({requestId,status:'cancelled'});
    expect(shown.phase).toBe('not_measured');
    // A fria é invisível: o motivo é o genérico de execução aberta (nunca "manutenção em andamento", que a nomearia) e "Compactar agora" fica desabilitado por ele.
    expect(shown.eligibility).toMatchObject({enabled:false,reason:'Há trabalho na fila ou em execução.',summarizeEnabled:false,summarizeReason:'Há trabalho na fila ou em execução.'});
    await expect(world.conversations.maintainContext(bot.id,{requestId:randomUUID(),mode:'summarize',expectedRevision:shown.revision},randomUUID())).rejects.toMatchObject({code:'CONTEXT_BUSY'});

    // O dono não alcança a fria pelo id dela (derivado da conversa e da revisão): cancelar responde NOT_FOUND e a execução segue na fila; repetir como pedido dele é conflito, sem esbarrar na chave primária.
    await expect(world.conversations.cancelContextMaintenance(bot.id,cold)).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(world.conversations.maintainContext(bot.id,{requestId:cold,mode:'summarize',expectedRevision:state.revision},randomUUID())).rejects.toMatchObject({code:'CONTEXT_CONFLICT'});
    expect((await world.pool.query("SELECT r.status,m.outcome FROM context_maintenance m JOIN runs r ON r.id=m.run_id WHERE m.request_id=$1",[cold])).rows).toEqual([{status:'queued',outcome:null}]);
  }finally{await world.cleanup();}
});

it('a entrada do resumo leva o marcador do mascaramento frio no lugar do resultado (phase 11, T7, decisão 19); o que não foi mascarado entra como sempre',async()=>{
  const world=await createRunsWorld();
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');
    const conversationId=await world.conversations.conversationIdOf(bot.id);
    await checkpoints.loadManagedContext(world.pool,conversationId); // a cobertura começa do zero: o que vem depois entra no lote
    await world.pool.query("INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,'Pedido antigo do dono',now())",[conversationId]);
    const result=async(callId:string,content:string)=>(await world.pool.query<{id:string}>(
      "INSERT INTO messages(conversation_id,role,kind,status,opens_round,step,content,data,tool_arguments,evidence_provenance,created_at) VALUES($1,'assistant','activity','completed',false,1,$2,$3,'{}','{\"attachments\":[],\"tables\":[]}',now()) RETURNING id::text AS id",
      [conversationId,content,JSON.stringify({callId,tool:'table_query',label:'Consulta sintética',arguments:'{}',detail:null})])).rows[0]!.id;
    const maskedContent=`PAYLOAD_MASCARADO ${'m'.repeat(5000)}`,plainContent=`PAYLOAD_NORMAL ${'n'.repeat(5000)}`;
    const masked=await result('masked',maskedContent),plain=await result('plain',plainContent);
    // A limpeza fria gravou só o primeiro; o segundo é grande como ele e não foi mascarado.
    await world.pool.query('INSERT INTO context_cold_masks(message_id,conversation_id,masked_at) VALUES($1,$2,now())',[masked,conversationId]);
    // Histórico depois deles, grande o bastante para o lote do resumo manual alcançar os resultados antigos (o trecho final é de até 25% do orçamento).
    for(let index=0;index<5;index++) await world.pool.query("INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,$2,now())",[conversationId,`Histórico ${index}: ${'a'.repeat(4000)}`]);

    const summaries:string[]=[];
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(_key,_protocol,request){
      if(request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS){summaries.push(request.turns.map((turn)=>turn.text).join('\n'));yield{type:'text',text:checkpointText('Checkpoint com o marcador.')};}
      else yield{type:'text',text:'Resposta normal.'};
      yield{type:'usage',usage:{inputTokens:100,outputTokens:10}};yield{type:'done',reason:'stop'};
    });
    world.engine.start();
    const state=await world.conversations.contextState(bot.id),requestId=randomUUID();
    await world.conversations.maintainContext(bot.id,{requestId,mode:'summarize',expectedRevision:state.revision},randomUUID());
    const run=(await world.pool.query<{id:string}>('SELECT id::text FROM runs WHERE context_operation_id=$1',[requestId])).rows[0]!.id;
    await world.waitForStatus(run,'completed');
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    const input=summaries[0]!;
    // O resumo vê o histórico na forma enviada ao modelo: o resultado mascarado entra como o marcador (ferramenta, tamanho gravado, id e releitura), sem o conteúdo...
    expect(input).toContain(`[resultado de table_query, ${maskedContent.length.toLocaleString('pt-BR')} caracteres, #${masked}; releia com read_activity]`);
    expect(input).not.toContain('PAYLOAD_MASCARADO');
    // ...e o resultado que não foi mascarado entra como sempre (começo do texto e o aviso de omissão com o id).
    expect(input).toContain('PAYLOAD_NORMAL');
    expect(input).toContain(`íntegro em read_activity messageId=${plain}`);
    expect(input).toContain('Pedido antigo do dono');
    // O que está gravado não mudou (a limpeza é só uma marca).
    expect((await world.pool.query<{content:string}>('SELECT content FROM messages WHERE id=$1',[masked])).rows[0]!.content).toBe(maskedContent);
  }finally{vi.restoreAllMocks();await world.cleanup();}
},60_000);
