// Rotas da conversa (F6, F7; T6, e F16 na T12): as MESMAS rotas valem para a conversa do bot, sob /api/bots/:id, e para cada sessão do chat
// geral, sob /api/chat/sessions/:id; só muda quem é o dono da conversa (`ConversationRef`), então o registro roda uma vez por dono e nada
// do comportamento se duplica. Casca fina: as regras vivem em ConversationService (core) e o formato dos dados nos schemas de
// @aion/shared, aplicados pelo Fastify na borda.
//
// Segurança: nenhuma rota é pública, então o hook de segurança exige sessão válida e, nas que alteram estado, Origin e token
// CSRF. O id do dono (bot ou sessão) é um UUID validado antes de chegar ao serviço, que confere que ele existe (BOT_NOT_FOUND ou
// SESSION_NOT_FOUND), e o do run, uma string de dígitos; corpos são estritos (campos extras recusados) e o texto da mensagem é
// limitado em tamanho e sem caracteres de controle.
//
// O SSE (`/conversation/events`) é GET, então não exige CSRF, mas exige sessão: o navegador manda o cookie por padrão. Ele
// transmite "a linha X mudou" como o ESTADO ATUAL da linha, com o id do evento; a retomada por `Last-Event-ID` (enviado
// sozinho pelo navegador ao reconectar) ou por `?after=` (primeira conexão, vindo do snapshot) é idempotente. A conexão
// vive no máximo `maxLifetimeMs`: ao cair o navegador reconecta e a sessão é conferida de novo (uma sessão revogada não
// fica com um stream aberto para sempre). Quando a API fecha (deploy, SIGTERM), todos os streams abertos são encerrados: sem
// isso o `close()` do servidor esperaria cada conexão SSE (longa por natureza) terminar sozinha.
import { Readable } from 'node:stream';
import type { ConversationRef, ConversationService } from '@aion/core';
import {
  botIdParamsSchema,
  botRunParamsSchema,
  cancelComplementRequestSchema,
  continueRunRequestSchema,
  chooseVersionRequestSchema,
  conversationEventsQuerySchema,
  conversationPageQuerySchema,
  conversationPageSchema,
  conversationPreferenceRequestSchema,
  conversationSnapshotSchema,
  contextStateSchema,
  contextMaintenanceRequestSchema,
  contextMaintenanceParamsSchema,
  contextMaintenanceCancelSchema,
  draftParamsSchema,
  draftViewSchema,
  editMessageRequestSchema,
  modelChoiceSchema,
  runViewSchema,
  sendMessageRequestSchema,
  sendResultSchema,
  stopRunQuerySchema,
  versionRunRequestSchema,
} from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

export interface ConversationRoutesOptions {
  conversations: ConversationService;
  /** Testes encurtam os tempos do SSE. */
  sse?: Partial<typeof SSE_DEFAULTS>;
}

const SSE_DEFAULTS = {
  /** Intervalo da consulta de novidades no banco. */
  pollMs: 500,
  /** Silêncio máximo antes de um comentário de batimento (mantém a conexão aberta por proxies). */
  pingMs: 15_000,
  /** Duração máxima de uma conexão; o navegador reconecta sozinho. */
  maxLifetimeMs: 5 * 60_000,
};

/**
 * Donos de conversa que têm estas rotas: o prefixo e como o `:id` da URL vira o `ConversationRef`. O `:id` tem a mesma forma nos dois
 * (UUID), então os schemas de parâmetros são os mesmos.
 */
/** Prefixo das rotas de uma sessão do Chat geral: só ele recebe as rotas de versão (phase 4). */
const SESSION_PREFIX = '/chat/sessions/:id';

const OWNERS: readonly { prefix: string; ref: (id: string) => ConversationRef }[] = [
  { prefix: '/bots/:id', ref: (id) => id },
  { prefix: SESSION_PREFIX, ref: (id) => ({ sessionId: id }) },
];

/** Id de evento válido (dígitos): o cabeçalho `Last-Event-ID` vem do cliente e não é confiável. */
const EVENT_ID = /^\d{1,18}$/;

