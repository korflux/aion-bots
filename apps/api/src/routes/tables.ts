// API do dono para tabelas. Bot da URL só escolhe associação na criação/listagem;
// não altera o ator autenticado e nunca representa identidade de ferramenta.
import { KeyedSlidingWindowLimiter, type TableService } from '@aion/core';
import { tableDependenciesRequestSchema, tableDestructiveSchema, tableConfirmSchema, tableRecordLookupSchema, TABLE_BODY_LIMIT, botTableParamsSchema, tableCreateSchema, tablePageSchema, tableParamsSchema, tableRecordParamsSchema, tableShareSchema, tableUpdateSchema, tableWriteSchema, tableQuerySchema, tableFormulaPreviewSchema, tableViewCreateSchema, tableViewUpdateSchema, tableViewRemoveSchema, tableViewParamsSchema } from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';


/** Sessão/Origin/CSRF e envelopes são herdados dos hooks centrais, inclusive nesta árvore. */
export const tableRoutes: FastifyPluginAsyncZod<{ tables: TableService }> = async (app, { tables }) => {
  const reads = new KeyedSlidingWindowLimiter({ max: 120, windowMs: 60_000 });
  const writes = new KeyedSlidingWindowLimiter({ max: 60, windowMs: 60_000 });
  const destructive = new KeyedSlidingWindowLimiter({ max: 5, windowMs: 60_000 });
  // Instância de limitador por plugin, reaproveitada para todas as rotas; segue a limitação por processo já documentada no helper.
  app.addHook('onRequest', async (request) => {
    const category = request.routeOptions.config.tableRate ?? (request.method === 'GET' ? 'read' : 'write');
    if (category === 'destructive') destructive.consume(request.auth!.sessionId);
    (category === 'read' ? reads : writes).consume(request.auth!.sessionId);
  });
  app.get('/tables', { schema: { querystring: tablePageSchema } }, async (request) => tables.list({ kind: 'owner' }, request.query));
  app.get('/bots/:botId/tables', { schema: { params: botTableParamsSchema, querystring: tablePageSchema } }, async (request) => tables.list({ kind: 'owner' }, request.query, request.params.botId));
  app.get('/tables/:tableId', { schema: { params: tableParamsSchema } }, async (request) => tables.get(request.params.tableId, { kind: 'owner' }));
  app.get('/tables/:tableId/records', { schema: { params: tableParamsSchema, querystring: tablePageSchema } }, async (request) => tables.records(request.params.tableId, { kind: 'owner' }, request.query));
  // Leitura integral de um registro para edição do dono; nunca amplia o contrato limitado de query/lookup/ferramentas.
  app.get('/tables/:tableId/records/:recordId', { schema: { params: tableRecordParamsSchema } }, async (request) => tables.readRecord(request.params.tableId, request.params.recordId, { kind: 'owner' }));
  app.post('/tables/:tableId/records/lookup', { config: { tableRate: 'read' }, bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableParamsSchema, body: tableRecordLookupSchema } }, async (request) => tables.lookupRecords(request.params.tableId, request.body, { kind: 'owner' }));
  app.post('/bots/:botId/tables', { bodyLimit: TABLE_BODY_LIMIT, schema: { params: botTableParamsSchema, body: tableCreateSchema } }, async (request, reply) => {
    const result = await tables.create(request.body, { kind: 'owner' }, request.params.botId, originOf(request));
    return reply.status(201).send(result);
  });
  app.patch('/tables/:tableId', { bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableParamsSchema, body: tableUpdateSchema } }, async (request) => tables.update(request.params.tableId, request.body, { kind: 'owner' }, originOf(request)));
  app.post('/tables/:tableId/records', { bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableParamsSchema, body: tableWriteSchema } }, async (request) => tables.write(request.params.tableId, request.body, { kind: 'owner' }, originOf(request)));
  app.put('/tables/:tableId/access', { bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableParamsSchema, body: tableShareSchema } }, async (request) => tables.share(request.params.tableId, request.body, { kind: 'owner' }, originOf(request)));
  // Prévia/consulta usam POST pela entrada estruturada e continuam exigindo Origin/CSRF na borda.
  app.post('/tables/:tableId/query', { config: { tableRate: 'read' }, bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableParamsSchema, body: tableQuerySchema } }, async (request) => tables.query(request.params.tableId, request.body, { kind: 'owner' }));
  app.post('/tables/:tableId/formula-preview', { config: { tableRate: 'read' }, bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableParamsSchema, body: tableFormulaPreviewSchema } }, async (request) => tables.previewFormula(request.params.tableId, request.body, { kind: 'owner' }));
  app.get('/tables/:tableId/views', { schema: { params: tableParamsSchema } }, async (request) => tables.views(request.params.tableId, { kind: 'owner' }));
  app.post('/tables/:tableId/views', { bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableParamsSchema, body: tableViewCreateSchema } }, async (request, reply) => reply.status(201).send(await tables.saveView(request.params.tableId, request.body, { kind: 'owner' }, undefined, originOf(request))));
  app.put('/tables/:tableId/views/:viewId', { bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableViewParamsSchema, body: tableViewUpdateSchema } }, async (request) => tables.saveView(request.params.tableId, request.body, { kind: 'owner' }, request.params.viewId, originOf(request)));
  app.delete('/tables/:tableId/views/:viewId', { bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableViewParamsSchema, body: tableViewRemoveSchema } }, async (request) => tables.removeView(request.params.tableId, request.params.viewId, request.body, { kind: 'owner' }, originOf(request)));
  // Confirmação concreta do dono, com a mesma revisão/dependências do caminho do agente.
  app.post('/tables/:tableId/dependencies', { config: { tableRate: 'read' }, bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableParamsSchema, body: tableDependenciesRequestSchema } }, async (request) => tables.dependencies(request.params.tableId, request.body, { kind: 'owner' }));
  app.post('/tables/:tableId/operations/prepare', { bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableParamsSchema, body: tableDestructiveSchema } }, async (request) => tables.prepareDestructive(request.params.tableId, request.body, { kind: 'owner' }));
  app.post('/tables/:tableId/operations/confirm', { config: { tableRate: 'destructive' }, bodyLimit: TABLE_BODY_LIMIT, schema: { params: tableParamsSchema, body: tableConfirmSchema } }, async (request) => tables.confirmDestructive(request.params.tableId, request.body, { kind: 'owner' }, undefined, originOf(request)));
};
