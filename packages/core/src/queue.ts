// Fila de jobs sobre PostgreSQL (pg-boss). Nesta task só existe a fila de sistema `system.ping`, que prova que
// o worker está conectado e consumindo; as filas de execução e rotinas entram nas tasks seguintes.
//
// O pg-boss mantém o próprio schema (`pgboss`) e as próprias migrations dentro do banco do Aion.
import { PgBoss } from 'pg-boss';
import { databaseErrorForLog, type Logger } from './logging';

/** Fila de saúde do sistema: o worker responde a cada job com `{ ok: true }`. */
export const SYSTEM_PING_QUEUE = 'system.ping';

/** Tipo do cliente da fila, reexportado para que api/worker não dependam do pg-boss diretamente. */
export type { PgBoss };

/** Cria o cliente da fila com a identidade do serviço para diagnóstico no PostgreSQL. */
export function createBoss(databaseUrl: string, applicationName: string): PgBoss {
  return new PgBoss({ connectionString: databaseUrl, application_name: applicationName });
}

/**
 * Liga o worker à fila: inicia o pg-boss (cria/atualiza o schema dele), garante a fila de sistema e registra
 * o consumidor. Erros do pg-boss são logados em vez de derrubar o processo por evento não tratado.
 */
export async function startWorkerQueue(boss: PgBoss, logger: Logger): Promise<void> {
  boss.on('error', (error) => logger.error({ err: databaseErrorForLog(error) }, 'erro no pg-boss'));
  await boss.start();
  await boss.createQueue(SYSTEM_PING_QUEUE);
  await boss.work(SYSTEM_PING_QUEUE, async () => ({ ok: true }));
  logger.info({ queue: SYSTEM_PING_QUEUE }, 'worker conectado à fila');
}
