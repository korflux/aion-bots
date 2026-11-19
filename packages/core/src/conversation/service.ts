// Serviço da conversa (F6, F7; T6, e F16 na T12): o que a API expõe sobre a conversa única do bot e sobre cada sessão do chat geral.
// Fonte única dessas regras; a API só traduz HTTP <-> chamadas daqui, e o trabalho pesado (chamar o modelo) é do motor de execução, no
// worker.
//
// Dono da conversa (`ConversationRef`): todo método recebe o id de um BOT (a conversa única dele) ou `{ sessionId }` (uma sessão do
// chat geral, que é uma conversa sem bot). As duas funcionam igual (mesma fila, mesmo motor, mesmo SSE); as diferenças moram em
// `conversationOf` (bot arquivado, sessão inexistente) e no título automático da sessão. Nada além disso se duplica.
//
// Decisões:
// - Enviar uma mensagem NÃO toca a linha do tempo: cria uma execução `queued` com o texto. A mensagem só vira linha de
//   `messages` quando o worker começa a execução (ver `RunEngine`). Por isso a fila de um bot é só a tabela `runs`, a
//   tela mostra a mensagem como "Na fila" a partir da execução, e a linha do tempo nunca intercala uma pergunta ainda
//   sem resposta no meio da resposta de outra.
// - O teto de 20 mensagens na fila e a criação da execução rodam sob trava do bot (`SELECT ... FOR UPDATE`): dois envios
//   simultâneos não furam o limite.
// - Enviar com execução ativa COMPLEMENTA (phase 4, CONV-03): a mensagem vira complemento pendente da execução, sob a trava DELA, e as
//   transições seguintes (absorção, promoção, devolução) moram em `complements.ts`.
// - O rate limit de 60 mensagens por minuto é o primeiro portão, antes de qualquer consulta (abuso custa o menos possível).
// - "Tentar novamente" cria uma NOVA execução sobre a mesma mensagem (não repete a bolha do dono), só para a última
//   execução da conversa e só se ela falhou: repetir uma falha antiga reexecutaria um pedido que já ficou para trás.
// - O estado que a tela precisa para começar (`snapshot`) é lido com o id do último evento ANTES das linhas: tudo o que
//   mudar depois volta pelo SSE, e como o SSE reenvia o estado atual da linha, a sobreposição é inofensiva.
// - Versões no Chat geral (phase 4, CONV-01): a página e o snapshot da sessão mostram só o caminho ativo (`path.ts`), com as versões de cada rodada;
//   editar, gerar outra resposta (que é também o "Tentar novamente" da sessão), retroceder, restaurar e escolher versão só existem para a sessão
//   (`SessionRef`), travam a conversa e exigem a sessão parada (CONVERSATION_BUSY). Nada é apagado: cada comando cria uma versão ou muda a escolha.
//   O bot segue linear (CONV-02), com a leitura e o "Tentar novamente" da phase 3.
import {
  CONVERSATION_PAGE_MAX_ITEMS,
  CONVERSATION_PAGE_ROUNDS,
  MESSAGES_PER_MINUTE,
  OPEN_RUN_STATUSES,
  type ChooseVersionRequest,
  type ConversationPage,
  type ConversationSnapshot,
  type DraftView,
  type ModelChoiceView,
  type RunView,
  type SendResult,
  type EffortLevel,
  type ContextState,
  type ContextMaintenanceRequest,
  contextMaintenanceRequestSchema,
  hasModelProvider,
} from '@aion/shared';
import { readContextState, readContextRevision } from './context-state';
import { recordAudit } from '../audit';
import type { RequestOrigin } from '../auth/service';
import type { CredentialService } from '../credentials/service';
import { KeyedSlidingWindowLimiter, SlidingWindowLimiter } from '../credentials/rate-limit';
import { withTransaction, type Pool, type PoolClient, type Queryable } from '../db/pool';
import { DomainError } from '../errors';
import type { ModelService } from '../models/service';
import { titleFromMessage } from '../general-chat/title';
import { consumeDraft, createComplement, readDraft, returnComplements } from './complements';
import { readBotObjective } from '../bots/objectives';
import { lastConversationEventId, readConversationUpdates, recordConversationEvent, type ConversationUpdate } from './events';
import { readSessionDefault, resolveModelChoice } from './model-choice';
import { onPathSql, pathIds, readActivePath, type ActivePath } from './path';
import { lockVersionAttachments, queueContextMaintenance, queueRun, summarizeBlocker } from './run-queue';
import { MESSAGE_COLUMNS, RUN_COLUMNS, readMessageViews, readRunViews, type MessageRow, type RunRow } from './views';

export interface ConversationServiceOptions {
  pool: Pool;
  credentials: Pick<CredentialService, 'overview'>;
  models: Pick<ModelService, 'validateSelection'>;
  /** Relógio injetável: os testes fixam o tempo (datas e limite de taxa). */
  now?: () => Date;
}

/** Quem é dono da conversa: o id de um bot (a conversa única dele) ou uma sessão do chat geral. */
export type ConversationRef = string | { sessionId: string };

/** Só a sessão do chat geral: o dono das rotas de versão (o bot é linear, CONV-02). */
export type SessionRef = { sessionId: string };

/** Desfechos de uma execução sobre a qual "Gerar outra resposta" vale (F2). */
const REGENERABLE_STATUSES = ['completed', 'failed', 'interrupted', 'limit_reached', 'expired'];

interface ConversationRow {
  id: string;
  /** Nulo na sessão do chat geral. */
  bot_id: string | null;
  /** Só um bot pode estar arquivado; a sessão nunca está. */
  archived_at: Date | null;
}

/** Desfecho vigente: o status e o cartão mais recente são relidos juntos, sem reutilizar limites antigos da mesma execução. */
async function readCurrentRunLimit(db: Queryable, conversationId: string, runId: string) {
  const result = await db.query<{ status: string; limit: string | null; limit_message_id: string | null }>(
    `SELECT r.status, (SELECT m.id::text FROM messages m WHERE m.run_id=r.id AND m.kind='card' AND m.data->>'type'='run_limit' AND coalesce(m.data->'continuation'->>'automatic','false') <> 'true' ORDER BY m.id DESC LIMIT 1) AS limit_message_id, (SELECT m.data->>'limit' FROM messages m WHERE m.run_id=r.id AND m.kind='card'
      AND m.data->>'type'='run_limit' AND coalesce(m.data->'continuation'->>'automatic','false') <> 'true' ORDER BY m.id DESC LIMIT 1) AS limit
     FROM runs r WHERE r.id=$1 AND r.conversation_id=$2`, [runId, conversationId],
  );
  return result.rows[0];
}

