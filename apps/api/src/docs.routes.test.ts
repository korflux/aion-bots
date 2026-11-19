// Prova HTTP dos docs (phase 14, passo 3a; A8, A15, A26): a borda autenticada da API do dono, com a API real, o banco de teste real e as migrations de verdade, sem mock.
// A regra de negócio (versões, conflito, acesso por bot, restauração, retenção, limites) está provada em @aion/core (`docs.test.ts`); aqui fica o que só a borda prova: sessão,
// Origin e CSRF, allowlist de campos, limite de corpo, rate limit por sessão, envelope de erro com códigos estáveis, "nada gravado" nas recusas e a jornada do dono ponta a ponta.
//
// Organização: cada teste usa a PRÓPRIA sessão (`client`), porque os limitadores são por sessão (120 leituras, 60 escritas e 5 exclusões por minuto) e uma sessão compartilhada
// misturaria as cotas dos testes. O último teste enche o limite de 100 docs e limpa o que criou.
import { randomUUID } from 'node:crypto';
import { DOC_BODY_LIMIT, DOC_LIMITS, type Doc, type DocDeleteResult, type DocList, type DocSummary, type DocVersionDetail, type DocVersionList, type DocWriteResult } from '@aion/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, ORIGIN, type TestApi } from './testing/harness';

let api: TestApi;
const MISSING = '00000000-0000-4000-8000-000000000000';
let nextIp = 70;

beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api?.cleanup();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
/** Dono com sessão própria (IP de login distinto); `headers` sobrescreve para exercitar as recusas dos hooks centrais. */
async function client(): Promise<(method: Method, url: string, payload?: unknown, headers?: Record<string, string>) => Promise<LightMyRequestResponse>> {
  const session = await api.login(`203.0.113.${(nextIp += 1)}`);
  return (method, url, payload, headers = {}) =>
    api.app.inject({ method, url, payload: payload as object | undefined, headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrfToken, ...headers } });
}
type Call = Awaited<ReturnType<typeof client>>;

const op = () => ({ operationId: randomUUID() });
const create = async (call: Call, input: { title?: string; content?: string; botIds?: string[] } = {}): Promise<DocSummary> => {
  const response = await call('POST', '/api/docs', { title: 'Plano', content: '', ...input, ...op() });
  expect(response.statusCode).toBe(201);
  return response.json<DocSummary>();
};
const bot = async (call: Call, name: string): Promise<string> => (await call('POST', '/api/bots', { name, color: '#60A5FA' })).json<{ id: string }>().id;

/** Tudo o que uma escrita de doc poderia tocar: as linhas dos docs (texto por hash), as versões, a associação com bots, os recibos e a auditoria. Igual antes e depois = nada gravado. */
async function state() {
  const count = async (sql: string) => (await api.pool.query<{ n: number }>(sql)).rows[0]!.n;
  return {
    docs: (await api.pool.query('SELECT id, title, version, access_version, md5(content) AS text FROM docs ORDER BY id')).rows,
    versions: await count('SELECT count(*)::int AS n FROM doc_versions'),
    access: await count('SELECT count(*)::int AS n FROM doc_bot_access'),
    receipts: await count('SELECT count(*)::int AS n FROM doc_mutation_receipts'),
    audit: await count("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'doc.%'"),
  };
}

