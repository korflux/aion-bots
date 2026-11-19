// Presença e leitura por conversa (phase 3, T2; F1/A2; NOTIF-01): a fonte única de quem GRAVA (a API, pela escrita do navegador) e de quem
// CONSULTA (o worker antes de avisar, T3; os resumos com `unread`, T5).
//
// Regras (spec, Suposições 3 a 5 e Contratos):
// - A presença é por SESSÃO DE LOGIN (a do cookie, recebida da borda), uma linha por sessão: abrir outra conversa no mesmo aparelho move a
//   presença. Vale enquanto renovada há menos de `PRESENCE_TTL_MS` e enquanto a sessão não venceu (`sessions.expires_at`); revogar a sessão
//   apaga a linha (cascade da 0021).
// - A leitura é por conversa e só avança (GREATEST no banco, à prova de requisições fora de ordem entre aparelhos).
// - Anti-IDOR: a conversa precisa existir (bot existente, arquivado ou não, ou sessão do Chat geral ainda não apagada); a mensagem de
//   `readThrough` precisa pertencer a ela.
// - Sem auditoria e sem log de conteúdo: é um sinal de alto volume e sem risco (Contratos), e só ids passam por aqui.
import { PRESENCE_TTL_MS, PRESENCE_WRITES_PER_MINUTE, type PresenceUpdate } from '@aion/shared';
import { KeyedSlidingWindowLimiter } from '../credentials/rate-limit';
import { withTransaction, type Pool, type Queryable } from '../db/pool';
import { DomainError } from '../errors';

