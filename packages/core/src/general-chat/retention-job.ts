// Job diário de retenção das sessões do chat geral (spec decisão 17: sessões não salvas somem 7 dias após a última mensagem). Roda no
// worker, sobre o pg-boss, como o job da retenção da memória: a fila e o agendamento ficam no PostgreSQL, então um deploy no meio do dia
// não perde nem duplica a execução.
//
// O agendamento é gravado a cada subida do worker (o pg-boss faz upsert pelo nome da fila), em horário de Brasília e de madrugada, meia
// hora depois do job da memória (não disputam o banco). `missed: 'once'`: se o worker passou o horário fora do ar, roda UMA vez ao
// voltar, em vez de pular o dia.
import type { PgBoss } from 'pg-boss';
import type { Logger } from '../logging';
import type { GeneralChatService } from './service';

export const CHAT_RETENTION_QUEUE = 'chat.retention';
/** 03:30 todos os dias, no fuso do dono. */
export const CHAT_RETENTION_CRON = '30 3 * * *';
const RETENTION_TIMEZONE = 'America/Sao_Paulo';

/** Registra a fila, o consumidor (que apaga as sessões vencidas) e o agendamento diário. Chamado pelo worker depois de `startWorkerQueue`. */
export async function startChatRetention(boss: PgBoss, chat: Pick<GeneralChatService, 'purgeExpired'>, logger: Logger): Promise<void> {
  await boss.createQueue(CHAT_RETENTION_QUEUE);
  await boss.work(CHAT_RETENTION_QUEUE, async () => {
    const removed = await chat.purgeExpired();
    logger.info({ removed }, 'retenção das sessões do chat geral concluída');
    return { removed };
  });
  await boss.schedule(CHAT_RETENTION_QUEUE, CHAT_RETENTION_CRON, null, { tz: RETENTION_TIMEZONE, missed: 'once' });
}
