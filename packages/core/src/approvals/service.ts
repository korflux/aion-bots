// Serviço de aprovações (F9 e F10; T7): FONTE ÚNICA das regras de estado das aprovações e das regras permitir/negar/perguntar. A
// API (resposta do dono, tela Aprovações, editor do bot) e o worker (executor e varredura de expiração) usam este serviço; nenhum
// outro código escreve em `approval_actions`, `bot_approval_rules` ou `approvals`.
//
// Ciclo de vida de um pedido (tabela `approvals`):
//   pending --(dono permite/nega)--> approved | denied --(executor retoma e consome)--> consumed_at preenchido
//   pending --(24 h sem resposta)--> expired        pending/approved/denied não consumido --(dono para a execução)--> cancelled
// A execução dona do pedido fica `waiting_approval` o tempo todo (ela segura a vaga do bot): a resposta do dono NÃO a muda de
// estado, só registra a decisão. O motor, ao ver uma execução `waiting_approval` com decisão não consumida (ou parada pedida),
// a reivindica e o executor retoma do ponto exato (ver `RunEngine.claimNext` e `RunExecutor.resumeApproval`).
//
// Chat geral (T12): o pedido de uma sessão tem `bot_id` nulo. A regra resolvida é só a global (sem regra de bot), e o dono responde
// apenas "permitir uma vez" ou "negar": uma resposta permanente ("sempre") não tem bot onde gravar a regra e é recusada no servidor
// (a regra permanente do chat geral é a global, definida na tela Aprovações).
//
// Atomicidade: cada mudança de estado de um pedido atualiza, NA MESMA TRANSAÇÃO, o pedido, o cartão da conversa (cópia do estado
// para a tela), a atividade que o representa, a execução e o evento do SSE. Assim a tela nunca vê um cartão pendente de um pedido
// que já foi decidido, e a resposta repetida do dono encontra sempre um estado coerente (idempotência da spec F9).
//
// Ordem de travas (evita impasse): pedido (`approvals`) e depois execução (`runs`). O executor trava a execução (posse) e só
// então INSERE o pedido novo, que ninguém mais conhece; a varredura e a resposta travam o pedido primeiro.
import {
  APPROVAL_TTL_MS,
  decisionAllows,
  type ApprovalCard,
  type ApprovalDecision,
  type ApprovalResponseSource,
  type ApprovalImpact,
  type ApprovalOutcome,
  type ApprovalRules,
  type ApprovalStatus,
  type BotRule,
  type BotRules,
  type GlobalRule,
  type ResolvedRule,
} from '@aion/shared';
import { recordAudit } from '../audit';
import type { RequestOrigin } from '../auth/service';
import { settleComplementsAtEnd } from '../conversation/complements';
import { recordConversationEvent } from '../conversation/events';
import { withTransaction, type Pool, type PoolClient, type Queryable } from '../db/pool';
import { DomainError } from '../errors';
import type { ChatToolCall } from '../models/chat-protocols';
import { enqueuePushEvent } from '../push/outbox';
import { settleRoutineRunCard } from '../routines/run-card';
import { resolveRule } from './rules';
import { summarizeArguments } from './summary';

/** Quem é a ação para a tela: slug do Composio, nomes legíveis e o app (toolkit) a que pertence. */
export interface ActionInfo {
  slug: string;
  label: string;
  appSlug: string;
  appName: string;
}

export interface ApprovalServiceOptions {
  pool: Pool;
  /** Relógio injetável: os testes fixam o tempo (expiração e datas). */
  now?: () => Date;
}

/** Linha de `approvals` como o serviço a lê (ids bigint chegam como texto). */
interface ApprovalRow {
  id: string;
  run_id: string;
  /** Nulo no pedido de uma sessão do chat geral. */
  bot_id: string | null;
  conversation_id: string;
  action_slug: string;
  step: number;
  activity_id: string;
  card_id: string | null;
  call: ChatToolCall;
  remaining: ChatToolCall[];
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  expires_at: Date;
}

