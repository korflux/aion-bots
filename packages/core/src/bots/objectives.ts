// Fonte única do objetivo: trava o bot antes da posse, valida evidências materializadas e grava revisão/cartão/eventos juntos.
import { objectiveUpdateSchema, type ObjectiveUpdate, type ObjectiveView, type ObjectiveCard } from '@aion/shared';
import { recordAudit } from '../audit';
import type { RequestOrigin } from '../auth/service';
import { recordConversationEvent } from '../conversation/events';
import { withTransaction, type Pool, type Queryable } from '../db/pool';
import { DomainError } from '../errors';
import { KeyedSlidingWindowLimiter } from '../credentials/rate-limit';
import { holdLease } from '../runs/lease';

interface ObjectiveRow { content: string; version: number; invitation_presented_at: Date | null; updated_at: Date | null; undo_barrier_message_id: string }
/** Conversão pública não expõe evidências históricas ou barreira interna. */
const viewOf = (row: ObjectiveRow): ObjectiveView => ({ content: row.content, version: row.version, invitationPresented: row.invitation_presented_at !== null, updatedAt: row.updated_at?.toISOString() ?? null });

/** Leitura comum para snapshot, SSE, editor e preparação dinâmica, sem inventar objetivo. */
export async function readBotObjective(db: Queryable, botId: string): Promise<ObjectiveView> {
  const found = await db.query<ObjectiveRow>('SELECT content, version, invitation_presented_at, updated_at, undo_barrier_message_id FROM bot_objectives WHERE bot_id=$1', [botId]);
  if (!found.rows[0]) throw new DomainError('BOT_NOT_FOUND');
  return viewOf(found.rows[0]);
}

export class ObjectiveService {
  private readonly controls: KeyedSlidingWindowLimiter;
  /** Controles do dono têm a mesma cota por conversa dos controles existentes, sem afetar a ferramenta sob lease. */
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {
    this.controls = new KeyedSlidingWindowLimiter({ max: 60, windowMs: 60000, now });
  }

