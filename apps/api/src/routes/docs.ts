// API do dono para docs em Markdown (phase 14, passo 3a; DOC-01 a DOC-03, A8, A15, A26). Casca fina sobre `DocService` (core): a regra (limites de 100.000 caracteres e 100 docs,
// versões imutáveis, conflito por versão esperada, restauração como versão nova, acesso por bot, recibo idempotente por operação, auditoria) vive no serviço, e o formato dos dados
// (campos permitidos, tamanhos, `operationId` obrigatório em toda escrita) nos schemas de `@aion/shared` (`docs.ts`). Esta rota só autentica, limita e traduz HTTP.
//
// Quem chama: SOMENTE o dono, com o ator `{ kind: 'owner' }` fixo aqui. O bot nunca passa por esta API (a ferramenta `doc_*` roda no worker com o bot da execução), então nada do corpo,
// da URL ou da consulta escolhe o ator; o `botId` da listagem só filtra. O dono vê e altera todos os docs, compartilha e exclui sem aprovação (a tela confirma).
//
// Segurança (spec decisão 16, A26), na ordem em que valem:
//   1. Sessão, Origin e CSRF vêm dos hooks centrais (`plugins/security.ts`), herdados por esta árvore: nenhuma rota é pública e a recusa acontece antes de qualquer limite ou gravação.
//   2. Rate limit por SESSÃO (como `/api/tables`): leitura 120/min, escrita 60/min e exclusão 5/min (a exclusão consome também a cota de escrita). A cota conta a requisição ao entrar,
//      mesmo a que será recusada na validação, e responde `RATE_LIMITED` com `Retry-After`. Limitação por processo, a mesma do helper (ponytail em `credentials/rate-limit.ts`).
//   3. Corpo: o limite global da API é 256 KiB e recusaria um texto válido de 100.000 caracteres não ASCII; criar e editar usam `DOC_BODY_LIMIT` (comporta o pior caso de UTF-8 e de escape
//      JSON), e as demais escritas, que só levam números, UUIDs e uma lista de bots, usam um teto curto. Acima, `PAYLOAD_TOO_LARGE` no envelope padrão.
//   4. Allowlist: todo schema de entrada é estrito (`z.strictObject`): campo fora do contrato é `VALIDATION_FAILED` com o motivo "Campo não permitido.", nunca ecoa o valor enviado e
//      nada chega ao serviço. Os parâmetros de URL e a consulta passam pela mesma allowlist.
//   5. Resposta: cada rota declara o schema da resposta de sucesso, que descarta qualquer campo a mais que um serviço futuro devolva por engano.
// Erros de domínio (`DOC_*`, `BOT_NOT_FOUND`) viram o envelope `{ code, message }` no handler central; aqui nenhum erro é tratado.
//
// Idempotência: a repetição de uma escrita com a mesma `operationId` devolve o resultado gravado, e a criação responde 201 também na repetição (o status é da rota, o serviço não
// distingue a primeira chamada da repetida). O DELETE leva `{ operationId }` no corpo JSON, como o DELETE de bot e o de vista de tabela, e herda a mesma dependência de o proxy do
// Easypanel repassar o corpo (limitação já registrada no backlog para o DELETE de bot; trocar o verbo para POST se o proxy o descartar).
import { KeyedSlidingWindowLimiter, type DocService } from '@aion/core';
import {
  DOC_BODY_LIMIT,
  docCreateRequestSchema,
  docDeleteResultSchema,
  docDeleteSchema,
  docListQuerySchema,
  docListSchema,
  docParamsSchema,
  docRestoreSchema,
  docSchema,
  docShareSchema,
  docSummarySchema,
  docUpdateSchema,
  docVersionDetailSchema,
  docVersionListSchema,
  docVersionParamsSchema,
  docWriteResultSchema,
} from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';

export interface DocRoutesOptions {
  docs: DocService;
}