const APPROVAL_COLUMNS = `id::text AS id, run_id::text AS run_id, bot_id, conversation_id, action_slug, step, activity_id::text AS activity_id,
  card_id::text AS card_id, call, remaining, status, decision, expires_at`;

/** O que o executor recebe ao retomar: a decisão do dono e tudo o necessário para seguir do ponto exato. */
export interface DecidedApproval {
  id: string;
  status: Extract<ApprovalStatus, 'approved' | 'denied'>;
  decision: ApprovalDecision;
  step: number;
  activityId: string;
  /**
   * O `slug` da AÇÃO que o dono foi chamado a aprovar, como gravado no pedido (`approvals.action_slug`). A retomada o compara com a ação do alvo que reencontra agora (E3, phase 15): a resposta
   * do dono vale só para ela, e um alvo que mudou no meio (outro slug do Composio, outra ferramenta) não herda a aprovação.
   */
  actionSlug: string;
  call: ChatToolCall;
  remaining: ChatToolCall[];
}

export interface CreateApprovalInput {
  /**
   * Impacto do servidor, independente dos parâmetros do modelo: a tabela de uma ação destrutiva de tabela, ou o id e o título do doc de uma exclusão de doc (decisão 23, A35), ambos lidos pelo
   * `inspect` da ferramenta depois da checagem de acesso. Vai ao cartão da conversa (`messages.data`), que é também a fonte do título em "Aguardando você" (`ActivityService.pending`): nenhuma
   * coluna nova de `approvals` nem campo na `call` gravada, que a retomada reexecuta.
   */
  impact?: ApprovalImpact;
  runId: string;
  /** Nulo na execução de uma sessão do chat geral. */
  botId: string | null;
  conversationId: string;
  action: ActionInfo;
  /**
   * Phase 13 (CONN-02): a conta do conector em que a ação executaria, pelo nome do dono ou pelo rótulo automático, como o executor a resolveu. Vira `accountLabel` no cartão (e, pela
   * `call` gravada, na lista "Aguardando você"). Ausente nas ações sem conta (as categorias destrutivas de tabelas); a regra de aprovação segue por ação e não olha a conta.
   */
  accountLabel?: string;
  /** Etapa do modelo e atividade (já gravada como `running`) que representam a chamada barrada. */
  step: number;
  activityId: string;
  call: ChatToolCall;
  /** Chamadas que o modelo pediu DEPOIS desta na mesma etapa: rodam, em ordem, quando a execução retomar. */
  remaining: ChatToolCall[];
}

/** Resultado e atividade de um pedido que não chegou a executar (texto que o bot recebe como resultado da ferramenta). */
export const NOT_EXECUTED_RESULTS = {
  denied: 'Ação negada pelo usuário. Ela não foi executada.',
  deniedByRule: 'Ação negada pela regra de aprovação. Ela não foi executada.',
  expired: 'A aprovação expirou sem resposta do dono. A ação não foi executada.',
  cancelled: 'A execução foi interrompida pelo dono antes da aprovação. A ação não foi executada.',
} as const;

/** Estado do cartão (cópia do pedido) depois de uma mudança. */
const cardPatch = (status: ApprovalStatus, decision: ApprovalDecision | null) => JSON.stringify({ status, decision });

export class ApprovalService {
  private readonly pool: Pool;
  private readonly now: () => Date;

  constructor({ pool, now = () => new Date() }: ApprovalServiceOptions) {
    this.pool = pool;
    this.now = now;
  }

  // ---------------------------------------------------------------------------------------------
  // Resolução da regra (decisão 8)
  // ---------------------------------------------------------------------------------------------