describe('docs API: borda', () => {
  it('exige sessão, Origin e CSRF em toda a árvore e não grava nada nas recusas', async () => {
    const call = await client();
    const doc = await create(call, { title: 'Protegido', content: 'intacto' });
    const routes: [Method, string, unknown?][] = [
      ['GET', '/api/docs'],
      ['POST', '/api/docs', { title: 'Forjado', ...op() }],
      ['GET', `/api/docs/${doc.id}`],
      ['PATCH', `/api/docs/${doc.id}`, { expectedVersion: 1, edit: { operation: 'rewrite', content: 'invadido' }, ...op() }],
      ['GET', `/api/docs/${doc.id}/versions`],
      ['GET', `/api/docs/${doc.id}/versions/1`],
      ['POST', `/api/docs/${doc.id}/restore`, { version: 1, expectedVersion: 1, ...op() }],
      ['PUT', `/api/docs/${doc.id}/access`, { botIds: [], expectedAccessVersion: 1, ...op() }],
      ['DELETE', `/api/docs/${doc.id}`, op()],
    ];
    const before = await state();
    for (const [method, url, payload] of routes) {
      const anonymous = await call(method, url, payload, { cookie: '' });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
      if (method === 'GET') continue;
      const noToken = await call(method, url, payload, { 'x-csrf-token': '' });
      expect(noToken.statusCode).toBe(403);
      expect(noToken.json()).toMatchObject({ code: 'CSRF_TOKEN_INVALID' });
      const foreignOrigin = await call(method, url, payload, { origin: 'https://evil.test' });
      expect(foreignOrigin.statusCode).toBe(403);
      expect(foreignOrigin.json()).toMatchObject({ code: 'CSRF_ORIGIN_INVALID' });
      expect((await call(method, url, payload, { origin: '' })).json()).toMatchObject({ code: 'CSRF_ORIGIN_INVALID' });
    }
    expect(await state()).toEqual(before);
  });

  it('recusa campo fora da allowlist, tipo errado e id malformado no envelope padrão, sem gravar', async () => {
    const call = await client();
    const doc = await create(call, { title: 'Allowlist', content: 'base' });
    const before = await state();
    const rejected = async (method: Method, url: string, payload: unknown, fields: { field: string; reason: string }[]) => {
      const response = await call(method, url, payload);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ code: 'VALIDATION_FAILED', message: 'Dados inválidos.', fields });
    };
    const forbidden = [{ field: 'corpo', reason: 'Campo não permitido.' }];
    // Mass assignment: nenhum campo que só o servidor decide entra por aqui (id, versão, autor, revisão de acesso, datas, tamanho).
    for (const extra of [{ id: randomUUID() }, { version: 99 }, { accessVersion: 99 }, { updatedBy: 'bot' }, { size: 1 }, { createdAt: '2020-01-01T00:00:00.000Z' }]) {
      await rejected('POST', '/api/docs', { title: 'Forjado', ...extra, ...op() }, forbidden);
    }
    await rejected('PATCH', `/api/docs/${doc.id}`, { expectedVersion: 1, botIds: [], edit: { operation: 'append', text: 'x' }, ...op() }, forbidden);
    await rejected('PATCH', `/api/docs/${doc.id}`, { expectedVersion: 1, edit: { operation: 'append', text: 'x', extra: 1 }, ...op() }, [{ field: 'edit', reason: 'Campo não permitido.' }]);
    await rejected('PATCH', `/api/docs/${doc.id}`, { expectedVersion: 1, edit: { operation: 'sobrescrever', text: 'x' }, ...op() }, [{ field: 'edit.operation', reason: 'Valor inválido.' }]);
    await rejected('POST', `/api/docs/${doc.id}/restore`, { version: 1, expectedVersion: 1, content: 'texto', ...op() }, forbidden);
    await rejected('PUT', `/api/docs/${doc.id}/access`, { botIds: [], expectedAccessVersion: 1, owner: true, ...op() }, forbidden);
    await rejected('DELETE', `/api/docs/${doc.id}`, { force: true, ...op() }, forbidden);
    // Texto de controle, versão não inteira e escrita sem a identidade da operação.
    await rejected('POST', '/api/docs', { title: 'Controle', content: 'a\u0000b', ...op() }, [{ field: 'content', reason: 'Valor inválido.' }]);
    await rejected('PATCH', `/api/docs/${doc.id}`, { expectedVersion: 1.5, edit: { operation: 'append', text: 'x' }, ...op() }, [{ field: 'expectedVersion', reason: 'Valor inválido.' }]);
    await rejected('PATCH', `/api/docs/${doc.id}`, { expectedVersion: 1, ...op() }, [{ field: 'corpo', reason: 'Valor inválido.' }]);
    await rejected('POST', '/api/docs', { title: 'Sem operação' }, [{ field: 'operationId', reason: 'Valor inválido.' }]);
    await rejected('DELETE', `/api/docs/${doc.id}`, undefined, [{ field: 'corpo', reason: 'Valor inválido.' }]);
    // Parâmetros e consulta também passam pela allowlist.
    for (const url of ['/api/docs/nao-e-id', '/api/docs/nao-e-id/versions', `/api/docs/${doc.id}/versions/abc`, `/api/docs/${doc.id}/versions/0`]) {
      const response = await call('GET', url);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect((await call('GET', '/api/docs?bot=1')).statusCode).toBe(422);
    expect((await call('GET', '/api/docs?botId=nao-e-id')).statusCode).toBe(422);
    expect(await state()).toEqual(before);
  });

  it('segue a tabela de limites do A8 pela borda: título de 1 a 120 caracteres e texto de até 100.000, nada gravado nas recusas', async () => {
    const call = await client();
    const before = await state();
    for (const title of ['', '   ', 'a'.repeat(121), '😀'.repeat(121), 'duas\nlinhas']) {
      const response = await call('POST', '/api/docs', { title, ...op() });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ field: 'title' }] });
    }
    expect(await state()).toEqual(before);
    // 120 caracteres valem como 120 mesmo quando cada um ocupa 4 bytes em UTF-8 e 2 unidades em UTF-16.
    expect((await create(call, { title: 'a'.repeat(120) })).title).toHaveLength(120);
    expect(Array.from((await create(call, { title: '😀'.repeat(120) })).title)).toHaveLength(120);

    const full = await create(call, { title: 'Texto no limite', content: 'a'.repeat(DOC_LIMITS.contentChars) });
    expect(full.size).toBe(DOC_LIMITS.contentChars);
    const afterFull = await state();
    const tooBig = await call('POST', '/api/docs', { title: 'Texto acima do limite', content: 'a'.repeat(DOC_LIMITS.contentChars + 1), ...op() });
    expect(tooBig.statusCode).toBe(422);
    expect(tooBig.json()).toMatchObject({ code: 'DOC_TOO_LARGE' });
    // O mesmo teto vale para a edição: acrescentar ao doc cheio e reescrever acima do limite são recusados, e o texto e as versões ficam como estavam.
    for (const edit of [{ operation: 'append', text: 'b' }, { operation: 'rewrite', content: 'a'.repeat(DOC_LIMITS.contentChars + 1) }]) {
      const refused = await call('PATCH', `/api/docs/${full.id}`, { expectedVersion: full.version, edit, ...op() });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ code: 'DOC_TOO_LARGE' });
    }
    expect(await state()).toEqual(afterFull);
    expect((await call('GET', `/api/docs/${full.id}`)).json<Doc>().content).toBe('a'.repeat(DOC_LIMITS.contentChars));
  });

  it('recusa o corpo acima do limite da rota e aceita 100.000 caracteres não ASCII, inclusive no pior caso do escape JSON', async () => {
    const call = await client();
    const before = await state();
    // Acima do limite próprio das rotas de docs: recusado no envelope padrão, sem gravar.
    const oversized = JSON.stringify({ title: 'Corpo enorme', content: 'a'.repeat(DOC_BODY_LIMIT), ...op() });
    for (const [method, url] of [['POST', '/api/docs'], ['PATCH', `/api/docs/${MISSING}`], ['PUT', `/api/docs/${MISSING}/access`]] as const) {
      const response = await call(method, url, oversized, { 'content-type': 'application/json' });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({ code: 'PAYLOAD_TOO_LARGE', message: 'Corpo da requisição grande demais.' });
    }
    // As escritas que só levam números, UUIDs e a lista de bots têm teto curto: 32 KiB já é recusado, enquanto o mesmo tamanho é um texto válido ao criar um doc.
    const medium = JSON.stringify({ version: 1, expectedVersion: 1, content: 'a'.repeat(32 * 1024), ...op() });
    for (const [method, url] of [['POST', `/api/docs/${MISSING}/restore`], ['PUT', `/api/docs/${MISSING}/access`], ['DELETE', `/api/docs/${MISSING}`]] as const) {
      const response = await call(method, url, medium, { 'content-type': 'application/json' });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    }
    expect(await state()).toEqual(before);
    expect((await call('POST', '/api/docs', { title: 'Texto médio', content: 'a'.repeat(32 * 1024), ...op() })).statusCode).toBe(201);

    // 100.000 emojis (400.000 bytes em UTF-8) passam do limite global da API (256 KiB), mas são um texto válido.
    const emoji = '😀'.repeat(DOC_LIMITS.contentChars);
    const created = await call('POST', '/api/docs', { title: 'Emojis', content: emoji, ...op() });
    expect(created.statusCode).toBe(201);
    expect(created.json<DocSummary>().size).toBe(DOC_LIMITS.contentChars);
    expect((await call('GET', `/api/docs/${created.json<DocSummary>().id}`)).json<Doc>().content).toBe(emoji);

    // Pior caso: cada caractere astral escapado como par substituto (12 bytes), 1,2 MB de JSON, ainda dentro de `DOC_BODY_LIMIT`.
    const escaped = `{"title":"Escapado","content":"${'\\ud83d\\ude00'.repeat(DOC_LIMITS.contentChars)}","operationId":"${randomUUID()}"}`;
    expect(Buffer.byteLength(escaped)).toBeLessThanOrEqual(DOC_BODY_LIMIT);
    const worst = await call('POST', '/api/docs', escaped, { 'content-type': 'application/json' });
    expect(worst.statusCode).toBe(201);
    expect(worst.json<DocSummary>().size).toBe(DOC_LIMITS.contentChars);
    expect((await call('GET', `/api/docs/${worst.json<DocSummary>().id}`)).json<Doc>().content).toBe(emoji);
  });

  it('limita por sessão: 120 leituras, 60 escritas e 5 exclusões por minuto, em envelope RATE_LIMITED com Retry-After, sem gravar', async () => {
    const before = await state();
    const reader = await client();
    for (let i = 0; i < 120; i += 1) expect((await reader('GET', '/api/docs/nao-e-id')).statusCode).toBe(422);
    const readLimited = await reader('GET', '/api/docs');
    expect(readLimited.statusCode).toBe(429);
    expect(readLimited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(readLimited.headers['retry-after'])).toBeGreaterThan(0);

    const writer = await client();
    for (let i = 0; i < 60; i += 1) expect((await writer('POST', '/api/docs', {})).statusCode).toBe(422);
    const writeLimited = await writer('POST', '/api/docs', { title: 'Acima da cota', ...op() });
    expect(writeLimited.statusCode).toBe(429);
    expect(writeLimited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(writeLimited.headers['retry-after'])).toBeGreaterThan(0);

    // A exclusão tem cota própria, menor: a sexta no mesmo minuto é recusada antes de chegar ao serviço.
    const eraser = await client();
    for (let i = 0; i < 5; i += 1) expect((await eraser('DELETE', `/api/docs/${MISSING}`, op())).statusCode).toBe(404);
    const deleteLimited = await eraser('DELETE', `/api/docs/${MISSING}`, op());
    expect(deleteLimited.statusCode).toBe(429);
    expect(deleteLimited.json()).toMatchObject({ code: 'RATE_LIMITED' });

    // A cota é da sessão: outra sessão do dono segue atendida, e nada do que foi recusado gravou.
    expect((await (await client())('GET', '/api/docs')).statusCode).toBe(200);
    expect(await state()).toEqual(before);
  });
});