/** Corpo das escritas que não carregam texto (restaurar, compartilhar com até 100 bots, excluir): bem acima do maior corpo válido (cerca de 5 KiB) e muito abaixo do limite de texto. */
const SMALL_BODY_LIMIT = 16 * 1024;
/** O dono é o único ator desta API; o bot só chega aos docs pelas ferramentas, com o ator montado a partir da execução. */
const OWNER = { kind: 'owner' } as const;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const docRoutes: FastifyPluginAsyncZod<DocRoutesOptions> = async (app, { docs }) => {
  // Uma instância de cada limitador por plugin, compartilhada por todas as rotas e com chave por sessão (o hook central já exigiu sessão, então `auth` existe).
  const reads = new KeyedSlidingWindowLimiter({ max: 120, windowMs: 60_000 });
  const writes = new KeyedSlidingWindowLimiter({ max: 60, windowMs: 60_000 });
  const deletions = new KeyedSlidingWindowLimiter({ max: 5, windowMs: 60_000 });
  app.addHook('onRequest', async (request) => {
    const sessionId = request.auth!.sessionId;
    if (request.method === 'DELETE') deletions.consume(sessionId);
    (MUTATING_METHODS.has(request.method) ? writes : reads).consume(sessionId);
  });

  // ---- Leitura (instantâneo único no serviço) ----
  // Lista sem o texto, do mais recente ao mais antigo, com `botId` opcional para filtrar pelos docs compartilhados com aquele bot (bot inexistente é `BOT_NOT_FOUND`).
  app.get('/docs', { schema: { querystring: docListQuerySchema, response: { 200: docListSchema } } }, async (request) => docs.list(OWNER, request.query));
  app.get('/docs/:docId', { schema: { params: docParamsSchema, response: { 200: docSchema } } }, async (request) => docs.get(request.params.docId, OWNER));
  app.get('/docs/:docId/versions', { schema: { params: docParamsSchema, response: { 200: docVersionListSchema } } }, async (request) => docs.listVersions(request.params.docId, OWNER));
  app.get('/docs/:docId/versions/:version', { schema: { params: docVersionParamsSchema, response: { 200: docVersionDetailSchema } } }, async (request) =>
    docs.getVersion(request.params.docId, request.params.version, OWNER),
  );

  // ---- Escrita (uma trava de banco no serviço, recibo por `operationId`) ----
  // Criar: o dono escolhe os bots (nenhum é permitido, como "Sem bot" nas tabelas); a versão 1 nasce junto. 201 também na repetição da mesma operação.
  app.post('/docs', { bodyLimit: DOC_BODY_LIMIT, schema: { body: docCreateRequestSchema, response: { 201: docSummarySchema } } }, async (request, reply) =>
    reply.status(201).send(await docs.create(request.body, OWNER, originOf(request))),
  );
  // Editar o texto (acrescentar, substituir trecho exato ou reescrever) e/ou renomear, sempre com a versão esperada; versão antiga é `DOC_CONFLICT` e nada é gravado.
  app.patch('/docs/:docId', { bodyLimit: DOC_BODY_LIMIT, schema: { params: docParamsSchema, body: docUpdateSchema, response: { 200: docWriteResultSchema } } }, async (request) =>
    docs.update(request.params.docId, request.body, OWNER, originOf(request)),
  );
  // Restaurar uma versão antiga COMO VERSÃO NOVA (as posteriores continuam no histórico).
  app.post('/docs/:docId/restore', { bodyLimit: SMALL_BODY_LIMIT, schema: { params: docParamsSchema, body: docRestoreSchema, response: { 200: docWriteResultSchema } } }, async (request) =>
    docs.restore(request.params.docId, request.body, OWNER, originOf(request)),
  );
  // Compartilhamento (só o dono): troca a lista COMPLETA de bots com acesso, conferida pela revisão de acesso que a tela leu.
  app.put('/docs/:docId/access', { bodyLimit: SMALL_BODY_LIMIT, schema: { params: docParamsSchema, body: docShareSchema, response: { 200: docSummarySchema } } }, async (request) =>
    docs.share(request.params.docId, request.body, OWNER, originOf(request)),
  );
  // Excluir (o dono não precisa de aprovação; a tela pede confirmação): apaga o doc, as versões e as associações, e o título sai dos recibos.
  app.delete('/docs/:docId', { bodyLimit: SMALL_BODY_LIMIT, schema: { params: docParamsSchema, body: docDeleteSchema, response: { 200: docDeleteResultSchema } } }, async (request) =>
    docs.delete(request.params.docId, request.body, OWNER, undefined, originOf(request)),
  );
};