  /**
   * Registra a ação como VISTA (se o catálogo ainda não a pré-registrou, ver `registerCatalog`) e devolve a regra resolvida para o bot:
   * regra do bot, senão a global, senão perguntar. Sem bot (chat geral) vale só a global (neutra ou ausente pergunta). Chamada pelo
   * executor ANTES de gravar ou executar qualquer ação (C4).
   */
  async resolve(db: Queryable, botId: string | null, action: ActionInfo): Promise<ResolvedRule> {
    const at = this.now();
    const found = await db.query<{ global_rule: GlobalRule; bot_rule: BotRule | null }>(
      `INSERT INTO approval_actions (slug, app_slug, app_name, label, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (slug) DO UPDATE
         SET app_slug = EXCLUDED.app_slug, app_name = EXCLUDED.app_name, label = EXCLUDED.label, last_seen_at = EXCLUDED.last_seen_at
       RETURNING global_rule,
         (SELECT value FROM bot_approval_rules WHERE bot_id = $6::uuid AND action_slug = $1) AS bot_rule`,
      [action.slug, action.appSlug, action.appName, action.label, at, botId],
    );
    const row = found.rows[0] as { global_rule: GlobalRule; bot_rule: BotRule | null };
    return resolveRule(row.bot_rule, row.global_rule);
  }

  // ---------------------------------------------------------------------------------------------
  // Pedido de aprovação (executor)
  // ---------------------------------------------------------------------------------------------

  /**
   * Cria o pedido pendente e o cartão da conversa. Roda dentro da transação do executor (que já segura a posse da execução e
   * grava a atividade e a mudança de estado da execução junto), então pedido, cartão e pausa nascem juntos ou não nascem. O cartão mostra a conta do conector quando o executor a informa
   * (`accountLabel`, A9); o cartão gravado antes da phase 13 não a tem e segue válido. O impacto (a tabela ou o doc com o título, `input.impact`) é gravado no cartão como o servidor o leu, e
   * `ActivityService.pending` o relê dali para "Aguardando você" (A35); a resposta do dono só muda `status` e `decision` do cartão (`cardPatch`), então o impacto fica no cartão respondido.
   */
  async createPending(tx: Queryable, input: CreateApprovalInput): Promise<{ approvalId: string; cardId: string }> {
    const at = this.now();
    const expiresAt = new Date(at.getTime() + APPROVAL_TTL_MS);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO approvals (run_id, bot_id, conversation_id, action_slug, step, activity_id, call, remaining, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text AS id`,
      [
        input.runId,
        input.botId,
        input.conversationId,
        input.action.slug,
        input.step,
        input.activityId,
        JSON.stringify(input.call),
        JSON.stringify(input.remaining),
        at,
        expiresAt,
      ],
    );
    const approvalId = (inserted.rows[0] as { id: string }).id;
    const { params, omitted } = summarizeArguments(input.call.arguments);
    const card: ApprovalCard = {
      type: 'approval',
      approvalId,
      status: 'pending',
      decision: null,
      action: input.action.slug,
      actionLabel: input.action.label,
      appName: input.action.appName,
      ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
      ...(input.impact ? { impact: input.impact } : {}),
      params,
      omitted,
      expiresAt: expiresAt.toISOString(),
    };
    // `content` vazio de propósito: o cartão não entra na busca do histórico nem no contexto do modelo (ver `buildTurns`).
    const message = await tx.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, content, data, created_at)
       VALUES ($1, $2, 'system', 'card', 'done', '', $3, $4) RETURNING id::text AS id`,
      [input.conversationId, input.runId, JSON.stringify(card), at],
    );
    const cardId = (message.rows[0] as { id: string }).id;
    await tx.query('UPDATE approvals SET card_id = $2 WHERE id = $1', [approvalId, cardId]);
    await recordConversationEvent(tx, input.conversationId, 'message', cardId, at);
    return { approvalId, cardId };
  }