  /** Ordem de lock comum ao formulário/owner e ferramenta; nenhuma chamada de modelo dentro da transação. */
  private async lock(db: Queryable, botId: string): Promise<{ row: ObjectiveRow; conversationId: string; archived: boolean }> {
    const bot = (await db.query<{ archived_at: Date | null }>('SELECT archived_at FROM bots WHERE id=$1 FOR UPDATE', [botId])).rows[0];
    if (!bot) throw new DomainError('BOT_NOT_FOUND');
    const row = (await db.query<ObjectiveRow>('SELECT content, version, invitation_presented_at, updated_at, undo_barrier_message_id FROM bot_objectives WHERE bot_id=$1 FOR UPDATE', [botId])).rows[0];
    const conversationId = (await db.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id=$1', [botId])).rows[0]?.id;
    if (!row || !conversationId) throw new DomainError('BOT_NOT_FOUND');
    return { row, conversationId, archived: bot.archived_at !== null };
  }

  /** Uma única sessão apresenta o convite; arquivado/objetivo já definido não consome o convite. */
  async presentInvitation(botId: string): Promise<{ objective: ObjectiveView; presentedNow: boolean }> {
    this.controls.consume(botId.toLowerCase());
    return withTransaction(this.pool, async (tx) => {
      const { row, conversationId, archived } = await this.lock(tx, botId);
      if (archived || row.content !== '' || row.invitation_presented_at !== null) return { objective: viewOf(row), presentedNow: false };
      const at = this.now();
      await tx.query('UPDATE bot_objectives SET invitation_presented_at=$2 WHERE bot_id=$1', [botId, at]);
      await recordConversationEvent(tx, conversationId, 'objective', '0', at);
      return { objective: viewOf({ ...row, invitation_presented_at: at }), presentedNow: true };
    });
  }

  /** Só mensagens do dono materializadas por uma execução iniciada são evidência; anexos/rotinas/resultados nunca são autoridade. */
  async updateAsBot(botId: string, input: ObjectiveUpdate, context: { conversationId: string; runId: string; leaseOwner: string }): Promise<ObjectiveView & { status: 'updated' | 'unchanged' }> {
    const checked = objectiveUpdateSchema.safeParse(input);
    if (!checked.success) throw new DomainError('VALIDATION_FAILED');
    const { content, expectedVersion, sourceMessageIds } = checked.data;
    return withTransaction(this.pool, async (tx) => {
      const { row, conversationId } = await this.lock(tx, botId);
      if (conversationId !== context.conversationId) throw new DomainError('VALIDATION_FAILED');
      await holdLease(tx, context.runId, context.leaseOwner);
      const run = await tx.query('SELECT 1 FROM runs WHERE id=$1 AND bot_id=$2 AND conversation_id=$3', [context.runId, botId, conversationId]);
      if (!run.rowCount) throw new DomainError('VALIDATION_FAILED');
      const evidence = await tx.query<{ id: string }>(`SELECT m.id::text FROM messages m JOIN runs r ON r.id=m.run_id
        WHERE m.conversation_id=$1 AND m.id=ANY($2::bigint[]) AND m.role='user' AND m.kind='text' AND m.status='done' AND char_length(btrim(m.content)) > 0
          AND r.started_at IS NOT NULL`, [conversationId, sourceMessageIds]);
      if (evidence.rowCount !== sourceMessageIds.length) throw new DomainError('VALIDATION_FAILED');
      if (content === row.content) return { ...viewOf(row), status: 'unchanged' as const };
      if (row.version !== expectedVersion) throw new DomainError('OBJECTIVE_CONFLICT');
      if (row.undo_barrier_message_id !== '0' && !sourceMessageIds.some((id) => BigInt(id) > BigInt(row.undo_barrier_message_id))) throw new DomainError('OBJECTIVE_CONFLICT');
      const at = this.now();
      const version = row.version + 1;
      await tx.query('INSERT INTO objective_versions(bot_id,version,content,source_message_ids,author,created_at) VALUES($1,$2,$3,$4,\'bot\',$5)', [botId, version, content, sourceMessageIds, at]);
      await tx.query('UPDATE bot_objectives SET content=$2,version=$3,updated_at=$4 WHERE bot_id=$1', [botId, content, version, at]);
      const card: ObjectiveCard = { type: 'objective_updated', content, version, previousVersion: row.version, status: 'applied' };
      const messageId = (await tx.query<{ id: string }>(`INSERT INTO messages(conversation_id,run_id,role,kind,status,data,created_at)
        VALUES($1,$2,'system','card','done',$3,$4) RETURNING id::text`, [conversationId, context.runId, JSON.stringify(card), at])).rows[0]!.id;
      await recordConversationEvent(tx, conversationId, 'message', messageId, at);
      await recordConversationEvent(tx, conversationId, 'objective', '0', at);
      await recordAudit(tx, { action: 'objective.updated', actor: 'system', outcome: 'success', target: botId, details: { version, runId: context.runId } }, at);
      return { ...viewOf({ ...row, content, version, updated_at: at }), status: 'updated' as const };
    });
  }

  /** Desfaz apenas a revisão daquele cartão; replay conserva a revisão criada e exige evidência nova na próxima adaptação. */
  async undo(botId: string, cardId: string, expectedVersion: number, origin: RequestOrigin): Promise<ObjectiveView> {
    this.controls.consume(botId.toLowerCase());
    return withTransaction(this.pool, async (tx) => {
      const { row, conversationId } = await this.lock(tx, botId);
      const card = (await tx.query<{ data: ObjectiveCard }>("SELECT data FROM messages WHERE id=$1 AND conversation_id=$2 AND kind='card' AND data->>'type'='objective_updated' FOR UPDATE", [cardId, conversationId])).rows[0]?.data;
      if (!card) throw new DomainError('OBJECTIVE_UPDATE_NOT_FOUND');
      if (card.status === 'undone') return viewOf(row);
      if (row.version !== expectedVersion || row.version !== card.version) throw new DomainError('OBJECTIVE_CONFLICT');
      const content = card.previousVersion === 0 ? '' : (await tx.query<{ content: string }>('SELECT content FROM objective_versions WHERE bot_id=$1 AND version=$2', [botId, card.previousVersion])).rows[0]?.content;
      if (content === undefined) throw new DomainError('OBJECTIVE_UPDATE_NOT_FOUND');
      const barrier = (await tx.query<{ id: string }>("SELECT coalesce(max(id),0)::text AS id FROM messages WHERE conversation_id=$1 AND role='user' AND kind='text' AND status='done'", [conversationId])).rows[0]!.id;
      const at = this.now(); const version = row.version + 1;
      await tx.query("INSERT INTO objective_versions(bot_id,version,content,source_message_ids,author,created_at) VALUES($1,$2,$3,'{}','owner',$4)", [botId, version, content, at]);
      await tx.query('UPDATE bot_objectives SET content=$2,version=$3,updated_at=$4,undo_barrier_message_id=$5 WHERE bot_id=$1', [botId, content, version, at, barrier]);
      await tx.query('UPDATE messages SET data=$2 WHERE id=$1', [cardId, JSON.stringify({ ...card, status: 'undone', undoneVersion: version })]);
      await recordConversationEvent(tx, conversationId, 'message', cardId, at);
      await recordConversationEvent(tx, conversationId, 'objective', '0', at);
      await recordAudit(tx, { action: 'objective.undone', actor: 'owner', outcome: 'success', target: botId, ip: origin.ip, userAgent: origin.userAgent, details: { version, cardId } }, at);
      return viewOf({ ...row, content, version, updated_at: at, undo_barrier_message_id: barrier });
    });
  }
}