export interface PresenceServiceOptions {
  pool: Pool;
  /** Relógio injetável: os testes provam o vencimento de 45 s e o limite por minuto sem esperar. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------------------------
// Consultas para o envio de avisos (T3) e o "não lido" (T5)
// ---------------------------------------------------------------------------------------------

/**
 * Existe presença VÁLIDA nesta conversa em qualquer sessão no instante `at`? Válida = renovada há menos de `PRESENCE_TTL_MS` e de uma sessão
 * que ainda não venceu. `conversationId` é o id interno da conversa (`conversations.id`), o mesmo de `push_events.conversation_id`.
 */
export async function hasLivePresence(db: Queryable, conversationId: string, at: Date): Promise<boolean> {
  const found = await db.query<{ live: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM conversation_presence p JOIN sessions s ON s.id = p.session_id
       WHERE p.conversation_id = $1 AND p.renewed_at > $2 AND s.expires_at > $3
     ) AS live`,
    [conversationId, new Date(at.getTime() - PRESENCE_TTL_MS), at],
  );
  return found.rows[0]?.live === true;
}

/** Posição de leitura da conversa (id da mensagem mais recente vista, como texto), ou nulo se nunca foi lida ou a conversa não existe. */
export async function readThroughOf(db: Queryable, conversationId: string): Promise<string | null> {
  const found = await db.query<{ read_through: string | null }>(
    'SELECT read_through_message_id::text AS read_through FROM conversations WHERE id = $1',
    [conversationId],
  );
  return found.rows[0]?.read_through ?? null;
}

/**
 * Predicado SQL "esta mensagem é uma novidade visível da conversa" (`m` é a linha de `messages`): a resposta CONCLUÍDA do bot (`text` do assistente em
 * `done`) ou um cartão de sistema (todo cartão é visível ao dono e nasce `done`). Não são novidade as mensagens do dono, o texto ainda em escrita
 * (`streaming`), as atividades de ferramenta nem o descartado. FONTE ÚNICA: a bolinha de não lido (`hasUnreadSql`) e a prévia da última novidade na lista de
 * bots (`BotService.list`, phase 5 T5) concordam sobre o que a conversa tem de novo porque as duas leem daqui.
 * Os avisos `routine_confirmed`, `routine_refused` e `routine_edited` não são novidade: registram o que o PRÓPRIO dono acabou de fazer (confirmar, recusar ou
 * editar uma rotina do bot) e existem para o bot saber disso. Já o cartão de rotina criada ou alterada pelo bot (`routine_proposal`, `routine_change`) é novidade.
 */
export const VISIBLE_NEWS_SQL = "((m.kind = 'text' AND m.role = 'assistant' AND m.status = 'done') OR (m.kind = 'card' AND coalesce(m.data->>'type', '') NOT IN ('objective_updated', 'routine_confirmed', 'routine_refused', 'routine_edited')))";

/**
 * Expressão SQL (booleana) "esta conversa tem novidade não lida" (T5; F4/A7; Suposição 5 da spec): FONTE ÚNICA da regra, usada pela lista de bots e
 * pela lista de sessões do Chat geral, cada uma no SELECT que já monta a lista (uma subconsulta por linha no índice `messages_timeline`, sem N+1).
 *
 * Novidade = mensagem posterior à posição de leitura que seja a resposta CONCLUÍDA do bot (`text` do assistente em `done`) ou um cartão de sistema
 * (todo cartão é visível ao dono e nasce `done`). Não contam as mensagens do dono, o texto ainda em escrita (`streaming`, que passa a contar quando
 * termina), as atividades de ferramenta nem o descartado. Conversa sem leitura gravada (nunca aberta desde a 0021) compara com 0: com novidade,
 * conta como não lida. O silenciamento de avisos não entra aqui, de propósito (silenciar não tira a bolinha).
 *
 * `conversationRef` é a referência SQL à linha de `conversations` da consulta (ex.: `c`), escrita pelo código e nunca vinda do cliente.
 */
export const hasUnreadSql = (conversationRef: string): string =>
  `EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = ${conversationRef}.id
             AND m.id > coalesce(${conversationRef}.read_through_message_id, 0)
             AND ${VISIBLE_NEWS_SQL})`;

/** A conversa já foi lida até `messageId` (inclusive) ou além? Base do descarte "já lido" do envio (T3). */
export async function isReadThrough(db: Queryable, conversationId: string, messageId: string): Promise<boolean> {
  const found = await db.query<{ read: boolean }>(
    'SELECT coalesce(read_through_message_id >= $2::bigint, false) AS read FROM conversations WHERE id = $1',
    [conversationId, messageId],
  );
  return found.rows[0]?.read === true;
}

// ---------------------------------------------------------------------------------------------
// Escrita (borda HTTP)
// ---------------------------------------------------------------------------------------------

export class PresenceService {
  private readonly pool: Pool;
  private readonly now: () => Date;
  /** Um limitador por sessão de login (30 escritas por minuto cada). */
  private readonly limiter: KeyedSlidingWindowLimiter;

  constructor({ pool, now = () => new Date() }: PresenceServiceOptions) {
    this.pool = pool;
    this.now = now;
    this.limiter = new KeyedSlidingWindowLimiter({ max: PRESENCE_WRITES_PER_MINUTE, windowMs: 60_000, now });
  }

  /**
   * Aplica uma escrita de presença e leitura da sessão `sessionId` (a do cookie). Lança RATE_LIMITED, NOT_FOUND (conversa inexistente) e
   * VALIDATION_FAILED (`readThrough` que não é mensagem desta conversa). Tudo numa transação que trava a conversa em modo compartilhado:
   * a exclusão do bot ou a retenção do Chat geral espera ou acontece antes, nunca no meio (sem chave estrangeira quebrada).
   */
  async update(sessionId: string, input: PresenceUpdate): Promise<void> {
    // Conta a escrita no limite da sessão ANTES de qualquer consulta ao banco (abuso custa o mínimo).
    this.limiter.consume(sessionId);
    const at = this.now();
    await withTransaction(this.pool, async (tx) => {
      const conversation = await tx.query<{ id: string }>(
        input.conversationKind === 'bot'
          ? 'SELECT id FROM conversations WHERE bot_id = $1 FOR SHARE'
          : 'SELECT id FROM conversations WHERE id = $1 AND bot_id IS NULL FOR SHARE',
        [input.conversationId],
      );
      const conversationId = conversation.rows[0]?.id;
      if (!conversationId) throw new DomainError('NOT_FOUND');

      const readThrough = input.readThrough ?? null;
      if (readThrough !== null) {
        const owned = await tx.query('SELECT 1 FROM messages WHERE id = $1::bigint AND conversation_id = $2', [readThrough, conversationId]);
        if (owned.rowCount === 0) throw new DomainError('VALIDATION_FAILED', { fields: [{ field: 'readThrough', reason: 'Mensagem fora da conversa.' }] });
        // GREATEST ignora o nulo: a primeira leitura grava o valor, as seguintes só avançam.
        await tx.query('UPDATE conversations SET read_through_message_id = GREATEST(read_through_message_id, $2::bigint) WHERE id = $1', [
          conversationId,
          readThrough,
        ]);
      }

      if (input.present) {
        // INSERT ... SELECT a partir da sessão: se ela foi revogada entre a autenticação e aqui, nada é gravado (sem erro de chave estrangeira).
        await tx.query(
          `INSERT INTO conversation_presence (session_id, conversation_id, renewed_at)
           SELECT id, $2, $3 FROM sessions WHERE id = $1
           ON CONFLICT (session_id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id, renewed_at = EXCLUDED.renewed_at`,
          [sessionId, conversationId, at],
        );
      } else {
        // Só encerra se a presença ainda é desta conversa: o término atrasado da conversa anterior não apaga a presença da atual.
        await tx.query('DELETE FROM conversation_presence WHERE session_id = $1 AND conversation_id = $2', [sessionId, conversationId]);
      }
    });
  }
}
