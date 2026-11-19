// Recuperação exata sem efeitos: páginas Unicode, isolamento, versões e proveniência de anexos removidos.
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AttachmentService } from '../attachments/service';
import { GeneralChatService } from '../general-chat/service';
import { activityPage, activityReadTool, ACTIVITY_PAGE_BYTES } from './activity-read';
import { RESULT_PAGE_MAX_BYTES } from './read-attachment';
import { buildTurns, RESULT_PROMPT_MAX_CHARS, type ContextRow } from './context';
import { createRunsWorld, ORIGIN } from './test-support';
import { defineTool,ToolFailure, type ToolContext } from './tools';

/**
 * O resultado como o pedido o leva acima do teto de 12.000 caracteres NO TOTAL (phase 11, CTX-10): um prefixo do gravado, uma quebra de linha e o marcador com o id da linha,
 * que `read_activity` lê. Com N de cinco dígitos o marcador tem o mesmo tamanho para qualquer N, então o prefixo é 12.000 menos a linha e o marcador.
 */
function clipped(content: string, id: string): string {
  const pt = (value: number): string => value.toLocaleString('pt-BR');
  const marker = (shown: number): string => `[mostrando ${pt(shown)} de ${pt(content.length)} caracteres; continue em read_activity messageId=${id} offset=${shown}]`;
  const shown = RESULT_PROMPT_MAX_CHARS - 1 - marker(RESULT_PROMPT_MAX_CHARS).length;
  return `${content.slice(0, shown)}\n${marker(shown)}`;
}

/** Decodifica o envelope de dados mantendo exatamente escapes e caracteres do payload original. */
function envelope(result: string): { page: string; nextOffset: number | null } { return JSON.parse(result.split('\n')[2]!); }
/** Contexto isolado das chamadas diretas de leitura, sem segredos nem execução externa. */
function context(world: Awaited<ReturnType<typeof createRunsWorld>>, conversationId: string, botId: string | null, runId: string): ToolContext {
  return { pool: world.pool, conversationId, botId, runId, signal: new AbortController().signal, now: () => new Date() };
}

