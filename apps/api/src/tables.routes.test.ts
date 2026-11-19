// Jornada HTTP de tabelas: borda autenticada, revisões, compartilhamento, tamanhos e limites por sessão.
import { randomUUID } from 'node:crypto';
import type { DataTable, TableRecord } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BODY_LIMIT_BYTES } from './app';
import { createTestApi, ORIGIN, type TestApi } from './testing/harness';

let api: TestApi;
let session: { cookie: string; csrfToken: string };
const missing = '00000000-0000-4000-8000-000000000000';
beforeAll(async () => { api = await createTestApi(); session = await api.login(); });
afterAll(async () => { await api?.cleanup(); });
/** Dono pela sessão real; overrides exercitam as recusas dos hooks centrais. */
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) => api.app.inject({ method, url, payload: payload as object | undefined, headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrfToken, ...headers } });

describe('tables API', () => {
  it('cria colunas com IDs gerados, recusa IDs externos na borda e preserva identidade no replay e na atualização', async () => {
    const bot = (await call('POST', '/api/bots', { name: 'Contrato de criação', color: '#60A5FA' })).json<{ id: string }>();
    const input = { operationId: randomUUID(), name: 'IDs do servidor', columns: [{ name: 'Título', type: 'text' }] };
    const url = `/api/bots/${bot.id}/tables`;
    const before = (await api.pool.query('SELECT count(*)::int AS count FROM data_tables')).rows[0]!.count;
    const invalid = await call('POST', url, { ...input, columns: [{ ...input.columns[0], id: randomUUID() }] });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ field: 'columns.0', reason: 'Campo não permitido.' }] });
    expect((await api.pool.query('SELECT count(*)::int AS count FROM data_tables')).rows[0]!.count).toBe(before);
    const created = await call('POST', url, input);
    expect(created.statusCode).toBe(201);
    const table = created.json<DataTable>();
    expect(table.columns[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call('POST', url, input)).json()).toEqual(table);
    const updated = await call('PATCH', `/api/tables/${table.id}`, { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, columns: [{ ...table.columns[0], name: 'Renomeado' }] });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<DataTable>().columns[0]).toEqual({ ...table.columns[0], name: 'Renomeado' });
    expect((await api.pool.query('SELECT count(*)::int AS count FROM data_tables')).rows[0]!.count).toBe(before + 1);
  });
  it('o dono abre e edita registro maior que 64 KiB sem ampliar lookup/consulta nem permitir IDs cruzados', async () => {
    const bot = (await call('POST', '/api/bots', { name: 'Registro completo HTTP', color: '#60A5FA' })).json<{ id: string }>();
    const table = (await call('POST', `/api/bots/${bot.id}/tables`, { operationId: randomUUID(), name: 'Registro extenso', columns: [
      { name: 'Primeiro', type: 'text' }, { name: 'Segundo', type: 'text' }, { name: 'Terceiro', type: 'text' },
      { name: 'Calculado', type: 'calculated', resultType: 'number', formula: { kind: 'literal', type: 'number', value: '7' } },
    ] })).json<DataTable>();
    const values = Object.fromEntries(table.columns.slice(0, 3).map((column) => [column.id, '漢'.repeat(8000)]));
    const written = (await call('POST', `/api/tables/${table.id}/records`, { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values }] })).json<{ records: TableRecord[] }>();
    const path = `/api/tables/${table.id}/records/${written.records[0]!.id}`;
    expect((await call('GET', path, undefined, { cookie: '' })).statusCode).toBe(401);
    expect((await call('GET', `/api/tables/${table.id}/records/invalid`)).statusCode).toBe(422);
    expect((await call('GET', `/api/tables/invalid/records/${written.records[0]!.id}`)).statusCode).toBe(422);
    expect((await call('GET', `/api/tables/${missing}/records/${written.records[0]!.id}`)).statusCode).toBe(404);
    const foreign = (await call('POST', `/api/bots/${bot.id}/tables`, { operationId: randomUUID(), name: 'Outra tabela' })).json<DataTable>();
    expect((await call('GET', `/api/tables/${foreign.id}/records/${written.records[0]!.id}`)).statusCode).toBe(404);
    const full = await call('GET', path);
    expect(full.statusCode).toBe(200); expect(Buffer.byteLength(full.body, 'utf8')).toBeGreaterThan(64 * 1024);
    expect(full.json<TableRecord>()).toEqual({ id: written.records[0]!.id, version: 1, values: { ...values, [table.columns[3]!.id]: '7' } });
    expect((await call('POST', `/api/tables/${table.id}/query`, {})).json()).toMatchObject({ code: 'TABLE_QUERY_LIMIT' });
    expect((await call('POST', `/api/tables/${table.id}/records/lookup`, { ids: [written.records[0]!.id] })).json()).toMatchObject({ code: 'TABLE_QUERY_LIMIT' });
    const projected = await call('POST', `/api/tables/${table.id}/query`, { columns: [table.columns[0]!.id] });
    expect(projected.statusCode).toBe(200); expect(projected.json<{ records: TableRecord[] }>().records[0]!.values).toEqual({ [table.columns[0]!.id]: values[table.columns[0]!.id] });
    const patch = { [table.columns[0]!.id]: 'Editado pelo dono' };
    expect((await call('POST', `/api/tables/${table.id}/records`, { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, updates: [{ id: written.records[0]!.id, expectedVersion: 1, values: patch }] })).statusCode).toBe(200);
    expect((await call('GET', path)).json<TableRecord>()).toEqual({ id: written.records[0]!.id, version: 2, values: { ...values, ...patch, [table.columns[3]!.id]: '7' } });
  });
  it('dependências têm contrato estrito, sessão/CSRF e página de metadados, sem criar preparação', async () => {
    const local = await api.login('203.0.113.27');
    const headers = { cookie: local.cookie, origin: ORIGIN, 'x-csrf-token': local.csrfToken };
    const bot = (await api.app.inject({ method: 'POST', url: '/api/bots', headers, payload: { name: 'Impedimentos HTTP', color: '#60A5FA' } })).json<{ id: string }>();
    const target = (await api.app.inject({ method: 'POST', url: `/api/bots/${bot.id}/tables`, headers, payload: { name: 'Destino HTTP', operationId: randomUUID() } })).json<{ id: string; version: number }>();
    const source = (await api.app.inject({ method: 'POST', url: `/api/bots/${bot.id}/tables`, headers, payload: { name: 'Origem HTTP', operationId: randomUUID(), columns: [{ name: 'Destino', type: 'relation', targetTableId: target.id, cardinality: 'one' }] } })).json<{ id: string }>();
    const payload = { operation: { kind: 'delete_table', expectedVersion: target.version }, limit: 1 };
    const result = await api.app.inject({ method: 'POST', url: `/api/tables/${target.id}/dependencies`, headers, payload });
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ dependencies: [{ kind: 'relation', tableId: source.id, tableName: 'Origem HTTP', name: 'Destino' }], nextCursor: null });
    expect(Buffer.byteLength(result.body, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect((await api.app.inject({ method: 'POST', url: `/api/tables/${target.id}/dependencies`, headers, payload: { ...payload, grantAccess: true } })).statusCode).toBe(422);
    expect((await api.app.inject({ method: 'POST', url: `/api/tables/${target.id}/dependencies`, headers, payload: { ...payload, limit: 101 } })).statusCode).toBe(422);
    expect((await api.pool.query('SELECT 1 FROM table_operation_preparations WHERE table_id = $1', [target.id])).rowCount).toBe(0);
  });
  it('lookup autentica, projeta e limita IDs da mesma tabela', async () => {
    const local = await api.login('203.0.113.17');
    const headers = { cookie: local.cookie, origin: ORIGIN, 'x-csrf-token': local.csrfToken };
    /** Sessão própria isola a jornada das cotas verificadas pelos demais testes. */
    const request = (url: string, payload: object) => api.app.inject({ method: 'POST', url, payload, headers });
    const bot = (await request('/api/bots', { name: 'Lookup', color: '#60A5FA' })).json<{ id: string }>();
    const table = (await request(`/api/bots/${bot.id}/tables`, { operationId: randomUUID(), name: 'Lookup', columns: [{ name: 'Nome', type: 'text' }, { name: 'Privado', type: 'boolean' }] })).json<{ id: string; columns: { id: string }[] }>();
    const written = (await request(`/api/tables/${table.id}/records`, { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [{ values: { [table.columns[0]!.id]: 'Cliente nomeado', [table.columns[1]!.id]: false } }] })).json<{ records: { id: string }[] }>();
    const result = await request(`/api/tables/${table.id}/records/lookup`, { ids: [written.records[0]!.id, randomUUID()], columns: [table.columns[0]!.id] });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ totalCount: 1, records: [{ values: { [table.columns[0]!.id]: 'Cliente nomeado' } }] });
    expect(Object.keys(result.json<{ records: { values: object }[] }>().records[0]!.values)).toEqual([table.columns[0]!.id]);
    expect((await request(`/api/tables/${table.id}/records/lookup`, { ids: Array.from({ length: 101 }, () => randomUUID()) })).statusCode).toBe(422);
    expect((await request(`/api/tables/${table.id}/records/lookup`, { ids: [written.records[0]!.id], sql: 'SELECT *' })).statusCode).toBe(422);
  });
  it('exige sessão e CSRF em toda a nova árvore e recusa mass assignment', async () => {
    const routes = [
      ['GET', '/api/tables'], ['GET', `/api/tables/${missing}`], ['GET', `/api/tables/${missing}/records`], ['GET', `/api/bots/${missing}/tables`],
      ['POST', `/api/bots/${missing}/tables`], ['PATCH', `/api/tables/${missing}`], ['POST', `/api/tables/${missing}/records`], ['PUT', `/api/tables/${missing}/access`],
      ['POST', `/api/tables/${missing}/query`], ['POST', `/api/tables/${missing}/records/lookup`], ['POST', `/api/tables/${missing}/formula-preview`], ['GET', `/api/tables/${missing}/views`],
      ['POST', `/api/tables/${missing}/views`], ['PUT', `/api/tables/${missing}/views/${missing}`], ['DELETE', `/api/tables/${missing}/views/${missing}`],
      ['POST', `/api/tables/${missing}/dependencies`],
    ] as const;
    for (const [method, url] of routes) {
      expect((await call(method, url, undefined, { cookie: '' })).statusCode).toBe(401);
      if (method !== 'GET') {
        expect((await call(method, url, undefined, { 'x-csrf-token': '' })).statusCode).toBe(403);
        expect((await call(method, url, undefined, { origin: 'https://evil.test' })).json()).toMatchObject({ code: 'CSRF_ORIGIN_INVALID' });
      }
    }
    const invalid = await call('POST', `/api/bots/${missing}/tables`, { name: 'Forjada', botId: missing, operationId: randomUUID() });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await call('GET', `/api/tables/${missing}`)).json()).toMatchObject({ code: 'TABLE_NOT_FOUND' });
    expect((await call('DELETE', `/api/tables/${missing}`)).statusCode).toBe(404);
  });

  it('consulta vista e resultado calculado com o mesmo contrato estrito de preview e revisões', async () => {
    const bot = (await call('POST', '/api/bots', { name: 'Fórmula API', color: '#60A5FA' })).json<{ id: string }>();
    const table = (await call('POST', `/api/bots/${bot.id}/tables`, { operationId: randomUUID(), name: 'Fórmula API', columns: [{ name: 'Número', type: 'number' }] })).json<{ id: string; columns: { id: string; name: string; type: string }[] }>();
    const id = table.columns[0]!.id;
    const formula = { kind: 'call', op: 'ADD', args: [{ kind: 'ref', columnId: id }, { kind: 'literal', type: 'number', value: '0.2' }] };
    const preview = await call('POST', `/api/tables/${table.id}/formula-preview`, { formula, resultType: 'number', values: { [id]: '0.1' } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ value: '0.3' });
    const configured = await call('PATCH', `/api/tables/${table.id}`, { operationId: randomUUID(), expectedSchemaVersion: 1, columns: [...table.columns, { name: 'Calculado', type: 'calculated', resultType: 'number', formula }] });
    expect(configured.statusCode).toBe(200);
    const calculated = configured.json<{ columns: { id: string }[] }>().columns[1]!.id;
    const cyclic = await call('POST', `/api/tables/${table.id}/formula-preview`, { columnId: calculated, formula: { kind: 'ref', columnId: calculated }, resultType: 'number' });
    expect(cyclic.json()).toMatchObject({ code: 'TABLE_INVALID_FORMULA' });
    expect((await call('POST', `/api/tables/${table.id}/formula-preview`, { columnId: randomUUID(), formula, resultType: 'number' })).json()).toMatchObject({ code: 'TABLE_INVALID_SCHEMA' });
    expect((await call('POST', `/api/tables/${table.id}/formula-preview`, { columnId: id, formula: { kind: 'literal', type: 'number', value: '3' }, resultType: 'number' })).json()).toEqual({ value: '3' });
    expect((await call('POST', `/api/tables/${table.id}/formula-preview`, { columnId: id, formula: { kind: 'ref', columnId: id }, resultType: 'number' })).json()).toMatchObject({ code: 'TABLE_INVALID_FORMULA' });
    const otherTable = (await call('POST', `/api/bots/${bot.id}/tables`, { operationId: randomUUID(), name: 'Outra prévia', columns: [{ name: 'Privada', type: 'number' }] })).json<{ columns: { id: string }[] }>();
    expect((await call('POST', `/api/tables/${table.id}/formula-preview`, { columnId: otherTable.columns[0]!.id, formula: { kind: 'literal', type: 'number', value: '0' }, resultType: 'number' })).json()).toMatchObject({ code: 'TABLE_INVALID_SCHEMA' });
    const before = (await call('GET', `/api/tables/${table.id}`)).json<{ columns: object[] }>();
    const indirect = await call('PATCH', `/api/tables/${table.id}`, { operationId: randomUUID(), expectedSchemaVersion: 2, columns: [...before.columns, { name: 'Dependente', type: 'calculated', resultType: 'number', formula: { kind: 'ref', columnId: calculated } }] });
    expect(indirect.statusCode).toBe(200);
    const dependent = indirect.json<{ columns: { id: string }[] }>().columns[2]!.id;
    const snapshot = (await call('GET', `/api/tables/${table.id}`)).json();
    expect((await call('POST', `/api/tables/${table.id}/formula-preview`, { columnId: calculated, formula: { kind: 'ref', columnId: dependent }, resultType: 'number' })).json()).toMatchObject({ code: 'TABLE_INVALID_FORMULA' });
    expect((await call('GET', `/api/tables/${table.id}`)).json()).toEqual(snapshot);
    expect((await call('POST', `/api/tables/${table.id}/records`, { operationId: randomUUID(), expectedSchemaVersion: 3, creates: [{ values: { [id]: '0.1' } }] })).statusCode).toBe(200);
    const viewResponse = await call('POST', `/api/tables/${table.id}/views`, { operationId: randomUUID(), name: 'Calculada', columns: [calculated], filter: { op: 'eq', columnId: calculated, value: '0.3' } });
    expect(viewResponse.statusCode).toBe(201);
    const view = viewResponse.json<{ id: string }>();
    const queried = await call('POST', `/api/tables/${table.id}/query`, { viewId: view.id, aggregate: [{ alias: 'Total', op: 'sum', columnId: calculated }] });
    expect(queried.statusCode).toBe(200);
    expect(queried.json()).toMatchObject({ records: [{ values: { [calculated]: '0.3' } }], aggregate: { Total: '0.3' }, hasMore: false });
    expect((await call('POST', `/api/tables/${table.id}/query`, { sql: 'SELECT * FROM bots' })).json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await call('PUT', `/api/tables/${table.id}/views/${view.id}`, { operationId: randomUUID(), name: 'Editada', expectedVersion: 99 })).json()).toMatchObject({ code: 'TABLE_CONFLICT' });
    expect((await call('DELETE', `/api/tables/${table.id}/views/${view.id}`, { operationId: randomUUID(), expectedVersion: 1 })).statusCode).toBe(200);
    expect((await call('GET', `/api/tables/${table.id}/records`)).json<{ records: unknown[] }>().records).toHaveLength(1);
  });

  it('cria e consulta tabela real, compartilha e preserva dados após excluir os bots', async () => {
    const a = (await call('POST', '/api/bots', { name: 'Tabela API A', color: '#60A5FA' })).json<{ id: string }>();
    const b = (await call('POST', '/api/bots', { name: 'Tabela API B', color: '#60A5FA' })).json<{ id: string }>();
    const create = { operationId: randomUUID(), name: 'Tabela API privada', columns: [{ name: 'Título', type: 'text' }, { name: 'Valor', type: 'money', currency: 'BRL' }] };
    const created = await call('POST', `/api/bots/${a.id}/tables`, create);
    expect(created.statusCode).toBe(201);
    const table = created.json<{ id: string; columns: { id: string }[]; version: number }>();
    expect((await call('POST', `/api/bots/${a.id}/tables`, create)).json()).toEqual(created.json());
    const values = { [table.columns[0]!.id]: 'Célula privada', [table.columns[1]!.id]: '0.1' };
    const write = { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [{ values, deduplicationKey: 'teste' }] };
    expect((await call('POST', `/api/tables/${table.id}/records`, write)).statusCode).toBe(200);
    const records = (await call('GET', `/api/tables/${table.id}/records`)).json<{ records: { values: unknown }[] }>();
    expect(records.records[0]!.values).toEqual(values);
    expect((await call('PUT', `/api/tables/${table.id}/access`, { operationId: randomUUID(), expectedVersion: 1, botIds: [a.id, b.id] })).json()).toMatchObject({ code: 'TABLE_CONFLICT' });
    expect((await call('PUT', `/api/tables/${table.id}/access`, { operationId: randomUUID(), expectedVersion: 2, botIds: [a.id, b.id] })).statusCode).toBe(200);
    expect((await call('GET', `/api/bots/${b.id}/tables`)).json()).toMatchObject({ tables: [{ id: table.id }] });
    for (const [id, name] of [[a.id, 'Tabela API A'], [b.id, 'Tabela API B']]) {
      expect((await call('POST', `/api/bots/${id}/archive`)).statusCode).toBe(200);
      expect((await call('DELETE', `/api/bots/${id}`, { confirmName: name })).statusCode).toBe(204);
    }
    expect((await call('GET', `/api/tables/${table.id}`)).json()).toMatchObject({ botIds: [] });
    expect((await call('GET', `/api/tables/${table.id}/records`)).json()).toEqual(records);
    expect((await call('GET', '/api/tables')).headers['cache-control']).toBe('no-store');
    expect(api.logs.join('')).not.toContain('Célula privada');
  });

  it('aceita lote maior que 256 KiB somente nas novas rotas e recusa acima de 1 MiB ou JSON malformado', async () => {
    const bot = (await call('POST', '/api/bots', { name: 'Lote HTTP', color: '#60A5FA' })).json<{ id: string }>();
    const table = (await call('POST', `/api/bots/${bot.id}/tables`, { operationId: randomUUID(), name: 'Lote', columns: [{ name: 'Texto', type: 'text' }, { name: 'Outro', type: 'text' }] })).json<{ id: string; columns: { id: string }[] }>();
    const batch = { operationId: randomUUID(), expectedSchemaVersion: 1, creates: Array.from({ length: 40 }, () => ({ values: { [table.columns[0]!.id]: 'x'.repeat(8000) } })) };
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeGreaterThan(BODY_LIMIT_BYTES);
    expect((await call('POST', `/api/tables/${table.id}/records`, batch)).statusCode).toBe(200);
    const oversized = { ...batch, creates: Array.from({ length: 100 }, () => ({ values: { [table.columns[0]!.id]: 'x'.repeat(8000), [table.columns[1]!.id]: 'x'.repeat(8000) } })) };
    expect((await call('POST', `/api/tables/${table.id}/records`, oversized)).json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect((await call('POST', '/api/bots', { name: 'x'.repeat(BODY_LIMIT_BYTES) })).statusCode).toBe(413);
    expect((await call('POST', `/api/tables/${table.id}/records`, '{broken', { 'content-type': 'application/json' })).json()).toMatchObject({ code: 'BAD_REQUEST' });
    expect((await call('GET', `/api/tables/${table.id}/records`)).json<{ records: unknown[] }>().records).toHaveLength(40);
  });

  it('confirmação direta exige preparação concreta, CSRF/revisão e recusa proof forjado', async () => {
    const bot = (await call('POST', '/api/bots', { name: 'Destrutiva API', color: '#60A5FA' })).json<{ id: string }>();
    const table = (await call('POST', `/api/bots/${bot.id}/tables`, { operationId: randomUUID(), name: 'Excluir API' })).json<{ id: string; version: number; schemaVersion: number }>();
    const preparePath = `/api/tables/${table.id}/operations/prepare`;
    const confirmPath = `/api/tables/${table.id}/operations/confirm`;
    const operation = { kind: 'delete_table', expectedVersion: table.version };
    expect((await call('POST', preparePath, operation, { cookie: '' })).statusCode).toBe(401);
    expect((await call('POST', preparePath, operation, { 'x-csrf-token': '' })).statusCode).toBe(403);
    const prep = (await call('POST', preparePath, operation)).json<{ preparationId: string; impact: { tableId: string; recordCount: number } }>();
    expect(prep.impact).toMatchObject({ tableId: table.id, recordCount: 0 });
    const input = { preparationId: prep.preparationId, operationId: randomUUID(), confirmation: true };
    expect((await call('POST', confirmPath, { ...input, confirmation: false })).statusCode).toBe(422);
    expect((await call('POST', confirmPath, { ...input, proof: { action: 'aion_table_delete' } })).statusCode).toBe(422);
    expect((await call('POST', `/api/tables/${table.id}/records`, { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: {} }] })).statusCode).toBe(200);
    expect((await call('POST', confirmPath, input)).json()).toMatchObject({ code: 'TABLE_CONFLICT' });
    const current = (await call('GET', `/api/tables/${table.id}`)).json<{ version: number }>();
    const fresh = (await call('POST', preparePath, { ...operation, expectedVersion: current.version })).json<{ preparationId: string; impact: { recordCount: number } }>();
    expect(fresh.impact.recordCount).toBe(1);
    const confirmed = { ...input, preparationId: fresh.preparationId };
    expect((await call('POST', confirmPath, confirmed)).json()).toMatchObject({ removed: true, kind: 'delete_table' });
    expect((await call('POST', confirmPath, confirmed)).json()).toMatchObject({ code: 'TABLE_RESOURCE_REMOVED' });
    expect((await call('GET', `/api/tables/${table.id}`)).statusCode).toBe(404);
  });

  it('limita leituras e gravações por sessão, sinaliza espera e mantém outras sessões independentes', async () => {
    const other = await api.login('203.0.113.15');
    const headers = { cookie: other.cookie, origin: ORIGIN, 'x-csrf-token': other.csrfToken };
    for (let i = 0; i < 120; i++) expect((await api.app.inject({ method: 'GET', url: '/api/tables', headers })).statusCode).toBe(200);
    const denied = await api.app.inject({ method: 'GET', url: '/api/tables', headers });
    expect(denied.statusCode).toBe(429);
    expect(denied.headers['retry-after']).toBeDefined();
    for (let i = 0; i < 60; i++) expect((await api.app.inject({ method: 'PATCH', url: `/api/tables/${missing}`, headers, payload: { operationId: randomUUID(), expectedSchemaVersion: 1 } })).statusCode).toBe(404);
    expect((await api.app.inject({ method: 'PATCH', url: `/api/tables/${missing}`, headers, payload: { operationId: randomUUID(), expectedSchemaVersion: 1 } })).statusCode).toBe(429);
    const fresh = await api.login('203.0.113.16');
    expect((await call('GET', '/api/tables', undefined, { cookie: fresh.cookie })).statusCode).toBe(200);
  });
  it('POST de consulta/prévia/lookup compartilha 120 leituras e confirmação tem teto adicional de cinco', async () => {
    const local = await api.login('203.0.113.18');
    const headers = { cookie: local.cookie, origin: ORIGIN, 'x-csrf-token': local.csrfToken };
    const paths = ['query', 'formula-preview', 'records/lookup'];
    const bodies = [{}, { formula: { kind: 'literal', type: 'number', value: '0' }, resultType: 'number' }, { ids: [missing] }];
    for (let i = 0; i < 120; i++) expect((await api.app.inject({ method: 'POST', url: `/api/tables/${missing}/${paths[i % 3]}`, headers, payload: bodies[i % 3] })).statusCode).toBe(404);
    expect((await api.app.inject({ method: 'GET', url: '/api/tables', headers })).statusCode).toBe(429);
    // A cota de leitura esgotada não consome as 60 mutações desta mesma sessão.
    for (let i = 0; i < 60; i++) expect((await api.app.inject({ method: 'PATCH', url: `/api/tables/${missing}`, headers, payload: { operationId: randomUUID(), expectedSchemaVersion: 1 } })).statusCode).toBe(404);
    expect((await api.app.inject({ method: 'PATCH', url: `/api/tables/${missing}`, headers, payload: { operationId: randomUUID(), expectedSchemaVersion: 1 } })).statusCode).toBe(429);
    const own = await api.login('203.0.113.19');
    const confirmationHeaders = { cookie: own.cookie, origin: ORIGIN, 'x-csrf-token': own.csrfToken };
    const payload = { preparationId: randomUUID(), operationId: randomUUID(), confirmation: true };
    for (let i = 0; i < 5; i++) expect((await api.app.inject({ method: 'POST', url: `/api/tables/${missing}/operations/confirm`, headers: confirmationHeaders, payload })).statusCode).toBe(404);
    const denied = await api.app.inject({ method: 'POST', url: `/api/tables/${missing}/operations/confirm`, headers: confirmationHeaders, payload });
    expect(denied.statusCode).toBe(429); expect(denied.headers['retry-after']).toBeDefined();
    expect((await api.app.inject({ method: 'GET', url: '/api/tables', headers: confirmationHeaders })).statusCode).toBe(200);
  });
});
