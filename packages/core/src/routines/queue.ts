// Tirar da fila do bot as execuções de rotina que ainda não começaram (F12 passo 4): pausar ou excluir a rotina, ou arquivar o bot.
// Uma execução que JÁ começou nunca passa por aqui (ela termina normalmente e pode ser parada por F7).
//
// A execução vira `cancelled` (e não é apagada): a fila da tela é feita de eventos da execução, e uma linha que some deixaria a
// bolha "Rotina <nome>" presa até o dono recarregar; com o estado terminal, o evento chega pelo SSE e a bolha sai. O horário previsto
// dela fica no histórico da rotina como `skipped` (pulada).
import { recordConversationEvent } from '../conversation/events';
import type { Queryable } from '../db/pool';

/** De quem são as execuções a cancelar: de uma rotina, ou de todas as rotinas de um bot. */
export type QueuedRoutineRuns = { routineId: string } | { botId: string };

/** Cancela as execuções `queued` de rotina do escopo, dentro da transação dada. Devolve quantas saíram da fila. */
export async function cancelQueuedRoutineRuns(tx: Queryable, scope: QueuedRoutineRuns, at: Date): Promise<number> {
  // Um dos dois filtros vem nulo e então não restringe (`coalesce` devolve a própria coluna): um SQL fixo para os dois escopos.
  const routineId = 'routineId' in scope ? scope.routineId : null;
  const botId = 'botId' in scope ? scope.botId : null;
  const cancelled = await tx.query<{ id: string; conversation_id: string }>(
    `UPDATE runs SET status = 'cancelled', finished_at = $1
     WHERE status = 'queued' AND routine_id IS NOT NULL AND routine_id = coalesce($2::uuid, routine_id) AND bot_id = coalesce($3::uuid, bot_id)
     RETURNING id::text AS id, conversation_id`,
    [at, routineId, botId],
  );
  if (cancelled.rows.length === 0) return 0;
  await tx.query("UPDATE routine_occurrences SET outcome = 'skipped' WHERE run_id = ANY($1::bigint[])", [cancelled.rows.map((row) => row.id)]);
  for (const row of cancelled.rows) await recordConversationEvent(tx, row.conversation_id, 'run', row.id, at);
  return cancelled.rows.length;
}

/**
 * Trava as rotinas do bot, em ordem de id, ANTES de o arquivamento travar o próprio bot. A ordem de trava do sistema é rotina e depois
 * bot: o agendador, "Executar agora" e a edição seguram a linha da rotina e só então travam o bot, em `queueRun`. O arquivamento fazia
 * o contrário (travava o bot e depois atualizava as rotinas), e uma rotina vencendo no instante do arquivamento fazia as duas
 * transações se esperarem: deadlock (40P01), com uma delas derrubada (R14). Chamado pelo `BotService` na mesma transação, antes da
 * trava do bot. O agendador pega as rotinas com `SKIP LOCKED`, então ele não espera aqui: pula as que o arquivamento já segura.
 */
export async function lockRoutinesOfBot(tx: Queryable, botId: string): Promise<void> {
  await tx.query('SELECT id FROM routines WHERE bot_id = $1 ORDER BY id FOR UPDATE', [botId]);
}

/**
 * Arquivar o bot pausa as rotinas ativas dele (spec decisão 16) e tira da fila o que ainda não começou. Desarquivar NÃO as retoma:
 * o dono decide. Chamado pelo `BotService` na mesma transação do arquivamento. Devolve quantas rotinas foram pausadas.
 */
export async function pauseRoutinesOfBot(tx: Queryable, botId: string, at: Date): Promise<number> {
  const paused = await tx.query("UPDATE routines SET status = 'paused', next_run_at = NULL, updated_at = $2 WHERE bot_id = $1 AND status = 'active'", [botId, at]);
  await cancelQueuedRoutineRuns(tx, { botId }, at);
  return paused.rowCount ?? 0;
}
