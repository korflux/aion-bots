// Limpeza física compartilhada por exclusão de bot, retenção de sessão e pendentes.
import type { Queryable } from '../db/pool';

/** Cada lote é um único comando, preservando a transação do chamador e o timeout por statement. */
export async function eraseConversationAttachments(tx: Queryable, conversationId: string): Promise<{ count: number; bytes: number }> {
  let count = 0; let bytes = 0;
  for (;;) {
    const batch = await tx.query<{ count: string; bytes: string }>(`WITH removed AS (
      DELETE FROM attachments WHERE id IN (SELECT id FROM attachments WHERE conversation_id = $1 ORDER BY id LIMIT 100)
      RETURNING stored_bytes
    ) SELECT count(*)::text AS count, COALESCE(sum(stored_bytes),0)::text AS bytes FROM removed`, [conversationId]);
    const removed = Number(batch.rows[0]!.count);
    count += removed; bytes += Number(batch.rows[0]!.bytes);
    if (removed < 100) return { count, bytes };
  }
}

/**
 * Pendentes envelhecidos não têm vínculo a mensagem, execução nem complemento (o do complemento pendente espera a execução, e o do rascunho
 * devolvido vence com ele, em purgeExpiredDrafts); um envio concorrente ganha pela trava da linha.
 */
export async function purgePendingAttachments(pool: Queryable, now = new Date()): Promise<number> {
  let total = 0;
  const cutoff = new Date(now.getTime() - 24 * 3600_000);
  for (;;) {
    const batch = await pool.query(`DELETE FROM attachments WHERE id IN (
      SELECT id FROM attachments WHERE run_id IS NULL AND message_id IS NULL AND complement_id IS NULL AND created_at < $1 ORDER BY id LIMIT 100
    ) AND run_id IS NULL AND message_id IS NULL AND complement_id IS NULL AND created_at < $1`, [cutoff]);
    const removed = batch.rowCount ?? 0;
    total += removed;
    if (removed < 100) return total;
  }
}