export class ConversationService {
  /** Reutiliza limite por sessão; replay confirmado não consome nova tentativa. */
  private readonly maintenanceLimiter:KeyedSlidingWindowLimiter;
  private readonly pool: Pool;
  private readonly credentials: Pick<CredentialService, 'overview'>;
  private readonly models: Pick<ModelService, 'validateSelection'>;
  private readonly now: () => Date;
  private readonly sendLimiter: SlidingWindowLimiter;
  /**
   * Cancelar complemento, usar o rascunho devolvido e, no Chat geral, retroceder, restaurar e escolher versão: 60 por minuto (spec, por conversa).
   * As ações da mesma conversa compartilham a janela; editar e gerar outra resposta somam no `sendLimiter`, como o envio.
   */
  private readonly controlLimiter: KeyedSlidingWindowLimiter;

  constructor({ pool, credentials, models, now = () => new Date() }: ConversationServiceOptions) {
    this.pool = pool;
    this.credentials = credentials;
    this.models = models;
    this.now = now;
    this.maintenanceLimiter=new KeyedSlidingWindowLimiter({max:5,windowMs:60000,now});
    this.sendLimiter = new SlidingWindowLimiter({ max: MESSAGES_PER_MINUTE, windowMs: 60_000, now });
    this.controlLimiter = new KeyedSlidingWindowLimiter({ max: MESSAGES_PER_MINUTE, windowMs: 60_000, now });
  }

  /** Conta controles antes do banco; separa bot/sessão e normaliza UUID como o PostgreSQL, para maiúsculas não abrirem outra janela. */
  private consumeControl(ref: ConversationRef): void {
    this.controlLimiter.consume(typeof ref === 'string' ? `bot:${ref.toLowerCase()}` : `session:${ref.sessionId.toLowerCase()}`);
  }

  /** Resolve o dono na conversa. Lança BOT_NOT_FOUND (bot inexistente) ou SESSION_NOT_FOUND (sessão apagada ou que nunca existiu). */
  private async conversationOf(db: Pool | PoolClient, ref: ConversationRef): Promise<ConversationRow> {
    const found =
      typeof ref === 'string'
        ? await db.query<ConversationRow>(
            'SELECT c.id, c.bot_id, b.archived_at FROM conversations c JOIN bots b ON b.id = c.bot_id WHERE c.bot_id = $1',
            [ref],
          )
        : await db.query<ConversationRow>('SELECT id, bot_id, NULL::timestamptz AS archived_at FROM conversations WHERE id = $1 AND bot_id IS NULL', [
            ref.sessionId,
          ]);
    const row = found.rows[0];
    if (!row) throw new DomainError(typeof ref === 'string' ? 'BOT_NOT_FOUND' : 'SESSION_NOT_FOUND');
    return row;
  }

  // ---------------------------------------------------------------------------------------------
  // Leitura
  // ---------------------------------------------------------------------------------------------

