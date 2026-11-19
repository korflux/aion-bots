// Job diário de limpeza de uploads abandonados e de rascunhos devolvidos vencidos (phase 4, F5: mesmo prazo de 24 horas), sem nomes ou conteúdo nos logs.
import type { PgBoss } from 'pg-boss';
import type { Queryable } from '../db/pool';
import type { Logger } from '../logging';
import { purgeExpiredDrafts } from '../conversation/complements';
import { purgePendingAttachments } from './lifecycle';
export const ATTACHMENT_RETENTION_QUEUE = 'attachments.retention';
export const ATTACHMENT_RETENTION_CRON = '0 4 * * *';

/** Usa o mesmo molde de retenção do worker, incluindo recuperação de uma agenda perdida. */
export async function startAttachmentRetention(boss: PgBoss, pool: Queryable, logger: Logger): Promise<void> {
  await boss.createQueue(ATTACHMENT_RETENTION_QUEUE);
  await boss.work(ATTACHMENT_RETENTION_QUEUE, async () => {
    const drafts = await purgeExpiredDrafts(pool, new Date());
    const removed = await purgePendingAttachments(pool);
    logger.info({ removed, drafts }, 'retenção de anexos pendentes concluída');
    return { removed, drafts };
  });
  await boss.schedule(ATTACHMENT_RETENTION_QUEUE, ATTACHMENT_RETENTION_CRON, null, { tz: 'America/Sao_Paulo', missed: 'once' });
}
