// Grava na conversa um cartão que é SÓ do dono (proposta de rotina, proposta de alteração de rotina): ferramentas internas do bot os criam
// para o dono confirmar na tela, e nenhuma delas executa o efeito sozinha (SEC-03: a confirmação do dono é o controle).
//
// `content` fica vazio de propósito: o cartão não entra na busca do histórico nem no contexto do modelo (ver `OWNER_ONLY_CARDS` em
// `context.ts`); o bot sabe do que propôs pelo resultado da própria ferramenta. A gravação e o evento do SSE vão na mesma transação, então
// quem acompanha a conversa nunca vê um evento sem a linha.
import type { SystemCard } from '@aion/shared';
import { recordConversationEvent } from '../conversation/events';
import { withTransaction, type Pool } from '../db/pool';

/** Grava o cartão `card` na conversa, como mensagem de sistema da execução `runId`, junto do evento do SSE (ver o cabeçalho). */
export async function insertOwnerCard(pool: Pool, { conversationId, runId, card, at }: { conversationId: string; runId: string; card: SystemCard; at: Date }): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const message = await tx.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, content, data, created_at)
       VALUES ($1, $2, 'system', 'card', 'done', '', $3, $4) RETURNING id::text AS id`,
      [conversationId, runId, JSON.stringify(card), at],
    );
    await recordConversationEvent(tx, conversationId, 'message', (message.rows[0] as { id: string }).id, at);
  });
}
