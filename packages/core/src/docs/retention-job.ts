// Job diário de retenção das versões dos docs (DOC-02: a retenção de MEM-01, 90 dias com mínimo de 50 versões por doc). Roda no worker, sobre o pg-boss: a fila e o agendamento ficam no
// PostgreSQL, então um deploy no meio do dia não perde nem duplica a execução. Molde de `memory/retention-job.ts`.
//
// O agendamento é gravado a cada subida do worker (o pg-boss faz upsert pelo nome da fila), em horário de Brasília e de madrugada, 15 minutos depois do da memória para os dois não
// disputarem o banco. `missed: 'once'`: se o worker passou o horário fora do ar, roda UMA vez ao voltar, em vez de pular o dia.
// Depois do rollback da 0051 o agendamento continua no pg-boss (ele vive fora do schema do app) e o job falha por falta da tabela até a fila ser removida ou a migration reaplicada.
import type { PgBoss } from 'pg-boss';
import type { Logger } from '../logging';
import type { DocService } from './service';

export const DOC_RETENTION_QUEUE = 'docs.retention';
/** 03:15 todos os dias, no fuso do dono. */
export const DOC_RETENTION_CRON = '15 3 * * *';
const RETENTION_TIMEZONE = 'America/Sao_Paulo';

/** Registra a fila, o consumidor (que roda a poda) e o agendamento diário. Chamado pelo worker depois de `startWorkerQueue`. */
export async function startDocRetention(boss: PgBoss, docs: Pick<DocService, 'purgeExpiredVersions'>, logger: Logger): Promise<void> {
  await boss.createQueue(DOC_RETENTION_QUEUE);
  await boss.work(DOC_RETENTION_QUEUE, async () => {
    const removed = await docs.purgeExpiredVersions();
    logger.info({ removed }, 'retenção das versões dos docs concluída');
    return { removed };
  });
  await boss.schedule(DOC_RETENTION_QUEUE, DOC_RETENTION_CRON, null, { tz: RETENTION_TIMEZONE, missed: 'once' });
}