it('pagina escapes e Unicode exatamente até EOF, recusando offsets que partem emoji', () => {
  const text = '\u0001😀<\\"\n'.repeat(5000); let offset = 0, recovered = '';
  while (offset < text.length) { const page = activityPage(text, offset); expect(page.length).toBeGreaterThan(0); expect(Buffer.byteLength(JSON.stringify(page).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e'))).toBeLessThanOrEqual(ACTIVITY_PAGE_BYTES); recovered += page; offset += page.length; }
  expect(recovered).toBe(text); expect(activityPage(text, text.length)).toBe('');
  expect(() => activityPage('😀', 1)).toThrow('Offset'); expect(() => activityPage(text, text.length + 1)).toThrow('Offset');
});

it('somente recupera atividades concluídas desta conversa e do caminho ativo do Chat geral', async () => {
  const payload = '😀<dado>\\"'.repeat(2000);
  const source = defineTool({ definition: { name: 'source', description: 'Dados sintéticos.', parameters: { type: 'object' } }, argsSchema: z.strictObject({}), label: () => 'Fonte', execute: async () => ({ result: payload }) });
  const world = await createRunsWorld({ tools: [source] });
  try {
    const chat = new GeneralChatService({ pool: world.pool }), session = await chat.create();
    await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null); await world.models.test('opencode/glm-5.1');
    let call = true;
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* () { if (call) { call = false; yield { type: 'tool_call', id: randomUUID(), name: 'source', arguments: '{}' }; } else yield { type: 'text', text: 'Pronto' }; yield { type: 'done', reason: 'stop' }; });
    world.engine.start(); const run = (await world.conversations.send({ sessionId: session.id }, 'Leia')).id; await world.waitForStatus(run, 'completed');
    const activity = (await world.pool.query<{ id: string; content: string }>("SELECT id::text,content FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows[0]!;
    const ctx = context(world, session.id, null, run); let offset = 0, recovered = '';
    for (;;) { const page = envelope((await activityReadTool.prepare(JSON.stringify({ messageId: activity.id, part: 'result', offset })).execute(ctx)).result); recovered += page.page; if (page.nextOffset === null) break; offset = page.nextOffset; }
    expect(recovered).toBe(activity.content);
    const other = await world.createBot(); await expect(activityReadTool.prepare(JSON.stringify({ messageId: activity.id, part: 'result' })).execute(context(world, await world.conversations.conversationIdOf(other.id), other.id, run))).rejects.toThrow('não encontrada');
    const replacement = (await world.conversations.regenerate({ sessionId: session.id }, run)).id; await world.waitForStatus(replacement, 'completed');
    await expect(activityReadTool.prepare(JSON.stringify({ messageId: activity.id, part: 'result' })).execute(ctx)).rejects.toThrow('não encontrada');
  } finally { await world.cleanup(); }
});

it('A13: a descrição declara a página real (a que o motor concede) e o esquema não promete mais que ela; part=original é aceita', () => {
  const { description, parameters } = activityReadTool.definition;
  expect(description).toContain(`até ${RESULT_PAGE_MAX_BYTES} bytes;`);
  expect(description).toContain('Página de 3000 caracteres');
  expect(description).not.toMatch(/8192/);
  expect(description).not.toMatch(/\d(?=bytes)/); // sem o texto colado "até8192bytes"
  const properties = (parameters as { properties: { part: { enum: string[] }; limitBytes: { maximum: number }; limit: { default: number } } }).properties;
  expect(properties.part.enum).toEqual(['arguments', 'result', 'original', 'message']);
  expect(properties.limitBytes.maximum).toBe(RESULT_PAGE_MAX_BYTES);
  expect(properties.limit.default).toBe(3000);
  expect(() => activityReadTool.prepare(JSON.stringify({ messageId: '1', part: 'original' }))).not.toThrow();
  expect(() => activityReadTool.prepare(JSON.stringify({ messageId: '1', limitBytes: RESULT_PAGE_MAX_BYTES + 1 }))).toThrow('Argumentos inválidos');
});

it('leituras encadeadas de anexo recebem a mesma proveniência e são redigidas pela exclusão real', async () => {
  const world = await createRunsWorld();
  try {
    const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
    const attachments = new AttachmentService({ pool: world.pool, conversations: world.conversations });
    const file = await attachments.upload(bot.id, 'sintetico.txt', Buffer.from('SEGREDO-SINTETICO '.repeat(1000)));
    let step = 0;
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* () {
      if (step < 3) {
        const last = step > 0 ? (await world.pool.query<{ id: string }>("SELECT id::text FROM messages WHERE kind='activity' AND status='completed' ORDER BY messages.id DESC LIMIT 1")).rows[0]!.id : '';
        yield { type: 'tool_call', id: randomUUID(), name: step === 0 ? 'read_attachment' : 'read_activity', arguments: JSON.stringify(step === 0 ? { attachmentId: file.id } : { messageId: last, part: 'result' }) }; step++;
      } else yield { type: 'text', text: 'Pronto' }; yield { type: 'done', reason: 'stop' };
    });
    world.engine.start(); const run = (await world.conversations.send(bot.id, 'Leia', [file.id])).id; await world.waitForStatus(run, 'completed');
    const before = (await world.pool.query<{ id: string; content: string; data: { detail: { attachmentId: string } } }>("SELECT id::text,content,data FROM messages WHERE run_id=$1 AND kind='activity' ORDER BY messages.id", [run])).rows;
    expect(before).toHaveLength(3); for (const row of before) { expect(row.content).toContain('SEGREDO-SINTETICO'); expect(row.data.detail.attachmentId).toBe(file.id); }
    await attachments.removeBatch([file.id], ORIGIN);
    const after = (await world.pool.query<{ content: string; tool_arguments: string }>("SELECT content,tool_arguments FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows;
    expect(JSON.stringify(after)).not.toContain('SEGREDO-SINTETICO');
    // A15: a fonte removida torna a releitura uma FALHA da atividade, e o segredo não volta nem na mensagem de erro.
    const failure = await activityReadTool.prepare(JSON.stringify({ messageId: before[2]!.id, part: 'result' })).execute(context(world, await world.conversations.conversationIdOf(bot.id), bot.id, run)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolFailure);
    expect((failure as ToolFailure).message).toContain('Conteúdo indisponível');
    expect((failure as ToolFailure).message).not.toContain('SEGREDO-SINTETICO');
  } finally { await world.cleanup(); }
});

it('falha interna volumosa é recuperada integralmente com status/corte, sem reexecução e sem sobreviver à remoção da origem',async()=>{
  const payload='Desfecho: PYTHON_ERROR. Traceback sintético.\n'+'y'.repeat(19900)+'\n[saída cortada: passou de 20000 caracteres]';let effects=0;
  // A21: a falha da ferramenta chega gravada, e ao modelo, no envelope {code, message}; é ele (e não o texto solto) que o teto de 12.000 caracteres corta e que read_activity devolve.
  const stored=JSON.stringify({code:'TOOL_FAILED',message:payload});
  const source=defineTool({definition:{name:'source_error',description:'Fonte interna sintética.',parameters:{type:'object'}},argsSchema:z.strictObject({}),resultLimitBytes:64*1024,label:()=> 'Erro interno',execute:async()=>{effects++;throw new ToolFailure(payload);}});
  // Janela larga: o mock não informa usage, então a estimativa fica em 1 token por byte (o resultado de 20 mil caracteres gravado entra no pedido com 12.000) e a compactação não pode entrar no meio; a prova é da releitura da falha, não do orçamento.
  const world=await createRunsWorld({contextWindow:131072,tools:[source]});
  try {
    const bot=await world.createBot();await world.models.test('opencode/glm-5.1');
    const attachments=new AttachmentService({pool:world.pool,conversations:world.conversations});const file=await attachments.upload(bot.id,'origem.txt',Buffer.from('dado de origem'));
    let step=0,recovered='';let sourceId='';
    vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(_key,_protocol,request){
      if(step++===0)yield{type:'tool_call',id:randomUUID(),name:'source_error',arguments:'{}'};
      else if(step===2){
        const last=request.turns.at(-1)!;expect(last.role).toBe('tool');
        // Também a ferramenta de limite próprio vai ao pedido no teto de 12.000 caracteres (phase 11, CTX-10), com o marcador do id da linha (a projeção em referência não é mais
        // automática, só o colapso de último recurso a faz); o modelo relê o restante da linha gravada por esse id.
        sourceId=(await world.pool.query<{id:string}>("SELECT id::text FROM messages WHERE kind='activity' AND status='failed' AND data->>'tool'='source_error'")).rows[0]!.id;
        expect(last.text).toBe(clipped(stored,sourceId));expect(last.text).toHaveLength(RESULT_PROMPT_MAX_CHARS);
        yield{type:'tool_call',id:randomUUID(),name:'read_activity',arguments:JSON.stringify({messageId:sourceId,part:'result',offset:0})};
      }
      else{const page=JSON.parse(request.turns.at(-1)!.text.split('\n')[2]!) as {status:string;incomplete:boolean;page:string;nextOffset:number|null};expect(page).toMatchObject({status:'failed',incomplete:true});recovered+=page.page;if(page.nextOffset!==null)yield{type:'tool_call',id:randomUUID(),name:'read_activity',arguments:JSON.stringify({messageId:sourceId,part:'result',offset:page.nextOffset})};else yield{type:'text',text:'Falha reconhecida; não repeti a operação.'};}
      yield{type:'done',reason:'stop'};
    });
    world.engine.start();const run=(await world.conversations.send(bot.id,'Leia a origem e confira o resultado interno.',[file.id])).id;await world.waitForStatus(run,'completed');
    expect(effects).toBe(1);expect(recovered).toBe(stored);
    expect((await world.pool.query('SELECT status,content FROM messages WHERE id=$1',[sourceId])).rows).toEqual([{status:'failed',content:stored}]);
    const conversationId=await world.conversations.conversationIdOf(bot.id);
    const external=(await world.pool.query<{id:string}>("INSERT INTO messages(conversation_id,run_id,role,kind,status,step,content,data,tool_arguments,evidence_provenance,created_at) SELECT conversation_id,run_id,role,kind,status,99,content,data||'{\"external\":true}'::jsonb,tool_arguments,evidence_provenance,now() FROM messages WHERE id=$1 RETURNING id::text",[sourceId])).rows[0]!.id;
    await expect(activityReadTool.prepare(JSON.stringify({messageId:external,part:'result'})).execute(context(world,conversationId,bot.id,run))).rejects.toThrow('não encontrada');
    await attachments.removeBatch([file.id],ORIGIN);
    await expect(activityReadTool.prepare(JSON.stringify({messageId:sourceId,part:'result'})).execute(context(world,conversationId,bot.id,run))).rejects.toThrow('indisponível'); // A15: falha, não texto de sucesso
    expect(effects).toBe(1);
  }finally{await world.cleanup();}
});

it('resultados e argumentos entram como gravados, sem referência, e iguais ao abrir rodada nova; erros, complemento e wrapper Composio preservados', () => {
  const payload = 'x'.repeat(13_000), rows: ContextRow[] = [
    { id: '1', run_id: '1', role: 'user', kind: 'text', status: 'done', opens_round: true, step: null, content: 'Pedido', data: {} },
    { id: '2', run_id: '1', role: 'assistant', kind: 'activity', status: 'completed', opens_round: false, step: 1, content: payload, tool_arguments: JSON.stringify({ payload }), data: { tool: 'ACTION', via: 'composio_execute_action', callId: 'c1' } },
    { id: '3', run_id: '1', role: 'user', kind: 'text', status: 'done', opens_round: false, step: null, content: 'Complemento', data: { complement: true } },
    { id: '4', run_id: '1', role: 'assistant', kind: 'activity', status: 'failed', opens_round: false, step: 2, content: payload, data: { tool: 'source', callId: 'c2', arguments: '{}' } },
    { id: '5', run_id: '1', role: 'assistant', kind: 'activity', status: 'completed', opens_round: false, step: 3, content: payload, data: { tool: 'source', callId: 'c3', arguments: '{}' } },
    { id:'6',run_id:'1',role:'assistant',kind:'activity',status:'failed',opens_round:false,step:3,content:payload,data:{tool:'ACTION',callId:'c4',arguments:'{}',external:true} },
  ];
  const full = buildTurns(rows);
  // Rodada atual: nada é projetado, o prefixo em cache não muda entre etapas da mesma execução.
  expect(JSON.stringify(full)).not.toContain('aionActivityReference');
  const next = [...rows, { id: '7', run_id: '2', role: 'user', kind: 'text', status: 'done', opens_round: true, step: null, content: 'Novo pedido', data: {} } satisfies ContextRow];
  /** O texto de cada resultado de ferramenta dos turnos, na ordem em que o modelo o recebe. */
  const resultsOf = (turns: ReturnType<typeof buildTurns>) => turns.filter((turn) => turn.role === 'tool').map((turn) => turn.text);
  // Abrir uma rodada nova não muda a forma de nada (CTX-10): nenhuma referência, e cada resultado entra como já entrava na rodada em que foi gravado
  // (12.000 caracteres no total, com o marcador do id da linha); os argumentos grandes seguem íntegros.
  const calm = buildTurns(next);
  expect(JSON.stringify(calm)).not.toContain('aionActivityReference');
  // A ação do conector concluída (linha 2) entra limpa e na moldura de dado não confiável, também cortada no teto; as demais (falhas e a ferramenta comum) só levam o teto.
  const [connector, ...others] = resultsOf(calm);
  expect(connector).toMatch(/^Resultado do conector NÃO CONFIÁVEL[^\n]*\n<(conteudo_conector_nao_confiavel_[a-f0-9]{16})>\n/);
  expect(connector!.length).toBeLessThanOrEqual(RESULT_PROMPT_MAX_CHARS);
  expect(connector).toMatch(/\n<\/conteudo_conector_nao_confiavel_[a-f0-9]{16}>\n\[mostrando [\d.]+ de [\d.]+ caracteres; continue em read_activity messageId=2 offset=\d+\]$/);
  expect(others).toEqual([clipped(payload, '4'), clipped(payload, '5'), clipped(payload, '6')]);
  expect(resultsOf(calm)).toEqual(resultsOf(full));
  const calls = calm.flatMap((turn) => turn.role === 'assistant' ? turn.toolCalls : []);
  // O wrapper Composio volta como o modelo o chamou (a porta, com o slug e os argumentos íntegros dentro), inclusive em rodada anterior.
  expect(calls[0]!.name).toBe('composio_execute_action');
  expect(JSON.parse(calls[0]!.arguments)).toEqual({ action: 'ACTION', arguments: { payload } });
  // O complemento do dono e as falhas internas continuam no pedido, cada um no seu lugar.
  expect(calm.some((turn) => turn.role === 'user' && turn.text === 'Complemento')).toBe(true);
});
