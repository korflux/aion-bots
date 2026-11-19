// Validade de um aviso (phase 3, T3; F1/F3; Suposições 6, 7, 11 e 12; NOTIF-01): a FONTE ÚNICA da regra "este evento ainda merece aviso?".
// Quem usa: o despachante do worker, na hora de enviar (o inválido termina `dropped` com o motivo, sem tocar o FCM), e a conferência do
// service worker (`PushService.checkEvents`), na chegada do push e para as notificações já exibidas. As duas pontas chamam a MESMA função,
// então o que o servidor não enviaria também não é mostrado quando chega atrasado.
//
// Um evento deixa de valer (o primeiro motivo encontrado, nesta ordem, é o gravado):
//   expired   tem 24 horas ou mais (a mesma validade do TTL do FCM);
//   presence  há presença válida na conversa em qualquer sessão (o dono está olhando);
//   opened    é anterior à última abertura do app em qualquer aparelho;
//   read      a conversa já foi lida até a mensagem do evento (ou além);
//   resolved  é um `approval_pending` cuja aprovação já não está pendente;
//   muted     o tipo está silenciado para a origem (matriz de silenciar, T13).
// Só ids e instantes passam por aqui: nenhum conteúdo de conversa.
import { PUSH_EVENT_MAX_AGE_MS, type PushDropReason, type PushEventKind } from '@aion/shared';
import type { Queryable } from '../db/pool';
import { hasLivePresence, isReadThrough } from '../presence/service';

/** O que a regra e o envio precisam saber de um evento da caixa de saída. */
export interface PushEventFacts {
  id: string;
  kind: PushEventKind;
  /** Nulo quando o evento é de uma sessão do Chat geral. */
  bot_id: string | null;
  run_id: string | null;
  /** Conversa do evento (`conversations.id`): a da execução ou, sem ela, a conversa única do bot. Nula se nenhuma das duas existe mais. */
  conversation_id: string | null;
  /** Mensagem que o toque abre (cartão ou resposta); nula se foi apagada. */
  message_id: string | null;
  created_at: Date;
}

/** Carrega os eventos pedidos (ids de `push_events` em texto). Ids inexistentes simplesmente não voltam. */
export async function loadPushEvents(db: Queryable, ids: readonly string[]): Promise<PushEventFacts[]> {
  if (ids.length === 0) return [];
  const found = await db.query<PushEventFacts>(
    `SELECT e.id::text AS id, e.kind, e.bot_id, e.run_id::text AS run_id, e.message_id::text AS message_id, e.created_at,
            coalesce(r.conversation_id, c.id) AS conversation_id
     FROM push_events e
     LEFT JOIN runs r ON r.id = e.run_id
     LEFT JOIN conversations c ON c.bot_id = e.bot_id
     WHERE e.id = ANY($1::bigint[])
     ORDER BY e.id`,
    [ids],
  );
  return found.rows;
}

/** Instante da última abertura do app (Suposição 7), ou nulo se o app nunca foi aberto desde a migration 0022. */
async function lastAppOpenOf(db: Queryable): Promise<Date | null> {
  const found = await db.query<{ opened_at: Date }>('SELECT opened_at FROM app_opened');
  return found.rows[0]?.opened_at ?? null;
}

/**
 * A aprovação do `approval_pending` ainda espera o dono? É a aprovação cujo cartão é a mensagem do evento; se a mensagem foi apagada, qualquer
 * aprovação pendente da mesma execução. Uma execução tem no máximo uma aprovação aberta por vez (índice `approvals_one_open_per_run`).
 */
async function approvalStillPending(db: Queryable, event: PushEventFacts): Promise<boolean> {
  const found = await db.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM approvals
       WHERE status = 'pending' AND (card_id = $1::bigint OR ($1::bigint IS NULL AND run_id = $2::bigint))
     ) AS pending`,
    [event.message_id, event.run_id],
  );
  return found.rows[0]?.pending === true;
}

/** O dono silenciou este tipo de aviso para a origem do evento (o bot, ou o Chat geral quando `bot_id` é nulo)? */
async function isMuted(db: Queryable, event: PushEventFacts): Promise<boolean> {
  const muted = await db.query('SELECT 1 FROM push_mutes WHERE kind = $1 AND bot_id IS NOT DISTINCT FROM $2::uuid', [event.kind, event.bot_id]);
  return muted.rows.length > 0;
}

/** A regra (ver o cabeçalho): o motivo pelo qual o evento não vale mais no instante `at`, ou nulo se ele ainda merece aviso. */
export async function pushDropReasonOf(db: Queryable, event: PushEventFacts, at: Date): Promise<PushDropReason | null> {
  if (at.getTime() - event.created_at.getTime() >= PUSH_EVENT_MAX_AGE_MS) return 'expired';
  if (event.conversation_id !== null && (await hasLivePresence(db, event.conversation_id, at))) return 'presence';
  const openedAt = await lastAppOpenOf(db);
  if (openedAt !== null && event.created_at < openedAt) return 'opened';
  if (event.conversation_id !== null && event.message_id !== null && (await isReadThrough(db, event.conversation_id, event.message_id))) return 'read';
  if (event.kind === 'approval_pending' && !(await approvalStillPending(db, event))) return 'resolved';
  if (await isMuted(db, event)) return 'muted';
  return null;
}