/** Espera `ms`, acordando antes se a conexão fechar. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

export const conversationRoutes: FastifyPluginAsyncZod<ConversationRoutesOptions> = async (app, { conversations, sse = {} }) => {
  const timing = { ...SSE_DEFAULTS, ...sse };
  // Encerramento da aplicação. `preClose` (e não `onClose`) é o hook certo: roda ANTES de o servidor passar a esperar as
  // conexões abertas, que é exatamente o que um stream SSE nunca deixaria terminar sozinho. O hook também ESPERA os streams
  // de fato terminarem (até 2 s): o `server.close()` só solta as conexões que já estão ociosas naquele instante, e uma
  // resposta que ainda está se encerrando seguraria o fechamento até o tempo de keep-alive (72 s).
  const shutdown = new AbortController();
  const openStreams = new Set<Promise<void>>();
  app.addHook('preClose', async () => {
    shutdown.abort();
    await Promise.race([Promise.all([...openStreams]), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  });

  /**
   * Rotas de versão da sessão do Chat geral (phase 4, F1 a F4, CONV-01), registradas só sob o prefixo da sessão. Corpos estritos; o serviço confere
   * que a mensagem, a execução ou a versão pertence a ESTA sessão e ao caminho dela (VERSION_NOT_FOUND, anti-IDOR) e que ela está parada
   * (CONVERSATION_BUSY). Editar e gerar somam no limite de envios; retroceder, restaurar e escolher, no limite dos controles.
   */
  function registerVersionRoutes(prefix: string): void {
    const session = (id: string) => ({ sessionId: id });

    // Editar uma mensagem do caminho ativo: versão nova ao lado dela e a execução que a responde.
    app.post(
      `${prefix}/versions/edit`,
      { schema: { params: botIdParamsSchema, body: editMessageRequestSchema, response: { 201: runViewSchema } } },
      async (request, reply) =>
        reply.status(201).send(await conversations.edit(session(request.params.id), request.body.messageId, request.body.content, request.body.attachmentIds)),
    );

    // Gerar outra resposta para uma resposta terminada do caminho ativo (o "Tentar novamente" da sessão também chega aqui pelo serviço).
    app.post(
      `${prefix}/versions/regenerate`,
      { schema: { params: botIdParamsSchema, body: versionRunRequestSchema, response: { 201: runViewSchema } } },
      async (request, reply) => reply.status(201).send(await conversations.regenerate(session(request.params.id), request.body.runId)),
    );

    // Retroceder até uma resposta do caminho ativo que tem rodadas depois dela; devolve o snapshot com o caminho novo.
    app.post(
      `${prefix}/versions/rewind`,
      { schema: { params: botIdParamsSchema, body: versionRunRequestSchema, response: { 200: conversationSnapshotSchema } } },
      async (request) => conversations.rewind(session(request.params.id), request.body.runId),
    );

    // Restaurar o caminho de antes do retrocesso em vigor. Sem corpo.
    app.post(
      `${prefix}/versions/restore`,
      { schema: { params: botIdParamsSchema, response: { 200: conversationSnapshotSchema } } },
      async (request) => conversations.restore(session(request.params.id)),
    );

    // Escolher a versão de uma mensagem ou de uma resposta (seletor "‹ k/n ›"); devolve o snapshot com o caminho novo.
    app.post(
      `${prefix}/versions/choose`,
      { schema: { params: botIdParamsSchema, body: chooseVersionRequestSchema, response: { 200: conversationSnapshotSchema } } },
      async (request) => conversations.chooseVersion(session(request.params.id), request.body),
    );
  }

  for (const { prefix, ref } of OWNERS) {
    // Metadados sem inferência. O único comando é "Compactar agora" (`mode` só `summarize`; a elisão manual saiu na phase 9 e `elision` volta como VALIDATION_FAILED
    // pelo schema do corpo), restrito a 1KiB e sujeito à sessão/Origin/CSRF já comuns às rotas.
    app.get(`${prefix}/conversation/context`, { schema: { params: botIdParamsSchema, response: { 200: contextStateSchema } } }, async (request) => conversations.contextState(ref(request.params.id)));
    app.post(`${prefix}/conversation/context/maintenance`, { bodyLimit: 1024, schema: { params: botIdParamsSchema, body: contextMaintenanceRequestSchema, response: { 200: contextStateSchema } } }, async (request) => conversations.maintainContext(ref(request.params.id),request.body,request.auth!.sessionId));
    app.post(`${prefix}/conversation/context/maintenance/:requestId/cancel`, { bodyLimit: 1024, schema: { params: contextMaintenanceParamsSchema, body: contextMaintenanceCancelSchema, response: { 200: contextStateSchema } } }, async (request) => conversations.cancelContextMaintenance(ref(request.params.id),request.params.requestId));
    // Estado inicial da tela: última página, execuções abertas, modelo em uso e ponto de retomada do SSE.
    app.get(
      `${prefix}/conversation`,
      { schema: { params: botIdParamsSchema, response: { 200: conversationSnapshotSchema } } },
      async (request) => conversations.snapshot(ref(request.params.id)),
    );

    // Rodadas anteriores a `before` (rolagem para cima e busca do trecho de um link "ver na conversa"): `rounds` de 1 a 50 (padrão 10), com teto de 300 itens.
    app.get(
      `${prefix}/conversation/messages`,
      { schema: { params: botIdParamsSchema, querystring: conversationPageQuerySchema, response: { 200: conversationPageSchema } } },
      async (request) => conversations.page(ref(request.params.id), request.query.before, request.query.rounds),
    );

    // Envia uma mensagem: entra na fila da conversa (`kind: 'run'`) ou, com execução ativa, vira complemento pendente dela (`kind: 'complement'`).
    app.post(
      `${prefix}/messages`,
      { schema: { params: botIdParamsSchema, body: sendMessageRequestSchema, response: { 201: sendResultSchema } } },
      async (request, reply) => reply.status(201).send(await conversations.send(ref(request.params.id), request.body.content, request.body.attachmentIds)),
    );

    // "Cancelar" de um complemento pendente: ele volta como rascunho devolvido (texto e anexos), que é a resposta.
    app.post(
      `${prefix}/complements/cancel`,
      { schema: { params: botIdParamsSchema, body: cancelComplementRequestSchema, response: { 200: draftViewSchema } } },
      async (request) => conversations.cancelComplement(ref(request.params.id), request.body.complementId),
    );

    // Entrega o rascunho devolvido a este composer (uma vez só: outro aparelho recebe DRAFT_NOT_FOUND). Sem corpo além do id na rota.
    app.post(
      `${prefix}/draft/:draftId/consume`,
      { schema: { params: draftParamsSchema, response: { 200: draftViewSchema } } },
      async (request) => conversations.consumeDraft(ref(request.params.id), request.params.draftId),
    );

    // Troca de modelo e effort feita no composer: vale para esta conversa, sem alterar o padrão do bot.
    app.patch(
      `${prefix}/conversation`,
      { schema: { params: botIdParamsSchema, body: conversationPreferenceRequestSchema, response: { 200: modelChoiceSchema } } },
      async (request) => conversations.setPreference(ref(request.params.id), request.body.model, request.body.effort),
    );

    // Parar a execução ativa do bot. Assíncrono: o worker interrompe no próximo batimento e grava o cartão. `?runId=` (usado por
    // Atividades, cuja lista pode estar desatualizada) só para a execução se for essa a ativa.
    app.post(
      `${prefix}/runs/stop`,
      { schema: { params: botIdParamsSchema, querystring: stopRunQuerySchema, response: { 200: runViewSchema } } },
      async (request) => conversations.stop(ref(request.params.id), request.query.runId),
    );

    // "Tentar novamente" do cartão de falha: nova execução sobre a mesma mensagem.
    app.post(
      `${prefix}/runs/:runId/retry`,
      { schema: { params: botRunParamsSchema, response: { 201: runViewSchema } } },
      async (request, reply) => reply.status(201).send(await conversations.retry(ref(request.params.id), request.params.runId)),
    );

    // Continuar é distinto de repetir/regenerar e exige a revisão terminal vista pelo dono.
    app.post(
      `${prefix}/runs/:runId/continue`,
      { schema: { params: botRunParamsSchema, body: continueRunRequestSchema, response: { 201: runViewSchema } } },
      async (request, reply) => reply.status(201).send(await conversations.continueRun(ref(request.params.id), request.params.runId, request.body.limitMessageId)),
    );

    // Versões (phase 4, F1 a F4): só a sessão do Chat geral as tem; no bot (linear, CONV-02) estas rotas nem existem e respondem 404 padrão.
    if (prefix === SESSION_PREFIX) registerVersionRoutes(prefix);

    // SSE da conversa. Sem ponto de retomada (nem cabeçalho nem `after`), começa do que for novo.
    app.get(
      `${prefix}/conversation/events`,
      { schema: { params: botIdParamsSchema, querystring: conversationEventsQuerySchema } },
      async (request, reply) => {
        const conversationId = await conversations.conversationIdOf(ref(request.params.id));
        const header = request.headers['last-event-id'];
        let cursor =
          typeof header === 'string' && EVENT_ID.test(header)
            ? header
            : (request.query.after ?? (await conversations.latestEventId(conversationId)));

        const clientGone = new AbortController();
        const ended = new Promise<void>((resolve) => reply.raw.once('close', resolve));
        openStreams.add(ended);
        void ended.then(() => {
          openStreams.delete(ended);
          clientGone.abort();
        });
        // Encerra o stream quando o cliente desiste OU a API está fechando.
        const closed = { signal: AbortSignal.any([clientGone.signal, shutdown.signal]) };

        async function* frames(): AsyncGenerator<string> {
          yield 'retry: 3000\n\n';
          const startedAt = Date.now();
          let lastWrite = Date.now();
          try {
            while (!closed.signal.aborted && Date.now() - startedAt < timing.maxLifetimeMs) {
              const { updates, cursor: next } = await conversations.updatesSince(conversationId, cursor);
              cursor = next;
              for (const update of updates) {
                yield `id: ${update.id}\nevent: ${update.event}\ndata: ${JSON.stringify(update.data)}\n\n`;
                lastWrite = Date.now();
              }
              if (updates.length > 0) continue;
              if (Date.now() - lastWrite >= timing.pingMs) {
                yield ': ping\n\n';
                lastWrite = Date.now();
              }
              await sleep(timing.pollMs, closed.signal);
            }
          } catch (error) {
            // Cabeçalhos já foram enviados: só resta encerrar o stream; o navegador reconecta e retoma do último evento.
            request.log.error({ err: error }, 'falha no stream da conversa');
          }
        }

        return reply
          .header('content-type', 'text/event-stream; charset=utf-8')
          .header('x-accel-buffering', 'no')
          .send(Readable.from(frames(), { objectMode: false }));
      },
    );
  }
};
