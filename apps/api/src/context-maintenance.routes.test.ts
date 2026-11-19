// Contrato HTTP da manutenção ("Compactar agora"): sessão/CSRF/Origin, corpo estrito com `mode` só `summarize` (a elisão manual saiu na phase 9 e é recusada com
// VALIDATION_FAILED), idempotência, rate limit e metadados sem conteúdo.
import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { startFakeUpstreams } from '@aion/core/testing';
import { contextStateSchema,type ContextState } from '@aion/shared';
import { createTestApi,ORIGIN } from './testing/harness';

it('GET é somente metadados, POST exige segurança e rejeita parâmetros/corpo fora do contrato',async()=>{
  const upstream=await startFakeUpstreams();
  const api=await createTestApi({AION_OPENCODE_GO_BASE_URL:upstream.opencodeGoBaseUrl});
  try {
    const own=await api.login('203.0.113.121');
    const headers={cookie:own.cookie,origin:ORIGIN,'x-csrf-token':own.csrfToken};
    await api.app.inject({method:'POST',url:'/api/credentials/provider',payload:{key:'valid-key-synthetic'},headers});
    const created=await api.app.inject({method:'POST',url:'/api/bots',payload:{name:'Contrato contexto',color:'#60A5FA',instructions:'TEXTO-PRIVADO-NAO-RETORNAR',model:'opencode/glm-5.1',effort:null,stepLimit:25},headers});
    expect(created.statusCode).toBe(201);
    const id=(created.json() as {id:string}).id,base=`/api/bots/${id}/conversation/context`;
    // O resumo exige o perfil do modelo validado (MODEL_UNAVAILABLE sem ele): a validação é feita aqui, antes de contar as chamadas ao provedor.
    expect((await api.app.inject({method:'POST',url:'/api/models/test',payload:{model:'opencode/glm-5.1'},headers})).statusCode).toBe(200);
    const before=upstream.requests.length;
    const read=await api.app.inject({method:'GET',url:base,headers:{cookie:own.cookie}});
    expect(read.statusCode).toBe(200);
    const state=contextStateSchema.parse(read.json());
    expect(state.measurement).toBeNull();expect(state.usage.last).toBeNull();
    expect(read.body).not.toContain('TEXTO-PRIVADO-NAO-RETORNAR');expect(upstream.requests).toHaveLength(before);
    expect((await api.app.inject({method:'GET',url:base})).statusCode).toBe(401);
    const payload={requestId:randomUUID(),mode:'summarize',expectedRevision:state.revision};
    expect((await api.app.inject({method:'POST',url:`${base}/maintenance`,headers:{cookie:own.cookie,origin:ORIGIN},payload})).statusCode).toBe(403);
    expect((await api.app.inject({method:'POST',url:`${base}/maintenance`,headers:{...headers,origin:'https://other.invalid'},payload})).statusCode).toBe(403);
    for(const extra of [{...payload,model:'another'},{...payload,expectedRevision:-1},{...payload,mode:'arbitrary'}])expect((await api.app.inject({method:'POST',url:`${base}/maintenance`,headers,payload:extra})).statusCode).toBe(422);
    // A elisão manual deixou de existir: o modo é recusado na borda com o envelope padrão (código estável, mensagem segura) e nada entra na fila.
    const elision=await api.app.inject({method:'POST',url:`${base}/maintenance`,headers,payload:{...payload,mode:'elision'}});
    expect(elision.statusCode).toBe(422);expect(elision.json()).toMatchObject({code:'VALIDATION_FAILED'});
    expect(elision.body).not.toMatch(/stack|zod|elision/i);
    expect((await api.app.inject({method:'GET',url:base,headers})).json()).toMatchObject({operation:null});
    expect((await api.pool.query('SELECT 1 FROM context_maintenance')).rowCount).toBe(0);
    expect((await api.app.inject({method:'POST',url:`${base}/maintenance`,headers,payload:{...payload,extra:'x'.repeat(1100)}})).statusCode).toBe(413);
    const first=await api.app.inject({method:'POST',url:`${base}/maintenance`,headers,payload});expect(first.statusCode).toBe(200);
    expect(contextStateSchema.parse(first.json()).operation?.status).toBe('queued');
    const repeat=await api.app.inject({method:'POST',url:`${base}/maintenance`,headers,payload});expect(repeat.json()).toEqual(first.json());
    const busy=await api.app.inject({method:'POST',url:`${base}/maintenance`,headers,payload:{...payload,requestId:randomUUID()}});expect(busy.statusCode).toBe(409);expect(busy.json()).toMatchObject({code:'CONTEXT_BUSY'});
    const cancel=await api.app.inject({method:'POST',url:`${base}/maintenance/${payload.requestId}/cancel`,headers,payload:{}});expect(cancel.statusCode).toBe(200);expect((cancel.json() as ContextState).operation?.status).toBe('cancelled');
    expect((await api.pool.query('SELECT 1 FROM messages')).rowCount).toBe(0);expect(upstream.requests).toHaveLength(before);
  }finally{await api.cleanup();await upstream.stop();}
});

it('rate limit é compartilhado por sessão de login entre conversas e informa Retry-After sem inferir',async()=>{
  const upstream=await startFakeUpstreams();
  const api=await createTestApi({AION_OPENCODE_GO_BASE_URL:upstream.opencodeGoBaseUrl});
  try {
    const own=await api.login('203.0.113.122'),headers={cookie:own.cookie,origin:ORIGIN,'x-csrf-token':own.csrfToken};
    await api.app.inject({method:'POST',url:'/api/credentials/provider',payload:{key:'valid-key-synthetic'},headers});
    expect((await api.app.inject({method:'POST',url:'/api/models/test',payload:{model:'opencode/glm-5.1'},headers})).statusCode).toBe(200);
    const ids:string[]=[];
    for(let index=0;index<2;index++){
      const created=await api.app.inject({method:'POST',url:'/api/bots',payload:{name:`Rate ${index}`,color:'#60A5FA',instructions:'',model:'opencode/glm-5.1',effort:null,stepLimit:25},headers});
      ids.push((created.json() as {id:string}).id);
    }
    for(let index=0;index<5;index++){
      const base=`/api/bots/${ids[index%2]}/conversation/context`,state=(await api.app.inject({method:'GET',url:base,headers})).json() as ContextState;
      const requestId=randomUUID();
      expect((await api.app.inject({method:'POST',url:`${base}/maintenance`,headers,payload:{requestId,mode:'summarize',expectedRevision:state.revision}})).statusCode).toBe(200);
      expect((await api.app.inject({method:'POST',url:`${base}/maintenance/${requestId}/cancel`,headers,payload:{}})).statusCode).toBe(200);
    }
    const base=`/api/bots/${ids[0]}/conversation/context`,state=(await api.app.inject({method:'GET',url:base,headers})).json() as ContextState;
    const limit=await api.app.inject({method:'POST',url:`${base}/maintenance`,headers,payload:{requestId:randomUUID(),mode:'summarize',expectedRevision:state.revision}});
    expect(limit.statusCode).toBe(429);expect(limit.headers['retry-after']).toBeDefined();expect(limit.json()).toMatchObject({code:'RATE_LIMITED'});
  }finally{await api.cleanup();await upstream.stop();}
});