  /**
   * Uma página da linha do tempo, da mais antiga para a mais nova, medida em RODADAS (as mesmas do contexto do modelo, ver `loadContextRows`):
   * uma rodada começa numa linha `opens_round` (mensagem do dono ou cartão que inicia uma execução) e vai até a linha anterior à próxima
   * abertura, então leva junto tudo o que o bot fez em resposta. A página são as `rounds` últimas rodadas anteriores a `before` (o id da
   * mensagem mais antiga que a tela já tem; sem ele, as mais recentes) e começa sempre na abertura de uma rodada: o `before` seguinte (a
   * primeira linha desta página) cai na fronteira e a próxima página traz rodadas inteiras. Linhas descartadas não contam. Sem `rounds`
   * aberturas antes de `before`, a página vai até o começo da conversa (inclusive linhas anteriores à primeira abertura, como um aviso).
   *
   * ponytail: o teto de itens corta no meio da rodada mais antiga quando as rodadas pedidas passam dele (o `before` seguinte retoma dali e a
   * página seguinte completa a rodada cortada), trocar por cortar só em fronteira de rodada se esse corte no meio confundir a leitura.
   */
  private async readPage(conversation: ConversationRow, before: string | undefined, rounds: number): Promise<ConversationPage> {
    if (conversation.bot_id === null) return (await this.readSessionPage(conversation.id, before, rounds)).page;
    const conversationId = conversation.id;
    const cap = CONVERSATION_PAGE_MAX_ITEMS;
    const found = await this.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE conversation_id = $1 AND status <> 'discarded' AND ($2::bigint IS NULL OR id < $2::bigint)
         AND id >= coalesce(
           (SELECT min(id) FROM (
              SELECT id FROM messages
              WHERE conversation_id = $1 AND opens_round AND status <> 'discarded' AND ($2::bigint IS NULL OR id < $2::bigint)
              ORDER BY id DESC LIMIT $3
            ) window_rounds),
           0)
       ORDER BY id DESC LIMIT $4`,
      [conversationId, before ?? null, rounds, cap + 1],
    );
    const items = found.rows.slice(0, cap).reverse();
    const oldest = items[0];
    // Mais para trás: o teto cortou a página, ou há linha visível anterior à primeira devolvida (a janela terminou na abertura de uma rodada).
    const hasMore = found.rows.length > cap || (oldest !== undefined && (await this.hasVisibleBefore(conversationId, oldest.id)));
    return { items: await readMessageViews(this.pool, items), hasMore };
  }

  /**
   * A página de uma sessão do Chat geral (phase 4, CONV-01): a mesma regra de `readPage`, contando só as rodadas do CAMINHO ATIVO e só as linhas
   * delas (`path.ts`); os ids crescem ao longo do caminho, então `before` e o teto de itens valem como no bot. Leva as rodadas presentes na página,
   * com as versões de cada uma, e devolve o caminho lido para o snapshot não relê-lo.
   */
  private async readSessionPage(conversationId: string, before: string | undefined, rounds: number): Promise<{ page: ConversationPage; path: ActivePath }> {
    const cap = CONVERSATION_PAGE_MAX_ITEMS;
    const path = await readActivePath(this.pool, conversationId);
    const { messageIds, runIds } = pathIds(path.rounds);
    const openings = messageIds.filter((id) => before === undefined || BigInt(id) < BigInt(before)).slice(-rounds);
    const found = await this.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m
       WHERE m.conversation_id = $1 AND m.status <> 'discarded' AND ${onPathSql('m', 2, 3)}
         AND ($4::bigint IS NULL OR m.id < $4::bigint) AND m.id >= $5::bigint
       ORDER BY m.id DESC LIMIT $6`,
      [conversationId, messageIds, runIds, before ?? null, openings[0] ?? '0', cap + 1],
    );
    const items = found.rows.slice(0, cap).reverse();
    const oldest = items[0];
    let hasMore = found.rows.length > cap;
    if (!hasMore && oldest !== undefined) {
      const older = await this.pool.query<{ older: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = $1 AND m.status <> 'discarded' AND m.id < $4::bigint AND ${onPathSql('m', 2, 3)}) AS older`,
        [conversationId, messageIds, runIds, oldest.id],
      );
      hasMore = older.rows[0]?.older === true;
    }
    const shown = new Set(items.map((item) => item.id));
    return {
      page: { items: await readMessageViews(this.pool, items), hasMore, rounds: path.rounds.filter((round) => shown.has(round.messageId)) },
      path,
    };
  }

  /** Existe alguma linha visível (não descartada) da conversa anterior a `messageId`? Responde o `hasMore` de uma página que terminou na fronteira de uma rodada. */
  private async hasVisibleBefore(conversationId: string, messageId: string): Promise<boolean> {
    const found = await this.pool.query<{ older: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM messages WHERE conversation_id = $1 AND status <> 'discarded' AND id < $2::bigint) AS older",
      [conversationId, messageId],
    );
    return found.rows[0]?.older === true;
  }

  /**
   * Estado inicial da tela: a última página (as últimas rodadas), as execuções abertas (a ativa com os complementos pendentes), o rascunho
   * devolvido ainda não entregue, o modelo em uso e o ponto de retomada do SSE.
   */
  async snapshot(ref: ConversationRef): Promise<ConversationSnapshot> {
    const conversation = await this.conversationOf(this.pool, ref);
    // O id do último evento vem ANTES das linhas (ver o cabeçalho): o que mudar depois é completado pelo SSE.
    const lastEventId = await lastConversationEventId(this.pool, conversation.id);
    const [read, runs, model, overview, draft] = await Promise.all([
      conversation.bot_id === null
        ? this.readSessionPage(conversation.id, undefined, CONVERSATION_PAGE_ROUNDS)
        : this.readPage(conversation, undefined, CONVERSATION_PAGE_ROUNDS).then((page) => ({ page, path: null })),
      this.pool.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE conversation_id = $1 AND status = ANY($2::text[]) ORDER BY id`,
        [conversation.id, OPEN_RUN_STATUSES],
      ),
      resolveModelChoice(this.pool, conversation.id),
      this.credentials.overview(),
      readDraft(this.pool, conversation.id, this.now()),
    ]);
    const { page, path } = read;
    return {
      context: await readContextState(this.pool, conversation.id),
      objective: conversation.bot_id === null ? null : await readBotObjective(this.pool, conversation.bot_id),
      items: page.items,
      hasMore: page.hasMore,
      runs: await readRunViews(this.pool, runs.rows),
      lastEventId,
      model,
      providerConfigured: hasModelProvider(overview),
      draft,
      // Sessão: as versões das rodadas mostradas e o retrocesso. A linha "Restaurar" some assim que uma mensagem nova entra na fila (a mensagem
      // vira versão ao lado da primeira rodada retrocedida quando a execução começa), por isso não vai com execução aberta.
      ...(path ? { rounds: page.rounds ?? [], rewound: runs.rows.length ? null : path.rewound } : {}),
    };
  }

  /** As `rounds` rodadas anteriores a `before` (rolagem para cima e busca do trecho de um link "ver na conversa"). */
  async page(ref: ConversationRef, before: string | undefined, rounds = CONVERSATION_PAGE_ROUNDS): Promise<ConversationPage> {
    return this.readPage(await this.conversationOf(this.pool, ref), before, rounds);
  }

  /** Id da conversa (do bot ou da sessão), para o SSE consultar atualizações sem resolver o dono a cada leitura. */
  async conversationIdOf(ref: ConversationRef): Promise<string> {
    return (await this.conversationOf(this.pool, ref)).id;
  }

  /** Id do último evento da conversa: o SSE sem ponto de retomada começa daqui (só o que for novo). */
  latestEventId(conversationId: string): Promise<string> {
    return lastConversationEventId(this.pool, conversationId);
  }

  /** Atualizações da conversa posteriores ao evento `afterId` (base do SSE). */
  updatesSince(conversationId: string, afterId: string): Promise<{ updates: ConversationUpdate[]; cursor: string }> {
    return readConversationUpdates(this.pool, conversationId, afterId, this.now());
  }

  // ---------------------------------------------------------------------------------------------
  // Comandos
  // ---------------------------------------------------------------------------------------------

  /**
   * Envia uma mensagem do dono (CONV-03): com uma execução ativa (rodando ou aguardando aprovação, sem parada pedida) ela vira COMPLEMENTO
   * pendente dessa execução, que o executor lê na próxima fronteira entre etapas sem interromper nada; sem execução ativa, entra na fila como
   * sempre. Rotinas não passam por aqui (continuam sempre na fila). O rate limit é o mesmo nos dois casos (somado). Lança RATE_LIMITED,
   * BOT_NOT_FOUND, SESSION_NOT_FOUND, BOT_ARCHIVED, PROVIDER_NOT_CONFIGURED, MODEL_UNAVAILABLE (sem modelo para usar, ou fora da lista do
   * provedor), QUEUE_FULL, COMPLEMENT_LIMIT_REACHED, ATTACHMENT_LIMIT_REACHED, ATTACHMENT_NOT_FOUND (arquivo alheio, repetido, removido ou já
   * ligado) e MODEL_NO_IMAGE_SUPPORT.
   */
  /** Consulta autorizada sem inferência, sessão nova, conteúdo ou alteração de preferências. */
  async contextState(ref: ConversationRef): Promise<ContextState> {
    return readContextState(this.pool, (await this.conversationOf(this.pool, ref)).id);
  }

  /** Intenção idempotente e imediata: só entra na fila quando a conversa está ociosa sob o lock do dono. */
  async maintainContext(ref: ConversationRef, raw: ContextMaintenanceRequest, sessionId: string): Promise<ContextState> {
    const input = contextMaintenanceRequestSchema.parse(raw);
    const conversation = await this.conversationOf(this.pool, ref);
    if (conversation.archived_at !== null) throw new DomainError('BOT_ARCHIVED');
    await withTransaction(this.pool, async (tx) => {
      // Mesmo lock curto da fila, antes de conferir ocupação; o executor permanece fora da transação.
      const locked = conversation.bot_id === null
        ? await tx.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conversation.id])
        : await tx.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [conversation.bot_id]);
      if (!locked.rowCount) throw new DomainError(conversation.bot_id === null ? 'SESSION_NOT_FOUND' : 'BOT_NOT_FOUND');
      const existing = (await tx.query<{ conversation_id: string; mode: string; expected_revision: string; session_id: string | null }>('SELECT conversation_id,mode,expected_revision::text,session_id FROM context_maintenance WHERE request_id=$1', [input.requestId])).rows[0];
      if (existing) {
        // Só o pedido do DONO (com sessão) pode ser repetido por aqui. O requestId de uma manutenção fria (sem sessão, derivado da conversa e da revisão, `coldRequestId`) não é de nenhum clique:
        // reusá-lo é conflito, nunca "replay", e nunca devolve nem toca a operação do worker (a inserção abaixo esbarraria na chave primária, então a recusa tem de vir antes).
        if (existing.session_id === null || existing.conversation_id !== conversation.id || existing.mode !== input.mode || Number(existing.expected_revision) !== input.expectedRevision) throw new DomainError('CONTEXT_CONFLICT');
        return;
      }
      this.maintenanceLimiter.consume(sessionId);
      if ((await tx.query("SELECT 1 FROM runs WHERE conversation_id=$1 AND status IN ('queued','running','waiting_approval') LIMIT 1", [conversation.id])).rowCount) throw new DomainError('CONTEXT_BUSY');
      if (await readContextRevision(tx, conversation.id) !== input.expectedRevision) throw new DomainError('CONTEXT_CONFLICT');
      // "Compactar agora" é uma chamada paga ao modelo (o schema só admite `summarize`): exige o modelo com perfil validado e a chave do provedor (a mesma regra da compactação fria).
      const blocker = await summarizeBlocker(tx, conversation.id);
      if (blocker !== null) throw new DomainError(blocker);
      // A inserção, o recibo e a auditoria são os da compactação fria também (`queueContextMaintenance`): aqui com a sessão do dono que clicou.
      await queueContextMaintenance(tx, { botId: conversation.bot_id, conversationId: conversation.id, requestId: input.requestId, mode: input.mode, expectedRevision: input.expectedRevision, sessionId, at: this.now() });
    });
    return readContextState(this.pool, conversation.id);
  }

  /**
   * Cancelar só marca a operação autorizada; lease controla o commit e nenhuma mensagem/rodada é gerada. Só acha operação PEDIDA PELO DONO (com sessão): a manutenção fria é do worker,
   * o dono nem a vê (`readContextState`), e o id dela é derivado da conversa e da revisão, então cancelá-la por aqui responde `NOT_FOUND` como a de qualquer id desconhecido.
   */
  async cancelContextMaintenance(ref: ConversationRef, requestId: string): Promise<ContextState> {
    const conversation = await this.conversationOf(this.pool, ref), at = this.now();
    await withTransaction(this.pool, async (tx) => {
      const operation = (await tx.query<{ run_id: string; status: string }>('SELECT m.run_id::text,r.status FROM context_maintenance m JOIN runs r ON r.id=m.run_id WHERE m.request_id=$1 AND m.conversation_id=$2 AND m.session_id IS NOT NULL FOR UPDATE OF r', [requestId, conversation.id])).rows[0];
      if (!operation) throw new DomainError('NOT_FOUND');
      if (operation.status === 'queued') {
        await tx.query("UPDATE runs SET status='interrupted',stop_requested_at=$2,finished_at=$2 WHERE id=$1", [operation.run_id,at]);
        await tx.query("UPDATE context_maintenance SET outcome='cancelled' WHERE request_id=$1", [requestId]);
      } else if (operation.status === 'running') await tx.query('UPDATE runs SET stop_requested_at=coalesce(stop_requested_at,$2) WHERE id=$1', [operation.run_id,at]);
      await recordConversationEvent(tx, conversation.id, 'context', '0',at);
    });
    return readContextState(this.pool,conversation.id);
  }

  async send(ref: ConversationRef, content: string, attachmentIds: readonly string[] = []): Promise<SendResult> {
    this.sendLimiter.consume();
    const conversation = await this.conversationOf(this.pool, ref);
    if (conversation.archived_at !== null) throw new DomainError('BOT_ARCHIVED');
    if (!hasModelProvider(await this.credentials.overview())) throw new DomainError('PROVIDER_NOT_CONFIGURED');
    const choice = await resolveModelChoice(this.pool, conversation.id);
    if (choice.model === null) throw new DomainError('MODEL_UNAVAILABLE');
    // O effort é conferido contra os níveis gravados na hora de executar (um "testar novamente" pode mudá-los depois).
    await this.models.validateSelection(choice.model, null);
    const at = this.now();
    return withTransaction(this.pool, async (tx) => {
      // A execução ativa é travada ANTES de qualquer outra coisa (ordem de trava em `complements.ts`). Se ela estiver no desfecho, esta leitura
      // espera e, terminada a execução, não a encontra mais: a mensagem segue para a fila, depois da execução promovida (se houve).
      const active = await tx.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE conversation_id = $1 AND status IN ('running', 'waiting_approval') AND stop_requested_at IS NULL AND context_operation_id IS NULL FOR UPDATE`,
        [conversation.id],
      );
      const run = active.rows[0];
      if (run) return { kind: 'complement' as const, ...(await createComplement(tx, run, content, attachmentIds, at)) };
      return { kind: 'run' as const, ...(await this.enqueueIn(tx, conversation, content, null, attachmentIds, at)) };
    });
  }

  /**
   * Cria a execução na fila sob a trava da conversa (ver `queueRun`), dentro da transação dada. `triggerMessageId` só existe na repetição de uma
   * execução que falhou. A primeira mensagem de uma sessão dá o título dela (só se ainda não tem), na mesma transação do envio: a sessão nunca
   * fica com uma execução e sem título.
   */
  private async enqueueIn(tx: PoolClient, conversation: ConversationRow, input: string, triggerMessageId: string | null, attachmentIds: readonly string[], at: Date): Promise<RunView> {
    const run = await queueRun(tx, { botId: conversation.bot_id, conversationId: conversation.id, input, triggerMessageId, attachmentIds, at, enforceLimit: true });
    if (conversation.bot_id === null) {
      await tx.query('UPDATE conversations SET title = $2 WHERE id = $1 AND title IS NULL', [conversation.id, titleFromMessage(input)]);
    }
    return (await readRunViews(tx, [run]))[0]!;
  }

  /**
   * Pede a parada da execução ativa da conversa. A parada é assíncrona: o worker lê o pedido no próximo batimento, interrompe o
   * streaming e grava o cartão. Lança RUN_NOT_ACTIVE se a conversa não tem execução ativa (já terminou, ou só há fila). Com `runId`, a
   * parada só vale se for ESSA a execução ativa: quem mostra uma lista (Atividades) pode estar desatualizado, e sem a trava um
   * clique numa execução que acabou pararia a seguinte, que não é a que o dono viu. Os complementos ainda não lidos voltam, na mesma
   * transação, como rascunho devolvido (Suposição 18): com a parada pedida, a execução nunca mais os absorve.
   * A compactação fria (manutenção de contexto SEM sessão do dono, `context_maintenance.session_id IS NULL`, migration 0048) fica fora da parada, com ou sem `runId`: o dono nem a vê
   * (`readContextState`, `context-state.ts`), então não há gesto dele que a justifique, e pará-la descartaria um resumo já pago e ainda não gravado (spec da phase 11, decisão 20: o resumo pago
   * nunca é descartado). Com ela como única execução ativa a resposta é `RUN_NOT_ACTIVE`, como para qualquer conversa sem execução do dono; a mensagem do dono espera na fila FIFO.
   * A manutenção pedida pelo dono ("Compactar agora", com sessão) segue como era: o cancelar próprio dela é `cancelContextMaintenance`.
   */
  async stop(ref: ConversationRef, runId?: string): Promise<RunView> {
    const at = this.now();
    const conversation = await this.conversationOf(this.pool, ref);
    return withTransaction(this.pool, async (tx) => {
      const updated = await tx.query<RunRow>(
        `UPDATE runs SET stop_requested_at = coalesce(stop_requested_at, $2)
         WHERE conversation_id = $1 AND status IN ('running', 'waiting_approval') AND ($3::bigint IS NULL OR id = $3::bigint)
           AND NOT EXISTS (SELECT 1 FROM context_maintenance m WHERE m.run_id = runs.id AND m.session_id IS NULL)
         RETURNING ${RUN_COLUMNS}`,
        [conversation.id, at, runId ?? null],
      );
      const row = updated.rows[0];
      if (!row) throw new DomainError('RUN_NOT_ACTIVE');
      await returnComplements(tx, row, at);
      await recordConversationEvent(tx, conversation.id, 'run', row.id, at);
      return (await readRunViews(tx, [row]))[0]!;
    });
  }

  /**
   * "Cancelar" de um complemento pendente (F5 passo 4): ele sai da execução e volta como rascunho devolvido, com texto e anexos. Trava a
   * execução antes do complemento (mesma ordem da absorção), então cancelar e absorver nunca valem os dois. Lança RATE_LIMITED e
   * COMPLEMENT_NOT_FOUND (alheio à conversa, já lido, promovido ou cancelado). Devolve o rascunho como ficou.
   */
  async cancelComplement(ref: ConversationRef, complementId: string): Promise<DraftView> {
    this.consumeControl(ref);
    const at = this.now();
    const conversation = await this.conversationOf(this.pool, ref);
    return withTransaction(this.pool, async (tx) => {
      const owner = await tx.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE id = (SELECT run_id FROM complements WHERE id = $1 AND conversation_id = $2 AND state = 'pending') FOR UPDATE`,
        [complementId, conversation.id],
      );
      const run = owner.rows[0];
      const draftId = run ? await returnComplements(tx, run, at, complementId) : null;
      if (draftId === null) throw new DomainError('COMPLEMENT_NOT_FOUND');
      return (await readDraft(tx, conversation.id, at)) as DraftView;
    });
  }

  /**
   * Entrega o rascunho devolvido a quem pediu (o composer vazio, ou "Usar" na linha do rascunho): devolve texto e anexos e o apaga, então o
   * outro aparelho recebe DRAFT_NOT_FOUND. "Descartar" usa o mesmo caminho e solta os anexos pelo descarte normal. Lança RATE_LIMITED e
   * DRAFT_NOT_FOUND (alheio, já entregue ou vencido).
   */
  async consumeDraft(ref: ConversationRef, draftId: string): Promise<DraftView> {
    this.consumeControl(ref);
    const at = this.now();
    const conversation = await this.conversationOf(this.pool, ref);
    return withTransaction(this.pool, (tx) => consumeDraft(tx, conversation.id, draftId, at));
  }

  /**
   * Repete uma execução que falhou (cartão de falha, "Tentar novamente"). Lança RUN_NOT_RETRYABLE, BOT_ARCHIVED, QUEUE_FULL. Na sessão do Chat geral
   * é "Gerar outra resposta" (F2): uma versão nova da resposta, com as regras e os erros de `regenerate`.
   */
  async retry(ref: ConversationRef, runId: string): Promise<RunView> {
    const conversation = await this.conversationOf(this.pool, ref);
    if (typeof ref !== 'string') return this.regenerate(ref, runId);
    if (conversation.archived_at !== null) throw new DomainError('BOT_ARCHIVED');
    const found = await this.pool.query<RunRow & { newer: boolean }>(
      `SELECT ${RUN_COLUMNS}, EXISTS (SELECT 1 FROM runs n WHERE n.conversation_id = r.conversation_id AND n.id > r.id) AS newer
       FROM runs r WHERE r.id = $1 AND r.conversation_id = $2`,
      [runId, conversation.id],
    );
    const run = found.rows[0];
    // Uma execução de rotina falha dentro do próprio cartão da rotina; a próxima é a do próximo horário (ou "Executar agora").
    if (!run || run.status !== 'failed' || run.newer || run.trigger_message_id === null || run.routine_name !== null) throw new DomainError('RUN_NOT_RETRYABLE');
    const at = this.now();
    return withTransaction(this.pool, (tx) => this.enqueueIn(tx, conversation, run.input, run.trigger_message_id, [], at));
  }

  /** Ação explícita sem fallback para retry/regenerate; confirma o cartão de limite que originou o gesto. */
  async continueRun(ref: ConversationRef, runId: string, limitMessageId: string): Promise<RunView> {
    return this.continueOutputLimited(ref, await this.conversationOf(this.pool, ref), runId, limitMessageId);
  }

  /** Retoma somente limite de saída, na mesma execução e com o contexto/checkpoints já persistidos; nunca cria outra ocorrência/versão. */
  private async continueOutputLimited(ref: ConversationRef, conversation: ConversationRow, runId: string, limitMessageId: string): Promise<RunView> {
    this.consumeControl(ref);
    await this.assertCanRun(conversation.id);
    const preliminary = await this.pool.query<{ routine_id: string | null }>('SELECT routine_id FROM runs WHERE id = $1 AND conversation_id = $2', [runId, conversation.id]);
    const routineId = preliminary.rows[0]?.routine_id;
    const at = this.now();
    return withTransaction(this.pool, async (tx) => {
      // Mesma ordem do agendador/arquivamento: rotina, dono da fila, execução. Pausa não impede a continuação explícita; exclusão impede.
      if (routineId && !(await tx.query('SELECT id FROM routines WHERE id = $1 FOR UPDATE', [routineId])).rowCount) throw new DomainError('RUN_NOT_RETRYABLE');
      if (conversation.bot_id !== null) {
        const bot = await tx.query<{ archived_at: Date | null }>('SELECT archived_at FROM bots WHERE id = $1 FOR UPDATE', [conversation.bot_id]);
        if (!bot.rowCount) throw new DomainError('BOT_NOT_FOUND');
        if (bot.rows[0]!.archived_at !== null) throw new DomainError('BOT_ARCHIVED');
      } else if (!(await tx.query('SELECT id FROM conversations WHERE id = $1 AND bot_id IS NULL FOR NO KEY UPDATE', [conversation.id])).rowCount) throw new DomainError('SESSION_NOT_FOUND');
      const found = await tx.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1 AND conversation_id = $2 FOR UPDATE`, [runId, conversation.id]);
      const run = found.rows[0];
      if (!run || run.status !== 'limit_reached' || run.trigger_message_id === null || run.routine_id !== (routineId ?? null) || run.routine_name !== null && run.routine_id === null) throw new DomainError('RUN_NOT_RETRYABLE');
      const blocked = await tx.query("SELECT 1 FROM runs WHERE conversation_id = $1 AND (id > $2 OR status = ANY($3::text[])) LIMIT 1", [conversation.id, runId, OPEN_RUN_STATUSES]);
      if (blocked.rowCount) throw new DomainError('RUN_NOT_RETRYABLE');
      if (conversation.bot_id === null && (await readActivePath(tx, conversation.id)).rounds.at(-1)?.runId !== runId) throw new DomainError('RUN_NOT_RETRYABLE');
      const outcome = await readCurrentRunLimit(tx, conversation.id, runId);
      if (outcome?.status !== 'limit_reached' || outcome.limit !== 'tokens' || outcome.limit_message_id !== limitMessageId) throw new DomainError('RUN_NOT_RETRYABLE');
      await tx.query("UPDATE messages SET data=data || '{\"continuedManually\":true}'::jsonb WHERE id=$1 AND run_id=$2", [limitMessageId, runId]);
      // Não zera budgets, mensagem de gatilho, chamadas concluídas ou metadados da rodada; dois cliques só podem reabrir uma vez.
      const updated = await tx.query<RunRow>(`UPDATE runs SET status = 'queued', finished_at = NULL, failure_code = NULL, stop_requested_at = NULL, lease_until = NULL, lease_owner = NULL WHERE id = $1 RETURNING ${RUN_COLUMNS}`, [runId]);
      await recordConversationEvent(tx, conversation.id, 'run', runId, at);
      return (await readRunViews(tx, [updated.rows[0]!]))[0]!;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Versões do Chat geral (phase 4, F1 a F4, CONV-01)
  // ---------------------------------------------------------------------------------------------

  /**
   * Trava a sessão (a mesma linha que `queueRun` trava, então nenhum envio entra no meio) e exige que ela esteja parada: sem execução na fila,
   * rodando ou aguardando aprovação, e sem complemento pendente. `FOR NO KEY UPDATE` não bloqueia as chaves estrangeiras que o executor grava.
   * Lança SESSION_NOT_FOUND e CONVERSATION_BUSY.
   */
  private async lockIdleSession(tx: PoolClient, ref: SessionRef): Promise<string> {
    const locked = await tx.query<{ id: string }>('SELECT id FROM conversations WHERE id = $1 AND bot_id IS NULL FOR NO KEY UPDATE', [ref.sessionId]);
    const conversationId = locked.rows[0]?.id;
    if (conversationId === undefined) throw new DomainError('SESSION_NOT_FOUND');
    const busy = await tx.query<{ busy: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM runs WHERE conversation_id = $1 AND status = ANY($2::text[]))
           OR EXISTS (SELECT 1 FROM complements WHERE conversation_id = $1 AND state = 'pending') AS busy`,
      [conversationId, OPEN_RUN_STATUSES],
    );
    if (busy.rows[0]?.busy === true) throw new DomainError('CONVERSATION_BUSY');
    return conversationId;
  }

  /**
   * Fim comum das trocas de caminho, na transação delas: o retrocesso deixa de valer (a troca define o caminho novo inteiro) e o evento `path`
   * avisa os aparelhos abertos. Não grava mensagem nem aviso: trocar de versão não é novidade (Suposição 13).
   */
  private async pathChanged(tx: PoolClient, conversationId: string, at: Date): Promise<void> {
    await tx.query('UPDATE conversations SET rewound_run_id = NULL, rewound_message_id = NULL WHERE id = $1', [conversationId]);
    await recordConversationEvent(tx, conversationId, 'path', '0', at);
  }

  /** O que editar e gerar conferem antes da transação, como o envio: provedor configurado e modelo disponível (MODEL_UNAVAILABLE). */
  private async assertCanRun(conversationId: string): Promise<void> {
    if (!hasModelProvider(await this.credentials.overview())) throw new DomainError('PROVIDER_NOT_CONFIGURED');
    const choice = await resolveModelChoice(this.pool, conversationId);
    if (choice.model === null) throw new DomainError('MODEL_UNAVAILABLE');
    await this.models.validateSelection(choice.model, null);
  }

  /**
   * Editar (F1): cria uma versão nova da mensagem `messageId` do caminho ativo, ao lado dela (mesmo pai), com o texto e os anexos dados, e a execução
   * que a responde; o caminho passa a ela e as rodadas da versão antiga ficam guardadas no ramo dela. A mensagem nasce já na linha do tempo (como na
   * repetição, a execução tem a mensagem de gatilho): a sessão está parada, então ela começa logo. Anexos: os pendentes do composer passam a ser da
   * mensagem nova e os já ligados a outra versão ganham um vínculo extra (`lockVersionAttachments`). Conta no limite de envios. Lança RATE_LIMITED,
   * SESSION_NOT_FOUND, PROVIDER_NOT_CONFIGURED, MODEL_UNAVAILABLE, CONVERSATION_BUSY, VERSION_NOT_FOUND, MODEL_NO_IMAGE_SUPPORT e ATTACHMENT_*.
   */
  async edit(ref: SessionRef, messageId: string, content: string, attachmentIds: readonly string[] = []): Promise<RunView> {
    this.sendLimiter.consume();
    await this.assertCanRun((await this.conversationOf(this.pool, ref)).id);
    const at = this.now();
    return withTransaction(this.pool, async (tx) => {
      const conversationId = await this.lockIdleSession(tx, ref);
      const edited = (await readActivePath(tx, conversationId)).rounds.find((round) => round.messageId === BigInt(messageId).toString());
      if (!edited) throw new DomainError('VERSION_NOT_FOUND');
      const parent = await tx.query<{ parent_run_id: string | null }>('SELECT parent_run_id::text AS parent_run_id FROM messages WHERE id = $1', [edited.messageId]);
      const files = await lockVersionAttachments(tx, conversationId, attachmentIds);
      const run = await queueRun(tx, { botId: null, conversationId, input: content, at, enforceLimit: true });
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, parent_run_id, created_at)
         VALUES ($1, $2, 'user', 'text', 'done', true, $3, $4, $5) RETURNING id::text AS id`,
        [conversationId, run.id, content, parent.rows[0]?.parent_run_id ?? null, at],
      );
      const message = (inserted.rows[0] as { id: string }).id;
      await tx.query('UPDATE runs SET trigger_message_id = $2 WHERE id = $1', [run.id, message]);
      if (files.pending.length) await tx.query('UPDATE attachments SET run_id = $2, message_id = $3 WHERE id = ANY($1::bigint[])', [files.pending, run.id, message]);
      if (files.linked.length) await tx.query('INSERT INTO message_attachment_links (message_id, attachment_id) SELECT $1, unnest($2::bigint[])', [message, files.linked]);
      await recordConversationEvent(tx, conversationId, 'message', message, at);
      await this.pathChanged(tx, conversationId, at);
      return (await readRunViews(tx, [{ ...run, trigger_message_id: message }]))[0]!;
    });
  }

  /**
   * Gerar outra resposta (F2), também o "Tentar novamente" da sessão: nova execução sobre a mensagem de uma resposta TERMINADA do caminho ativo
   * (do meio ou do fim). Ela é a versão nova da resposta e o caminho termina nela; as rodadas que pendiam da versão anterior ficam guardadas lá.
   * Conta no limite de envios. Lança RATE_LIMITED, SESSION_NOT_FOUND, PROVIDER_NOT_CONFIGURED, MODEL_UNAVAILABLE, CONVERSATION_BUSY e
   * VERSION_NOT_FOUND.
   */
  async regenerate(ref: SessionRef, runId: string): Promise<RunView> {
    this.sendLimiter.consume();
    await this.assertCanRun((await this.conversationOf(this.pool, ref)).id);
    const at = this.now();
    return withTransaction(this.pool, async (tx) => {
      const conversationId = await this.lockIdleSession(tx, ref);
      const round = (await readActivePath(tx, conversationId)).rounds.find((candidate) => candidate.runId === BigInt(runId).toString());
      if (!round) throw new DomainError('VERSION_NOT_FOUND');
      const source = await tx.query<{ content: string }>(
        'SELECT m.content FROM messages m JOIN runs r ON r.trigger_message_id = m.id WHERE r.id = $1 AND r.status = ANY($2::text[])',
        [round.runId, REGENERABLE_STATUSES],
      );
      const input = source.rows[0]?.content;
      if (input === undefined) throw new DomainError('VERSION_NOT_FOUND');
      const run = await queueRun(tx, { botId: null, conversationId, input, triggerMessageId: round.messageId, at, enforceLimit: true });
      await this.pathChanged(tx, conversationId, at);
      return (await readRunViews(tx, [run]))[0]!;
    });
  }

  /**
   * Retroceder até aqui (F3): o caminho visível passa a terminar na resposta `runId` do caminho ativo, que precisa ter rodadas depois dela. Nada é
   * apagado: o corte guarda a primeira rodada retrocedida, e enviar uma mensagem nova a cria como versão ao lado dela. Lança RATE_LIMITED,
   * SESSION_NOT_FOUND, CONVERSATION_BUSY e VERSION_NOT_FOUND. Devolve o snapshot com o caminho novo.
   */
  async rewind(ref: SessionRef, runId: string): Promise<ConversationSnapshot> {
    this.consumeControl(ref);
    const at = this.now();
    await withTransaction(this.pool, async (tx) => {
      const conversationId = await this.lockIdleSession(tx, ref);
      const { rounds } = await readActivePath(tx, conversationId);
      const index = rounds.findIndex((round) => round.runId === BigInt(runId).toString());
      const next = rounds[index + 1];
      if (index === -1 || next === undefined) throw new DomainError('VERSION_NOT_FOUND');
      await tx.query('UPDATE conversations SET rewound_run_id = $2, rewound_message_id = $3 WHERE id = $1', [conversationId, rounds[index]!.runId, next.messageId]);
      await recordConversationEvent(tx, conversationId, 'path', '0', at);
    });
    return this.snapshot(ref);
  }

  /** Restaurar (F3): desfaz o retrocesso em vigor e devolve o caminho inteiro. Lança RATE_LIMITED, SESSION_NOT_FOUND, CONVERSATION_BUSY e VERSION_NOT_FOUND (sem retrocesso). */
  async restore(ref: SessionRef): Promise<ConversationSnapshot> {
    this.consumeControl(ref);
    const at = this.now();
    await withTransaction(this.pool, async (tx) => {
      const conversationId = await this.lockIdleSession(tx, ref);
      if ((await readActivePath(tx, conversationId)).rewound === null) throw new DomainError('VERSION_NOT_FOUND');
      await this.pathChanged(tx, conversationId, at);
    });
    return this.snapshot(ref);
  }

  /**
   * Escolher versão (F4): leva o caminho à versão de mensagem ou de resposta pedida, que precisa ser irmã de uma rodada do caminho inteiro (a
   * mensagem com o mesmo pai de uma mensagem do caminho; a resposta sobre uma mensagem do caminho). A escolha sobe a versão ao topo da ordem do
   * grupo dela, e abaixo dela vale a última escolha feita naquele ramo (`path.ts`). Lança RATE_LIMITED, SESSION_NOT_FOUND, CONVERSATION_BUSY e
   * VERSION_NOT_FOUND. Devolve o snapshot com o caminho novo.
   */
  async chooseVersion(ref: SessionRef, target: ChooseVersionRequest): Promise<ConversationSnapshot> {
    this.consumeControl(ref);
    const at = this.now();
    await withTransaction(this.pool, async (tx) => {
      const conversationId = await this.lockIdleSession(tx, ref);
      const { full } = await readActivePath(tx, conversationId);
      if ('messageId' in target) {
        const found = await tx.query<{ parent: string | null }>(
          "SELECT parent_run_id::text AS parent FROM messages WHERE id = $1 AND conversation_id = $2 AND opens_round AND status <> 'discarded'",
          [target.messageId, conversationId],
        );
        const row = found.rows[0];
        if (!row || (row.parent !== null && !full.some((round) => round.runId === row.parent))) throw new DomainError('VERSION_NOT_FOUND');
        await tx.query("UPDATE messages SET version_seq = nextval('conversation_version_seq') WHERE id = $1", [target.messageId]);
      } else {
        const found = await tx.query<{ message: string | null }>('SELECT trigger_message_id::text AS message FROM runs WHERE id = $1 AND conversation_id = $2', [target.runId, conversationId]);
        const message = found.rows[0]?.message ?? null;
        if (message === null || !full.some((round) => round.messageId === message)) throw new DomainError('VERSION_NOT_FOUND');
        await tx.query("UPDATE runs SET version_seq = nextval('conversation_version_seq') WHERE id = $1", [target.runId]);
      }
      await this.pathChanged(tx, conversationId, at);
    });
    return this.snapshot(ref);
  }

  /**
   * Grava a preferência de modelo e effort da conversa (troca no composer): vale até nova troca e não altera o padrão do
   * bot. Lança MODEL_UNAVAILABLE ou VALIDATION_FAILED (effort fora dos níveis do modelo). Devolve a escolha resolvida.
   */
  async setPreference(ref: ConversationRef, model: string, effort: EffortLevel | null): Promise<ModelChoiceView> {
    const conversation = await this.conversationOf(this.pool, ref);
    await this.models.validateSelection(model, effort);
    await this.pool.query('UPDATE conversations SET preferred_model = $2, preferred_effort = $3 WHERE id = $1', [conversation.id, model, effort]);
    return resolveModelChoice(this.pool, conversation.id);
  }

  /** O modelo e o effort padrão do Chat geral (T23); `model` nulo enquanto o dono não definiu (o chat geral não deixa conversar sem ele). */
  sessionDefault(): Promise<ModelChoiceView> {
    return readSessionDefault(this.pool);
  }

  /**
   * Define o modelo e o effort padrão do Chat geral: toda sessão sem preferência própria começa com eles. O modelo é obrigatório (não há
   * "sem modelo": o padrão existe justamente para o chat nunca ficar sem um) e confere com a lista do provedor e os níveis de effort do
   * modelo. Lança MODEL_UNAVAILABLE ou VALIDATION_FAILED (campo `effort`). Audita quem mudou e para qual modelo.
   */
  async setSessionDefault(model: string, effort: EffortLevel | null, origin: RequestOrigin): Promise<ModelChoiceView> {
    await this.models.validateSelection(model, effort);
    const at = this.now();
    await withTransaction(this.pool, async (tx) => {
      await tx.query(
        `INSERT INTO general_chat_settings (singleton, model, effort, updated_at) VALUES (true, $1, $2, $3)
         ON CONFLICT (singleton) DO UPDATE SET model = excluded.model, effort = excluded.effort, updated_at = excluded.updated_at`,
        [model, effort, at],
      );
      await recordAudit(tx, { action: 'chat.default_model_set', outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: 'general_chat', details: { model, effort } }, at);
    });
    return this.sessionDefault();
  }
}
