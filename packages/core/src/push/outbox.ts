// Caixa de saída dos pushes (T10): o ponto único que registra "este evento precisa de um aviso". Quem muda o estado de uma execução ou de
// uma aprovação chama `enqueuePushEvent` DENTRO da mesma transação que grava o desfecho (executor: concluída, falha e pausa para
// aprovação; serviço de aprovações: expiração). Assim o aviso e o desfecho nascem juntos ou não nascem: uma queda entre os dois não perde
// o push, e um desfecho que a transação desfez nunca gera aviso. Quem envia é o `PushDispatcher`, no worker.
//
// A linha guarda só ids. O título (nome do bot) e o corpo (tipo) saem na hora do envio, e o conteúdo da conversa nunca é copiado.
import type { PushEventKind } from '@aion/shared';
import { lastVisibleRunMessageSql } from '../conversation/views';
import type { Queryable } from '../db/pool';

/**
 * Registra o evento da execução. A mensagem que o toque abre é a ÚLTIMA da execução que o dono enxerga na conversa (cartão ou resposta
 * do bot): no pedido de aprovação e na expiração é o cartão da aprovação, na falha é o cartão de falha ou de limite, e na conclusão é
 * a resposta final. Sem nenhum dispositivo registrado a linha nem é criada (o que dispensa limpeza quando o push nunca foi ativado).
 */
export async function enqueuePushEvent(tx: Queryable, kind: PushEventKind, runId: string, at: Date): Promise<void> {
  await tx.query(
    `INSERT INTO push_events (kind, bot_id, run_id, message_id, created_at)
     SELECT $1, r.bot_id, r.id,
            ${lastVisibleRunMessageSql('r.id')},
            $3
     FROM runs r
     WHERE r.id = $2 AND EXISTS (SELECT 1 FROM push_devices)`,
    [kind, runId, at],
  );
}
