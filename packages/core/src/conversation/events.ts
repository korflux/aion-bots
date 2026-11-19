// Log de eventos da conversa: a ponte entre o worker (que escreve) e o SSE da API (que transmite).
//
// O log é de INVALIDAÇÃO: cada linha diz só "a mensagem X (ou a execução Y) mudou". Quem transmite lê o estado ATUAL da
// linha referenciada e o envia inteiro. Por isso:
// - reenviar ou retomar por `Last-Event-ID` é idempotente (aplicar o mesmo estado duas vezes dá o mesmo resultado);
// - um texto em streaming gera muitos eventos minúsculos, e nunca uma cópia do conteúdo;
// - a retomada nunca precisa de "offset" de texto: a linha já traz o texto completo até agora.
// ponytail: eventos nunca são apagados e o SSE consulta o banco a cada 500 ms (ver API). Acrescentar um job de limpeza de
// eventos antigos e trocar a consulta periódica por LISTEN/NOTIFY se o volume ou o número de abas abertas crescer.
import type { DraftEvent, MessageView, PathEvent, RunView, ObjectiveView, ContextState } from '@aion/shared';
import { readContextState } from './context-state';
import type { Pool, Queryable } from '../db/pool';
import { readBotObjective } from '../bots/objectives';
import { readDraftById } from './complements';
import { MESSAGE_COLUMNS, RUN_COLUMNS, readMessageViews, readRunViews, type MessageRow, type RunRow } from './views';

/**
 * draft (phase 4, F5): o rascunho devolvido da conversa mudou ou deixou de existir; `ref` é o id dele. path (phase 4, F1 a F4): o caminho ativo da
 * sessão mudou; `ref` é sempre 0 (eventos seguidos viram um só) e a tela relê o snapshot. Nenhum dos dois é novidade nem aviso.
 */
export type ConversationEventKind = 'message' | 'run' | 'draft' | 'path' | 'objective' | 'context';

/** Registra que uma linha mudou. Aceita o pool ou uma transação, para o evento nascer junto da mudança. */
export async function recordConversationEvent(
  db: Queryable,
  conversationId: string,
  kind: ConversationEventKind,
  ref: string,
  at: Date,
): Promise<void> {
  await db.query('INSERT INTO conversation_events (conversation_id, kind, ref, created_at) VALUES ($1, $2, $3, $4)', [
    conversationId,
    kind,
    ref,
    at,
  ]);
}

/** Id do último evento da conversa (`'0'` se não há nenhum): o ponto a partir do qual um snapshot é completado pelo SSE. */
export async function lastConversationEventId(db: Queryable, conversationId: string): Promise<string> {
  const row = await db.query<{ id: string }>(
    'SELECT coalesce(max(id), 0)::text AS id FROM conversation_events WHERE conversation_id = $1',
    [conversationId],
  );
  return row.rows[0]?.id ?? '0';
}

/** Uma atualização pronta para o SSE: o id do evento (vira `id:`), o tipo e o estado atual da linha. */
export type ConversationUpdate = { id: string } & (
  | { event: 'message'; data: MessageView }
  | { event: 'run'; data: RunView }
  | { event: 'draft'; data: DraftEvent }
  | { event: 'path'; data: PathEvent }
  | { event: 'objective'; data: ObjectiveView | null }
  | { event: 'context'; data: ContextState }
);

/** Monta a atualização de um tipo só com o estado lido; linha que sumiu (mensagem ou execução apagada) não vira atualização. */
function withData<E extends ConversationUpdate['event']>(id: string, event: E, data: Extract<ConversationUpdate, { event: E }>['data'] | undefined): ConversationUpdate | null {
  return data === undefined ? null : ({ id, event, data } as ConversationUpdate);
}

/** Quantas linhas distintas uma leitura devolve; acima disso o restante vem na leitura seguinte. */
const UPDATES_PER_READ = 200;

/**
 * Atualizações posteriores a `afterId`, uma por linha modificada (várias mudanças na mesma linha viram uma só, com o
 * estado atual) e na ordem da última mudança. `cursor` é o id a usar na próxima leitura.
 */
export async function readConversationUpdates(
  db: Pool,
  conversationId: string,
  afterId: string,
  /** Relógio do serviço: decide se o rascunho devolvido ainda vale (24 horas). */
  now: Date = new Date(),
): Promise<{ updates: ConversationUpdate[]; cursor: string }> {
  const changed = await db.query<{ id: string; kind: ConversationEventKind; ref: string }>(
    `SELECT max(id)::text AS id, kind, ref::text AS ref
     FROM conversation_events
     WHERE conversation_id = $1 AND id > $2
     GROUP BY kind, ref
     ORDER BY max(id)
     LIMIT $3`,
    [conversationId, afterId, UPDATES_PER_READ],
  );
  if (changed.rows.length === 0) return { updates: [], cursor: afterId };

  const messageIds = changed.rows.filter((row) => row.kind === 'message').map((row) => row.ref);
  const runIds = changed.rows.filter((row) => row.kind === 'run').map((row) => row.ref);
  const [messages, runs] = await Promise.all([
    messageIds.length === 0
      ? { rows: [] as MessageRow[] }
      : db.query<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 AND id = ANY($2::bigint[])`, [conversationId, messageIds]),
    runIds.length === 0
      ? { rows: [] as RunRow[] }
      : db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE conversation_id = $1 AND id = ANY($2::bigint[])`, [conversationId, runIds]),
  ]);
  const [messageViews, runViews] = await Promise.all([readMessageViews(db, messages.rows), readRunViews(db, runs.rows)]);
  const messageById = new Map(messageViews.map((row) => [row.id, row]));
  const runById = new Map(runViews.map((row) => [row.id, row]));

  // Rascunho: no máximo um por conversa, então uma leitura por evento basta; o que não existe mais vai como `draft: null` (a tela o tira).
  const drafts = new Map<string, DraftEvent>();
  for (const row of changed.rows) {
    if (row.kind === 'draft') drafts.set(row.ref, { id: row.ref, draft: await readDraftById(db, conversationId, row.ref, now) });
  }

  const bot = changed.rows.some((row) => row.kind === 'objective') ? (await db.query<{ bot_id: string | null }>('SELECT bot_id FROM conversations WHERE id=$1', [conversationId])).rows[0]?.bot_id : null;
  const objective = bot ? await readBotObjective(db, bot) : null;
  const context = changed.rows.some((row) => row.kind === 'context') ? await readContextState(db, conversationId) : undefined;
  const updates: ConversationUpdate[] = [];
  for (const row of changed.rows) {
    const update: ConversationUpdate | null =
      row.kind === 'message'
        ? withData(row.id, 'message', messageById.get(row.ref))
        : row.kind === 'run'
          ? withData(row.id, 'run', runById.get(row.ref))
          : row.kind === 'context'
            ? withData(row.id, 'context', context)
          : row.kind === 'objective'
            ? withData(row.id, 'objective', objective)
          : row.kind === 'path'
            ? withData(row.id, 'path', {})
            : withData(row.id, 'draft', drafts.get(row.ref));
    if (update) updates.push(update);
  }
  return { updates, cursor: changed.rows[changed.rows.length - 1]?.id ?? afterId };
}