  /**
   * O executor retomou a execução: pega a decisão ainda não consumida (a marca como consumida, de uma vez) e a devolve com tudo
   * para seguir do ponto exato. Nulo se não há decisão a tratar.
   */
  async takeDecision(tx: Queryable, runId: string): Promise<DecidedApproval | null> {
    const taken = await tx.query<ApprovalRow>(
      `UPDATE approvals SET consumed_at = $2
       WHERE run_id = $1 AND status IN ('approved', 'denied') AND consumed_at IS NULL
       RETURNING ${APPROVAL_COLUMNS}`,
      [runId, this.now()],
    );
    const row = taken.rows[0];
    if (!row?.decision) return null;
    return {
      id: row.id,
      status: row.status as 'approved' | 'denied',
      decision: row.decision,
      step: row.step,
      activityId: row.activity_id,
      actionSlug: row.action_slug,
      call: row.call,
      remaining: row.remaining,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Resposta do dono (API)
  // ---------------------------------------------------------------------------------------------

  /**
   * Registra a resposta do dono ao cartão. Idempotente: repetir a MESMA decisão devolve o mesmo resultado sem efeito novo; outra
   * decisão depois de respondida é APPROVAL_NOT_PENDING; passado o prazo é APPROVAL_EXPIRED (e o pedido, se ainda constava
   * pendente, é encerrado agora). "Sempre permitir" e "negar sempre" gravam a regra no bot da execução, na mesma transação.
   * A retomada da execução é do worker (ver o cabeçalho).
   */
  async respond(approvalId: string, decision: ApprovalDecision, origin: RequestOrigin, source: ApprovalResponseSource = 'screen'): Promise<ApprovalOutcome> {
    // Phase 16 (SEC-07): a notificação só decide uma vez (`allow_once`) ou nega (`deny`); a regra permanente é só do app. Recusada antes de qualquer leitura ou efeito, no
    // servidor (o botão do service worker nem a oferece, mas o servidor não confia no cliente).
    if (source === 'notification' && (decision === 'allow_always' || decision === 'deny_always')) {
      throw new DomainError('VALIDATION_FAILED', { fields: [{ field: 'decision', reason: 'Pela notificação só vale permitir uma vez ou negar. A regra permanente se define no app.' }] });
    }
    const at = this.now();
    const result = await withTransaction(this.pool, async (tx): Promise<ApprovalOutcome | 'expired'> => {
      const found = await tx.query<ApprovalRow>(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = $1 FOR UPDATE`, [approvalId]);
      const row = found.rows[0];
      if (!row) throw new DomainError('NOT_FOUND');
      // Resposta permanente sem bot: não há onde gravar a regra. Recusada antes de qualquer efeito (e antes da idempotência: nunca foi aceita).
      if (row.bot_id === null && (decision === 'allow_always' || decision === 'deny_always')) {
        throw new DomainError('VALIDATION_FAILED', {
          fields: [{ field: 'decision', reason: 'No chat geral só vale permitir uma vez ou negar. A regra permanente é a global, na tela Aprovações.' }],
        });
      }

      if (row.status !== 'pending') {
        if (row.status === 'expired') return 'expired';
        // Mesma decisão já aplicada: nada a fazer (o dono clicou duas vezes, ou a rede repetiu o pedido).
        if (row.decision === decision && (row.status === 'approved' || row.status === 'denied')) {
          return { id: row.id, status: row.status, decision: row.decision, alreadyApplied: true };
        }
        throw new DomainError('APPROVAL_NOT_PENDING');
      }
      if (row.expires_at.getTime() <= at.getTime()) {
        await this.expireRow(tx, row, at);
        return 'expired';
      }

      const status = decisionAllows(decision) ? 'approved' : 'denied';
      await tx.query("UPDATE approvals SET status = $2, decision = $3, decided_at = $4 WHERE id = $1 AND status = 'pending'", [
        row.id,
        status,
        decision,
        at,
      ]);
      if (row.bot_id !== null && (decision === 'allow_always' || decision === 'deny_always')) {
        await tx.query(
          `INSERT INTO bot_approval_rules (bot_id, action_slug, value, updated_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (bot_id, action_slug) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [row.bot_id, row.action_slug, decision === 'allow_always' ? 'allow' : 'deny', at],
        );
      }
      await this.updateCard(tx, row, status, decision, at);
      await recordAudit(
        tx,
        {
          action: 'approval.respond',
          outcome: 'success',
          actor: 'owner',
          ip: origin.ip,
          userAgent: origin.userAgent,
          target: row.action_slug,
          details: { decision, approval: row.id, bot: row.bot_id, source },
        },
        at,
      );
      return { id: row.id, status, decision };
    });
    if (result === 'expired') throw new DomainError('APPROVAL_EXPIRED');
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // Fim de vida: expiração e cancelamento
  // ---------------------------------------------------------------------------------------------

  /** Cópia do estado do pedido no cartão da conversa, com o evento do SSE. */
  private async updateCard(
    tx: Queryable,
    row: Pick<ApprovalRow, 'card_id' | 'conversation_id'>,
    status: ApprovalStatus,
    decision: ApprovalDecision | null,
    at: Date,
  ): Promise<void> {
    if (row.card_id === null) return;
    await tx.query('UPDATE messages SET data = data || $2::jsonb WHERE id = $1', [row.card_id, cardPatch(status, decision)]);
    await recordConversationEvent(tx, row.conversation_id, 'message', row.card_id, at);
  }

  /** Fecha a atividade que esperava o pedido: falhou com o texto que o bot lê, e deixa de "aguardar aprovação". */
  private async settleWaitingActivity(
    tx: Queryable,
    row: Pick<ApprovalRow, 'activity_id' | 'conversation_id'>,
    result: string,
    at: Date,
  ): Promise<void> {
    const settled = await tx.query(
      `UPDATE messages SET status = 'failed', content = $2, data = data || '{"awaitingApproval": false}'::jsonb
       WHERE id = $1 AND status = 'running'`,
      [row.activity_id, result],
    );
    if (settled.rowCount) await recordConversationEvent(tx, row.conversation_id, 'message', row.activity_id, at);
  }

  /** Encerra UM pedido vencido: pedido, cartão, atividade e execução (que fica `expired`). Já dentro de uma transação. */
  private async expireRow(tx: Queryable, row: ApprovalRow, at: Date): Promise<void> {
    await tx.query("UPDATE approvals SET status = 'expired', decided_at = $2 WHERE id = $1 AND status = 'pending'", [row.id, at]);
    await this.updateCard(tx, row, 'expired', null, at);
    await this.settleWaitingActivity(tx, row, NOT_EXECUTED_RESULTS.expired, at);
    const run = await tx.query(
      `UPDATE runs SET status = 'expired', finished_at = $2, lease_until = NULL, lease_owner = NULL
       WHERE id = $1 AND status = 'waiting_approval'`,
      [row.run_id, at],
    );
    if (run.rowCount) {
      // Complementos enviados enquanto o pedido esperava (CONV-03): a execução terminou sem lê-los, então viram execução nova na fila.
      await settleComplementsAtEnd(tx, { id: row.run_id, conversation_id: row.conversation_id, bot_id: row.bot_id }, 'expired', at);
      await recordConversationEvent(tx, row.conversation_id, 'run', row.run_id, at);
      // Execução de rotina que expirou esperando aprovação: o cartão da rotina conta o desfecho (sem cartão, não faz nada).
      await settleRoutineRunCard(tx, { id: row.run_id, conversation_id: row.conversation_id }, { state: 'expired', failureCode: null }, at);
      // Push "Aprovação expirada", na mesma transação da expiração (o toque abre o cartão da aprovação, agora expirado).
      await enqueuePushEvent(tx, 'approval_expired', row.run_id, at);
    }
    await recordAudit(
      tx,
      { action: 'approval.expire', outcome: 'success', actor: 'system', target: row.action_slug, details: { approval: row.id, bot: row.bot_id } },
      at,
    );
  }

  /**
   * Varredura de expiração (worker, de tempos em tempos): encerra os pedidos pendentes cujo prazo passou. Cada um numa transação
   * própria (um problema num pedido não segura os outros) e com `SKIP LOCKED` (duas varreduras não brigam). Devolve quantos
   * expiraram.
   */
  async expireDue(limit = 50): Promise<number> {
    let expired = 0;
    for (let index = 0; index < limit; index += 1) {
      const done = await withTransaction(this.pool, async (tx) => {
        const at = this.now();
        const found = await tx.query<ApprovalRow>(
          `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE status = 'pending' AND expires_at <= $1 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [at],
        );
        const row = found.rows[0];
        if (!row) return false;
        await this.expireRow(tx, row, at);
        return true;
      });
      if (!done) break;
      expired += 1;
    }
    return expired;
  }

  /**
   * A execução terminou (parada do dono, limite, falha) com um pedido ainda aberto: ele é cancelado, o cartão deixa de ser
   * respondível e a atividade que esperava fecha como não executada. Chamado pelo executor ao registrar o desfecho.
   */
  async cancelOpenForRun(tx: Queryable, runId: string, at: Date): Promise<void> {
    const open = await tx.query<ApprovalRow>(
      `UPDATE approvals SET status = 'cancelled', decided_at = $2, consumed_at = $2
       WHERE run_id = $1 AND (status = 'pending' OR (status IN ('approved', 'denied') AND consumed_at IS NULL))
       RETURNING ${APPROVAL_COLUMNS}`,
      [runId, at],
    );
    for (const row of open.rows) {
      await this.updateCard(tx, row, 'cancelled', null, at);
      await this.settleWaitingActivity(tx, row, NOT_EXECUTED_RESULTS.cancelled, at);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Leituras
  // ---------------------------------------------------------------------------------------------

  /** Pendências ainda respondíveis (badge da barra): pendentes e dentro do prazo. */
  async pendingCount(): Promise<number> {
    const found = await this.pool.query<{ total: string }>(
      "SELECT count(*) AS total FROM approvals WHERE status = 'pending' AND expires_at > $1",
      [this.now()],
    );
    return Number(found.rows[0]?.total ?? 0);
  }

  // ---------------------------------------------------------------------------------------------
  // Regras (F10)
  // ---------------------------------------------------------------------------------------------

  /**
   * Pré-registra as ações que o bot PODE chamar (o catálogo de ferramentas do Composio) para a tela Aprovações listá-las e o dono
   * definir a regra global ANTES do primeiro uso. A linha nasce com a regra `neutral`; se já existe, só o nome e o app são atualizados
   * pelo que o Composio informa: a regra global e `last_seen_at` (a data do último uso real) nunca são tocadas. Idempotente, uma única
   * instrução para o lote. Slugs repetidos no lote valem uma vez (o `ON CONFLICT` não aceita a mesma linha duas vezes).
   * ponytail: o catálogo é o mesmo conjunto "importante" que o bot recebe (`ComposioToolSource.catalog`); ações fora dele continuam só aparecendo
   * depois de usadas, trocar por uma busca sob demanda se o dono precisar de regra para o resto do catálogo do Composio.
   */
  async registerCatalog(actions: readonly ActionInfo[]): Promise<void> {
    const unique = [...new Map(actions.map((action) => [action.slug, action])).values()];
    if (unique.length === 0) return;
    await this.pool.query(
      `INSERT INTO approval_actions (slug, app_slug, app_name, label, first_seen_at, last_seen_at)
       SELECT t.slug, t.app_slug, t.app_name, t.label, $5, $5
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(slug, app_slug, app_name, label)
       ON CONFLICT (slug) DO UPDATE SET app_slug = EXCLUDED.app_slug, app_name = EXCLUDED.app_name, label = EXCLUDED.label`,
      [unique.map((a) => a.slug), unique.map((a) => a.appSlug), unique.map((a) => a.appName), unique.map((a) => a.label), this.now()],
    );
  }

  /** Ações conhecidas (as pré-registradas do catálogo e as já usadas), por app e nome, com a regra global e os bots que têm regra própria (tela Aprovações). */
  async listRules(): Promise<ApprovalRules> {
    const found = await this.pool.query<{
      slug: string;
      label: string;
      app_slug: string;
      app_name: string;
      global_rule: GlobalRule;
      bot_rules: { botId: string; botName: string; botColor: string; value: BotRule }[];
    }>(
      `SELECT a.slug, a.label, a.app_slug, a.app_name, a.global_rule,
              coalesce(
                json_agg(json_build_object('botId', b.id, 'botName', b.name, 'botColor', b.color, 'value', r.value) ORDER BY b.name)
                  FILTER (WHERE r.bot_id IS NOT NULL),
                '[]'::json) AS bot_rules
       FROM approval_actions a
       LEFT JOIN bot_approval_rules r ON r.action_slug = a.slug
       LEFT JOIN bots b ON b.id = r.bot_id
       GROUP BY a.slug
       ORDER BY a.app_name, a.label`,
    );
    return {
      actions: found.rows.map((row) => ({
        action: row.slug,
        label: row.label,
        appSlug: row.app_slug,
        appName: row.app_name,
        globalRule: row.global_rule,
        botRules: row.bot_rules,
      })),
    };
  }

  /** Altera a regra global de uma ação conhecida; vale na próxima chamada. NOT_FOUND se a ação nem consta do catálogo registrado nem foi usada. */
  async setGlobalRule(action: string, value: GlobalRule, origin: RequestOrigin): Promise<void> {
    const at = this.now();
    await withTransaction(this.pool, async (tx) => {
      const updated = await tx.query('UPDATE approval_actions SET global_rule = $2 WHERE slug = $1', [action, value]);
      if (updated.rowCount === 0) throw new DomainError('NOT_FOUND');
      await recordAudit(
        tx,
        {
          action: 'approval.rule',
          outcome: 'success',
          actor: 'owner',
          ip: origin.ip,
          userAgent: origin.userAgent,
          target: action,
          details: { scope: 'global', value },
        },
        at,
      );
    });
  }

  /**
   * Regra global para TODAS as ações conhecidas de uma vez (botões "Permitir tudo", "Perguntar tudo", "Negar tudo" e "Neutro tudo" da tela Aprovações).
   * Uma única instrução na transação da auditoria: ou todas mudam ou nenhuma. Devolve quantas ações foram alteradas.
   * ponytail: vale para o conjunto conhecido AGORA; uma ação que passar a existir depois (app novo, primeiro uso) nasce neutra. Trocar por uma regra
   *   "padrão" gravada à parte (lida pela resolução) se o dono precisar que o lote cubra também o que ainda não existe.
   */
  async setAllGlobalRules(value: GlobalRule, origin: RequestOrigin): Promise<number> {
    const at = this.now();
    return withTransaction(this.pool, async (tx) => {
      const updated = await tx.query('UPDATE approval_actions SET global_rule = $1', [value]);
      const count = updated.rowCount ?? 0;
      await recordAudit(
        tx,
        { action: 'approval.rule', outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: 'all', details: { scope: 'global', value, count } },
        at,
      );
      return count;
    });
  }

  /** Confere que o bot existe (BOT_NOT_FOUND), sem nunca confiar no id vindo do cliente. */
  private async requireBot(db: Queryable, botId: string): Promise<void> {
    const found = await db.query('SELECT 1 FROM bots WHERE id = $1', [botId]);
    if (found.rowCount === 0) throw new DomainError('BOT_NOT_FOUND');
  }

  /** Regras próprias do bot, com os nomes legíveis (seção "Aprovações do bot" do editor). */
  async listBotRules(botId: string): Promise<BotRules> {
    await this.requireBot(this.pool, botId);
    const found = await this.pool.query<{ slug: string; label: string; app_name: string; value: BotRule }>(
      `SELECT a.slug, a.label, a.app_name, r.value
       FROM bot_approval_rules r JOIN approval_actions a ON a.slug = r.action_slug
       WHERE r.bot_id = $1 ORDER BY a.app_name, a.label`,
      [botId],
    );
    return { rules: found.rows.map((row) => ({ action: row.slug, label: row.label, appName: row.app_name, value: row.value })) };
  }

  /** Define (ou altera) a regra própria do bot para uma ação conhecida. NOT_FOUND se a ação nem consta do catálogo registrado nem foi usada. */
  async setBotRule(botId: string, action: string, value: BotRule, origin: RequestOrigin): Promise<void> {
    const at = this.now();
    await withTransaction(this.pool, async (tx: PoolClient) => {
      await this.requireBot(tx, botId);
      const saved = await tx.query(
        `INSERT INTO bot_approval_rules (bot_id, action_slug, value, updated_at)
         SELECT $1, a.slug, $3, $4 FROM approval_actions a WHERE a.slug = $2
         ON CONFLICT (bot_id, action_slug) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [botId, action, value, at],
      );
      if (saved.rowCount === 0) throw new DomainError('NOT_FOUND');
      await recordAudit(
        tx,
        {
          action: 'approval.rule',
          outcome: 'success',
          actor: 'owner',
          ip: origin.ip,
          userAgent: origin.userAgent,
          target: action,
          details: { scope: 'bot', value, bot: botId },
        },
        at,
      );
    });
  }

  /**
   * Regra própria do bot em TODAS as ações conhecidas (botões "Permitir tudo", "Perguntar tudo" e "Negar tudo" da seção "Aprovações do bot"), mesmo as que a
   * lista do bot não mostra por ele ainda não ter regra nelas. Uma instrução só, na transação da auditoria. Devolve quantas ações ficaram com a regra.
   * ponytail: vale para o conjunto conhecido AGORA (ver `setAllGlobalRules`).
   */
  async setAllBotRules(botId: string, value: BotRule, origin: RequestOrigin): Promise<number> {
    const at = this.now();
    return withTransaction(this.pool, async (tx: PoolClient) => {
      await this.requireBot(tx, botId);
      const saved = await tx.query(
        `INSERT INTO bot_approval_rules (bot_id, action_slug, value, updated_at)
         SELECT $1::uuid, a.slug, $2::text, $3::timestamptz FROM approval_actions a
         ON CONFLICT (bot_id, action_slug) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [botId, value, at],
      );
      const count = saved.rowCount ?? 0;
      await recordAudit(
        tx,
        { action: 'approval.rule', outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: 'all', details: { scope: 'bot', value, bot: botId, count } },
        at,
      );
      return count;
    });
  }

  /** Remove TODAS as regras próprias do bot ("Neutro tudo"): volta a valer a global em cada ação. Idempotente (sem regra, não erra nem audita). Devolve quantas removeu. */
  async removeAllBotRules(botId: string, origin: RequestOrigin): Promise<number> {
    const at = this.now();
    return withTransaction(this.pool, async (tx: PoolClient) => {
      await this.requireBot(tx, botId);
      const removed = await tx.query('DELETE FROM bot_approval_rules WHERE bot_id = $1', [botId]);
      const count = removed.rowCount ?? 0;
      if (count === 0) return 0;
      await recordAudit(
        tx,
        { action: 'approval.rule', outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: 'all', details: { scope: 'bot', value: 'removed', bot: botId, count } },
        at,
      );
      return count;
    });
  }

  /** Remove a regra própria do bot: volta a valer a global. Idempotente (remover o que não existe não erra nem audita). */
  async removeBotRule(botId: string, action: string, origin: RequestOrigin): Promise<void> {
    const at = this.now();
    await withTransaction(this.pool, async (tx: PoolClient) => {
      await this.requireBot(tx, botId);
      const removed = await tx.query('DELETE FROM bot_approval_rules WHERE bot_id = $1 AND action_slug = $2', [botId, action]);
      if (removed.rowCount === 0) return;
      await recordAudit(
        tx,
        {
          action: 'approval.rule',
          outcome: 'success',
          actor: 'owner',
          ip: origin.ip,
          userAgent: origin.userAgent,
          target: action,
          details: { scope: 'bot', value: 'removed', bot: botId },
        },
        at,
      );
    });
  }
}
