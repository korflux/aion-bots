// Job diário de retenção das versões da memória (MEM-01: 90 dias, mínimo de 50 por memória). Roda no worker, sobre o pg-boss: a
// fila e o agendamento ficam no PostgreSQL, então um deploy no meio do dia não perde nem duplica a execução.
//
// O agendamento é gravado a cada subida do worker (o pg-boss faz upsert pelo nome da fila), em horário de Brasília e de madrugada.
// `missed: 'once'`: se o worker passou o horário fora do ar, roda UMA vez ao voltar, em vez de pular o dia.
import type { PgBoss } from 'pg-boss';
import type { Logger } from '../logging';
import type { MemoryService } from './service';

export const MEMORY_RETENTION_QUEUE = 'memory.retention';
/** 03:00 todos os dias, no fuso do dono. */
export const MEMORY_RETENTION_CRON = '0 3 * * *';
const RETENTION_TIMEZONE = 'America/Sao_Paulo';

/** Registra a fila, o consumidor (que roda a poda) e o agendamento diário. Chamado pelo worker depois de `startWorkerQueue`. */
export async function startMemoryRetention(boss: PgBoss, memory: Pick<MemoryService, 'purgeExpiredVersions'>, logger: Logger): Promise<void> {
  await boss.createQueue(MEMORY_RETENTION_QUEUE);
  await boss.work(MEMORY_RETENTION_QUEUE, async () => {
    const removed = await memory.purgeExpiredVersions();
    logger.info({ removed }, 'retenção das versões da memória concluída');
    return { removed };
  });
  await boss.schedule(MEMORY_RETENTION_QUEUE, MEMORY_RETENTION_CRON, null, { tz: RETENTION_TIMEZONE, missed: 'once' });
}