describe('docs API: jornada do dono', () => {
  it('cria, lista, lê e responde sempre no envelope padrão quando o doc não existe', async () => {
    const call = await client();
    const botA = await bot(call, 'Bot A dos docs');
    const botB = await bot(call, 'Bot B dos docs');
    const text = '# Plano\n\nTexto inicial';
    const doc = await create(call, { title: 'Plano', content: text, botIds: [botA] });
    expect(doc).toMatchObject({ title: 'Plano', version: 1, accessVersion: 1, size: text.length, botIds: [botA], updatedBy: 'owner' });
    const sibling = await create(call, { title: 'Sem bot' });
    expect(sibling.botIds).toEqual([]);

    const read = await call('GET', `/api/docs/${doc.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.json<Doc>()).toEqual({ ...doc, content: text });

    const all = (await call('GET', '/api/docs')).json<DocList>().docs;
    expect(all.map((item) => item.id)).toEqual(expect.arrayContaining([doc.id, sibling.id]));
    expect(all.every((item) => !('content' in item))).toBe(true);
    // O filtro por bot mostra só os docs compartilhados com ele.
    expect((await call('GET', `/api/docs?botId=${botA}`)).json<DocList>().docs.map((item) => item.id)).toEqual([doc.id]);
    expect((await call('GET', `/api/docs?botId=${botB}`)).json<DocList>().docs).toEqual([]);
    expect((await call('GET', `/api/docs?botId=${MISSING}`)).json()).toMatchObject({ code: 'BOT_NOT_FOUND' });
    expect((await call('POST', '/api/docs', { title: 'Bot fantasma', botIds: [MISSING], ...op() })).json()).toMatchObject({ code: 'BOT_NOT_FOUND' });

    // Um doc que não existe responde igual em toda rota, com o código estável e a mensagem segura.
    const gone = [
      call('GET', `/api/docs/${MISSING}`),
      call('PATCH', `/api/docs/${MISSING}`, { expectedVersion: 1, edit: { operation: 'append', text: 'x' }, ...op() }),
      call('GET', `/api/docs/${MISSING}/versions`),
      call('GET', `/api/docs/${MISSING}/versions/1`),
      call('POST', `/api/docs/${MISSING}/restore`, { version: 1, expectedVersion: 1, ...op() }),
      call('PUT', `/api/docs/${MISSING}/access`, { botIds: [], expectedAccessVersion: 1, ...op() }),
      call('DELETE', `/api/docs/${MISSING}`, op()),
    ];
    for (const response of await Promise.all(gone)) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: 'DOC_NOT_FOUND', message: 'Doc não encontrado.' });
    }
  });

  it('edita por acrescentar, substituir e reescrever, renomeia, recusa conflito e trecho ausente ou ambíguo, e a repetição não grava de novo', async () => {
    const call = await client();
    const doc = await create(call, { title: 'Edições', content: 'um dois dois' });
    const patch = (expectedVersion: number, body: object, operationId = randomUUID()) => call('PATCH', `/api/docs/${doc.id}`, { expectedVersion, operationId, ...body });

    const appended = await patch(1, { edit: { operation: 'append', text: 'três' } });
    expect(appended.statusCode).toBe(200);
    expect(appended.json<DocWriteResult>()).toMatchObject({ changed: true, doc: { version: 2, size: 17 } });
    expect((await call('GET', `/api/docs/${doc.id}`)).json<Doc>().content).toBe('um dois dois\ntrês');

    // Substituir exige o trecho exato e único; os dois erros são resultado de ferramenta que o bot lê, e na tela do dono viram mensagem.
    const missing = await patch(2, { edit: { operation: 'replace', find: 'quatro', replacement: '4' } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ code: 'DOC_TEXT_NOT_FOUND' });
    const ambiguous = await patch(2, { edit: { operation: 'replace', find: 'dois', replacement: '2' } });
    expect(ambiguous.statusCode).toBe(422);
    expect(ambiguous.json()).toMatchObject({ code: 'DOC_TEXT_AMBIGUOUS' });
    const replaced = await patch(2, { edit: { operation: 'replace', find: 'dois dois', replacement: 'dois' } });
    expect(replaced.json<DocWriteResult>().doc.version).toBe(3);

    // Conflito (A11, A12): a versão esperada antiga é recusada com o código estável e o texto fica como o outro autor deixou.
    const stale = await patch(2, { edit: { operation: 'rewrite', content: 'sobrescrita' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ code: 'DOC_CONFLICT', message: 'O doc mudou. Recarregue antes de salvar.' });
    expect((await call('GET', `/api/docs/${doc.id}`)).json<Doc>().content).toBe('um dois\ntrês');

    // Reescrever, só renomear (não cria versão) e salvar texto idêntico (`changed: false`, nenhuma versão nova).
    expect((await patch(3, { edit: { operation: 'rewrite', content: 'texto novo' } })).json<DocWriteResult>().doc).toMatchObject({ version: 4, size: 10 });
    const renamed = (await patch(4, { title: '  Edições renomeadas  ' })).json<DocWriteResult>();
    expect(renamed).toMatchObject({ changed: true, doc: { title: 'Edições renomeadas', version: 4 } });
    expect((await patch(4, { edit: { operation: 'rewrite', content: 'texto novo' } })).json<DocWriteResult>()).toMatchObject({ changed: false, doc: { version: 4 } });
    expect((await api.pool.query('SELECT count(*)::int AS n FROM doc_versions WHERE doc_id = $1', [doc.id])).rows[0]!.n).toBe(4);

    // Repetição da mesma operação (retry de rede): devolve o resultado gravado sem gravar de novo; a mesma identidade com outro conteúdo é conflito.
    const operationId = randomUUID();
    const first = await patch(4, { edit: { operation: 'append', text: 'cinco' } }, operationId);
    expect(first.json<DocWriteResult>().doc.version).toBe(5);
    const again = await patch(4, { edit: { operation: 'append', text: 'cinco' } }, operationId);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect((await patch(4, { edit: { operation: 'append', text: 'seis' } }, operationId)).json()).toMatchObject({ code: 'DOC_CONFLICT' });
    expect((await call('GET', `/api/docs/${doc.id}`)).json<Doc>().content).toBe('texto novo\ncinco');
    expect((await api.pool.query('SELECT count(*)::int AS n FROM doc_versions WHERE doc_id = $1', [doc.id])).rows[0]!.n).toBe(5);

    // A criação também é idempotente pela operação.
    const input = { title: 'Criada uma vez', content: 'um', ...op() };
    const created = await call('POST', '/api/docs', input);
    expect((await call('POST', '/api/docs', input)).json()).toEqual(created.json());
    expect((await api.pool.query("SELECT count(*)::int AS n FROM docs WHERE title = 'Criada uma vez'")).rows[0]!.n).toBe(1);
    expect((await call('POST', '/api/docs', { ...input, content: 'dois' })).json()).toMatchObject({ code: 'DOC_CONFLICT' });
  });

  it('lista as versões, lê uma versão e restaura como versão nova sem apagar as posteriores (A15)', async () => {
    const call = await client();
    const doc = await create(call, { title: 'Histórico', content: 'versão um' });
    await call('PATCH', `/api/docs/${doc.id}`, { expectedVersion: 1, edit: { operation: 'rewrite', content: 'versão dois' }, ...op() });
    await call('PATCH', `/api/docs/${doc.id}`, { expectedVersion: 2, edit: { operation: 'rewrite', content: 'versão três' }, ...op() });

    const listed = await call('GET', `/api/docs/${doc.id}/versions`);
    expect(listed.statusCode).toBe(200);
    const { versions } = listed.json<DocVersionList>();
    expect(versions.map((item) => item.version)).toEqual([3, 2, 1]);
    expect(versions[0]).toMatchObject({ author: 'owner', size: 11, restoredFrom: null });
    // O histórico lista metadados; o texto só vem na leitura de uma versão.
    expect(versions.every((item) => !('content' in item))).toBe(true);
    expect((await call('GET', `/api/docs/${doc.id}/versions/2`)).json<DocVersionDetail>()).toMatchObject({ version: 2, content: 'versão dois', author: 'owner' });
    const absent = await call('GET', `/api/docs/${doc.id}/versions/99`);
    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toMatchObject({ code: 'DOC_VERSION_NOT_FOUND' });

    const stale = await call('POST', `/api/docs/${doc.id}/restore`, { version: 2, expectedVersion: 2, ...op() });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'DOC_CONFLICT' });
    expect((await call('POST', `/api/docs/${doc.id}/restore`, { version: 99, expectedVersion: 3, ...op() })).json()).toMatchObject({ code: 'DOC_VERSION_NOT_FOUND' });
    expect((await call('GET', `/api/docs/${doc.id}/versions`)).json<DocVersionList>().versions).toHaveLength(3);

    const restored = await call('POST', `/api/docs/${doc.id}/restore`, { version: 2, expectedVersion: 3, ...op() });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<DocWriteResult>()).toMatchObject({ changed: true, doc: { version: 4, size: 11 } });
    expect((await call('GET', `/api/docs/${doc.id}`)).json<Doc>().content).toBe('versão dois');
    const after = (await call('GET', `/api/docs/${doc.id}/versions`)).json<DocVersionList>().versions;
    expect(after.map((item) => item.version)).toEqual([4, 3, 2, 1]);
    expect(after[0]).toMatchObject({ author: 'owner', restoredFrom: 2 });
    expect((await call('GET', `/api/docs/${doc.id}/versions/3`)).json<DocVersionDetail>().content).toBe('versão três');
  });

  it('compartilha só pelo dono com a revisão de acesso esperada e a exclusão do bot não apaga o doc', async () => {
    const call = await client();
    const botA = await bot(call, 'Bot A do acesso');
    const botB = await bot(call, 'Bot B do acesso');
    const doc = await create(call, { title: 'Compartilhado', content: 'texto' });
    const share = (botIds: string[], expectedAccessVersion: number, operationId = randomUUID()) => call('PUT', `/api/docs/${doc.id}/access`, { botIds, expectedAccessVersion, operationId });

    const shared = await share([botA, botB], 1);
    expect(shared.statusCode).toBe(200);
    expect(shared.json<DocSummary>()).toMatchObject({ accessVersion: 2, version: 1 });
    expect(shared.json<DocSummary>().botIds.toSorted()).toEqual([botA, botB].toSorted());
    // A revisão de acesso desatualizada (a lista mudou desde que a tela a leu) é conflito, e um bot que não existe não entra.
    expect((await share([botA], 1)).json()).toMatchObject({ code: 'DOC_CONFLICT' });
    expect((await share([MISSING], 2)).json()).toMatchObject({ code: 'BOT_NOT_FOUND' });
    expect((await share([botA, botA], 2)).statusCode).toBe(422);
    expect((await api.pool.query('SELECT count(*)::int AS n FROM doc_bot_access WHERE doc_id = $1', [doc.id])).rows[0]!.n).toBe(2);

    // Lista igual à atual não muda nada; revogar um bot sobe a revisão e tira só o acesso dele.
    expect((await share([botB, botA], 2)).json<DocSummary>().accessVersion).toBe(2);
    const revoked = await share([botA], 2);
    expect(revoked.json<DocSummary>()).toMatchObject({ botIds: [botA], accessVersion: 3 });

    // A25: excluir o bot apaga só a associação dele; o doc e as versões continuam.
    expect((await call('POST', `/api/bots/${botA}/archive`)).statusCode).toBe(200);
    expect((await call('DELETE', `/api/bots/${botA}`, { confirmName: 'Bot A do acesso' })).statusCode).toBe(204);
    const kept = (await call('GET', `/api/docs/${doc.id}`)).json<Doc>();
    expect(kept).toMatchObject({ id: doc.id, content: 'texto', botIds: [] });
  });

  it('exclui pelo dono sem aprovação, apaga as versões, não guarda o título no recibo e a repetição devolve o mesmo resultado', async () => {
    const call = await client();
    const botId = await bot(call, 'Bot da exclusão');
    const doc = await create(call, { title: 'Título que não pode sobrar', content: 'v1', botIds: [botId] });
    await call('PATCH', `/api/docs/${doc.id}`, { expectedVersion: 1, edit: { operation: 'append', text: 'v2' }, ...op() });
    const other = await create(call, { title: 'Vizinho do excluído', content: 'fica' });

    const operationId = randomUUID();
    const removed = await call('DELETE', `/api/docs/${doc.id}`, { operationId });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<DocDeleteResult>()).toEqual({ id: doc.id, deleted: true });
    expect((await call('GET', `/api/docs/${doc.id}`)).json()).toMatchObject({ code: 'DOC_NOT_FOUND' });
    expect((await call('GET', `/api/docs/${doc.id}/versions`)).json()).toMatchObject({ code: 'DOC_NOT_FOUND' });
    // As versões e a associação saem junto; o doc vizinho não é tocado.
    for (const table of ['doc_versions', 'doc_bot_access']) {
      expect((await api.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE doc_id = $1`, [doc.id])).rows[0]!.n).toBe(0);
    }
    expect((await call('GET', `/api/docs/${other.id}`)).json<Doc>().content).toBe('fica');
    // O título sai de todos os recibos do doc (criação, edição e exclusão), e a auditoria nunca o guarda.
    const receipts = (await api.pool.query('SELECT result::text AS result FROM doc_mutation_receipts WHERE doc_id = $1', [doc.id])).rows;
    expect(receipts.length).toBeGreaterThanOrEqual(3);
    expect(receipts.map((row) => row.result).join('')).not.toContain('Título que não pode sobrar');
    expect(JSON.stringify((await api.pool.query("SELECT details FROM audit_log WHERE action LIKE 'doc.%'")).rows)).not.toContain('Título que não pode sobrar');

    // Repetição da exclusão já aplicada (retry de rede) devolve o resultado gravado; uma exclusão nova do mesmo id já é "inexistente".
    const again = await call('DELETE', `/api/docs/${doc.id}`, { operationId });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id: doc.id, deleted: true });
    expect((await call('DELETE', `/api/docs/${doc.id}`, op())).json()).toMatchObject({ code: 'DOC_NOT_FOUND' });
  });

  it('audita criação, edição e exclusão com quem, o quê, quando e de onde, sem título nem texto', async () => {
    const call = await client();
    const doc = await create(call, { title: 'Auditado', content: 'texto secreto do dono' });
    await call('PATCH', `/api/docs/${doc.id}`, { expectedVersion: 1, edit: { operation: 'append', text: 'mais texto' }, ...op() });
    await call('DELETE', `/api/docs/${doc.id}`, op());
    const rows = (await api.pool.query<{ action: string; actor: string; ip: string | null; user_agent: string | null; details: Record<string, unknown> }>(
      'SELECT action, actor, ip, user_agent, details FROM audit_log WHERE target = $1 ORDER BY at, id',
      [doc.id],
    )).rows;
    expect(rows.map((row) => row.action)).toEqual(['doc.create', 'doc.update', 'doc.delete']);
    for (const row of rows) {
      expect(row.actor).toBe('owner');
      expect(row.ip).toBeTruthy();
      expect(row.details).toMatchObject({ actor: 'owner' });
    }
    expect(JSON.stringify(rows)).not.toMatch(/Auditado|texto secreto|mais texto/);
  });

  // Último teste do arquivo: ocupa quase todo o limite de docs com linhas de enchimento (inseridas direto, sem versões) e limpa o que criou.
  it('cria o 100.º doc e recusa o 101.º com DOC_LIMIT_EXCEEDED, sem criar nada (A8)', async () => {
    const call = await client();
    const existing = (await api.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM docs')).rows[0]!.n;
    try {
      await api.pool.query("INSERT INTO docs (id, title, content, updated_by) SELECT gen_random_uuid(), 'Enchimento do limite', '', 'owner' FROM generate_series(1, $1::int)", [DOC_LIMITS.docs - 1 - existing]);
      expect((await create(call, { title: 'Centésimo' })).title).toBe('Centésimo');
      const before = await state();
      const response = await call('POST', '/api/docs', { title: 'Centésimo primeiro', ...op() });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code: 'DOC_LIMIT_EXCEEDED', message: 'O limite de 100 docs foi atingido.' });
      expect(await state()).toEqual(before);
    } finally {
      await api.pool.query("DELETE FROM docs WHERE title = 'Enchimento do limite'");
    }
  });
});
