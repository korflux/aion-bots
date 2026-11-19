// Complemento durante a execução e rascunho devolvido (phase 4, F5, CONV-03): a fonte única das transições de um complemento, usada pelo
// envio e pelo "Cancelar" (`ConversationService`), pela parada, pelo executor (absorção e desfecho) e pela expiração de aprovação.
//
// Ciclo de vida (Suposições 14 a 19 da spec; tabela da migration 0024):
//   envio com execução ativa -> PENDENTE da execução -> um, e só um, destes, sempre apagando a linha pendente:
//     - ABSORVIDO: antes da próxima chamada ao modelo vira mensagem do dono marcada "complemento" na rodada atual (`absorbComplements`);
//     - PROMOVIDO: a execução terminou antes de lê-lo; na MESMA transação do desfecho vira uma execução na fila (`settleComplementsAtEnd`);
//     - DEVOLVIDO: parada ou "Cancelar"; vira o rascunho devolvido da conversa (`returnComplements`).
//
// Concorrência: toda transição começa travando a linha da EXECUÇÃO (o executor por `holdLease`, o envio, o cancelamento e a parada por
// `FOR UPDATE`/`UPDATE` nela). Com a execução travada, um envio não insere complemento no meio de uma absorção ou de um desfecho: ele espera e,
// se a execução terminou, o `FOR UPDATE` reavalia o estado, não a encontra mais ativa e o envio cria uma execução normal na fila. Nenhuma
// transição trava o dono da fila (bot ou sessão) DEPOIS da execução: `queueRun` trava o dono e o executor grava mensagens (chave estrangeira
// para a conversa) segurando a execução, então travar os dois em ordens diferentes criaria um impasse.
import { ATTACHMENT_LIMIT, COMPLEMENT_LIMIT_PER_RUN, MESSAGE_MAX, type AttachmentKind, type ComplementView, type ConversationAttachment, type DraftView } from '@aion/shared';
import type { Queryable } from '../db/pool';
import { DomainError } from '../errors';
import { recordConversationEvent } from './events';
import { insertQueuedRun, lockPendingAttachments } from './run-queue';
import type { RunRow } from './views';

/** Prazo do rascunho devolvido: o mesmo dos anexos pendentes (Suposição 18). */
export const DRAFT_TTL_MS = 24 * 3600_000;

interface ComplementRow {
  id: string;
  run_id: string | null;
  content: string;
  created_at: Date;
  returned_at: Date | null;
}

interface ComplementAttachmentRow {
  complement_id: string;
  id: string;
  name: string;
  kind: AttachmentKind;
  original_bytes: number;
  removed: boolean;
}

/** Só metadados dos anexos de cada complemento (nunca bytes nem texto extraído), agrupados pelo complemento e na ordem de upload. */
async function attachmentsOf(db: Queryable, complementIds: readonly string[]): Promise<Map<string, ConversationAttachment[]>> {
  const grouped = new Map<string, ConversationAttachment[]>();
  if (!complementIds.length) return grouped;
  const found = await db.query<ComplementAttachmentRow>(
    `SELECT complement_id::text AS complement_id, id::text AS id, name, kind, original_bytes, removed_at IS NOT NULL AS removed
     FROM attachments WHERE complement_id = ANY($1::bigint[]) ORDER BY id`,
    [complementIds],
  );
  for (const row of found.rows) {
    const files = grouped.get(row.complement_id) ?? [];
    files.push({ id: row.id, name: row.name, kind: row.kind, sizeBytes: row.original_bytes, removed: row.removed });
    grouped.set(row.complement_id, files);
  }
  return grouped;
}

const toComplementView = (row: ComplementRow, attachments: ConversationAttachment[] = []): ComplementView => ({
  id: row.id,
  content: row.content,
  attachments,
  createdAt: row.created_at.toISOString(),
});

const toDraftView = (row: ComplementRow, attachments: ConversationAttachment[] = []): DraftView => ({
  id: row.id,
  content: row.content,
  attachments,
  returnedAt: (row.returned_at as Date).toISOString(),
});

/** Complementos pendentes de cada execução pedida, na ordem de envio (a execução ativa os leva na `RunView`). Uma consulta por lote. */
export async function readPendingComplements(db: Queryable, runIds: readonly string[]): Promise<Map<string, ComplementView[]>> {
  const byRun = new Map<string, ComplementView[]>();
  if (!runIds.length) return byRun;
  const found = await db.query<ComplementRow>(
    `SELECT id::text AS id, run_id::text AS run_id, content, created_at, returned_at FROM complements
     WHERE state = 'pending' AND run_id = ANY($1::bigint[]) ORDER BY id`,
    [runIds],
  );
  const files = await attachmentsOf(db, found.rows.map((row) => row.id));
  for (const row of found.rows) {
    const list = byRun.get(row.run_id as string) ?? [];
    list.push(toComplementView(row, files.get(row.id)));
    byRun.set(row.run_id as string, list);
  }
  return byRun;
}

/** O rascunho devolvido da conversa ainda dentro do prazo (`now`), ou nulo. */
export async function readDraft(db: Queryable, conversationId: string, now: Date): Promise<DraftView | null> {
  const found = await db.query<ComplementRow>(
    `SELECT id::text AS id, run_id, content, created_at, returned_at FROM complements
     WHERE conversation_id = $1 AND state = 'returned' AND returned_at > $2`,
    [conversationId, new Date(now.getTime() - DRAFT_TTL_MS)],
  );
  const row = found.rows[0];
  return row ? toDraftView(row, (await attachmentsOf(db, [row.id])).get(row.id)) : null;
}

/** Estado atual de um rascunho para o evento `draft` do SSE: a visão, ou nulo se ele foi usado, descartado ou venceu. */
export async function readDraftById(db: Queryable, conversationId: string, draftId: string, now: Date): Promise<DraftView | null> {
  const draft = await readDraft(db, conversationId, now);
  return draft?.id === draftId ? draft : null;
}

/**
 * Grava um complemento pendente da execução `run`, que o chamador JÁ travou (`FOR UPDATE`) e confirmou ativa. O teto de 20 pendentes é
 * contado sob essa trava (dois envios simultâneos não o furam). Os anexos seguem as regras do envio (`lockPendingAttachments`). Lança
 * COMPLEMENT_LIMIT_REACHED e os erros de anexo do envio.
 */
export async function createComplement(
  tx: Queryable,
  run: Pick<RunRow, 'id' | 'conversation_id'>,
  content: string,
  attachmentIds: readonly string[],
  at: Date,
): Promise<ComplementView> {
  const pending = await tx.query<{ total: string }>("SELECT count(*) AS total FROM complements WHERE run_id = $1 AND state = 'pending'", [run.id]);
  if (Number(pending.rows[0]?.total ?? 0) >= COMPLEMENT_LIMIT_PER_RUN) throw new DomainError('COMPLEMENT_LIMIT_REACHED');
  await lockPendingAttachments(tx, run.conversation_id, attachmentIds);
  const inserted = await tx.query<ComplementRow>(
    `INSERT INTO complements (conversation_id, run_id, state, content, created_at) VALUES ($1, $2, 'pending', $3, $4)
     RETURNING id::text AS id, run_id::text AS run_id, content, created_at, returned_at`,
    [run.conversation_id, run.id, content, at],
  );
  const row = inserted.rows[0] as ComplementRow;
  if (attachmentIds.length) {
    await tx.query('UPDATE attachments SET complement_id = $1 WHERE id = ANY($2::bigint[]) AND conversation_id = $3', [row.id, attachmentIds, run.conversation_id]);
  }
  // A bolha "Complemento · aguardando" chega aos outros aparelhos pelo evento da execução, que leva os pendentes dela.
  await recordConversationEvent(tx, run.conversation_id, 'run', run.id, at);
  return toComplementView(row, (await attachmentsOf(tx, [row.id])).get(row.id));
}

/** Pendentes da execução, travados, na ordem de envio, com os ids dos anexos de cada um (também na ordem de upload). */
async function lockPending(tx: Queryable, runId: string, onlyId?: string): Promise<(ComplementRow & { attachmentIds: string[] })[]> {
  const found = await tx.query<ComplementRow>(
    `SELECT id::text AS id, run_id::text AS run_id, content, created_at, returned_at FROM complements
     WHERE run_id = $1 AND state = 'pending' AND ($2::bigint IS NULL OR id = $2::bigint) ORDER BY id FOR UPDATE`,
    [runId, onlyId ?? null],
  );
  const files = await attachmentsOf(tx, found.rows.map((row) => row.id));
  return found.rows.map((row) => ({ ...row, attachmentIds: (files.get(row.id) ?? []).map((file) => file.id) }));
}

/**
 * Absorção (Suposição 16), chamada pelo executor antes de cada chamada ao modelo, já com a posse da execução travada: cada pendente vira, na
 * ordem de envio, uma mensagem do dono da rodada atual (`opens_round` falso, então a janela de 5 rodadas não muda) marcada `complement`, com os
 * anexos ligados a ela e à execução (como os de uma mensagem que abriu rodada). Devolve quantos foram absorvidos.
 */
export async function absorbComplements(tx: Queryable, run: Pick<RunRow, 'id' | 'conversation_id'>, at: Date): Promise<number> {
  const pending = await lockPending(tx, run.id);
  for (const complement of pending) {
    const message = await tx.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, data, created_at)
       VALUES ($1, $2, 'user', 'text', 'done', false, $3, '{"complement": true}'::jsonb, $4) RETURNING id::text AS id`,
      [run.conversation_id, run.id, complement.content, at],
    );
    const messageId = (message.rows[0] as { id: string }).id;
    await tx.query('UPDATE attachments SET message_id = $2, run_id = $3, complement_id = NULL WHERE complement_id = $1', [complement.id, messageId, run.id]);
    await recordConversationEvent(tx, run.conversation_id, 'message', messageId, at);
  }
  if (!pending.length) return 0;
  await tx.query('DELETE FROM complements WHERE id = ANY($1::bigint[])', [pending.map((complement) => complement.id)]);
  await recordConversationEvent(tx, run.conversation_id, 'run', run.id, at);
  return pending.length;
}

/**
 * Junta texto e anexos ao rascunho devolvido da conversa (um só, `complements_one_draft`): cria o rascunho ou acrescenta ao existente (textos
 * separados por linha em branco, prazo renovado). O `ON CONFLICT` cobre a corrida de duas devoluções; o chamador apaga os pendentes de origem
 * DEPOIS (os anexos já mudaram de dono). Devolve o id do rascunho e grava o evento `draft`.
 * ponytail: o rascunho juntado pode passar de 32.000 caracteres e de 5 anexos (o composer recusa o envio e o dono apara), juntar em mais de um
 * rascunho só se isso incomodar na prática.
 */
async function mergeIntoDraft(tx: Queryable, conversationId: string, content: string, attachmentIds: readonly string[], at: Date): Promise<string> {
  const upserted = await tx.query<{ id: string }>(
    `INSERT INTO complements (conversation_id, state, content, created_at, returned_at) VALUES ($1, 'returned', $2, $3, $3)
     ON CONFLICT (conversation_id) WHERE state = 'returned' DO UPDATE
       SET content = coalesce(concat_ws(E'\\n\\n', nullif(complements.content, ''), nullif(excluded.content, '')), ''), returned_at = excluded.returned_at
     RETURNING id::text AS id`,
    [conversationId, content, at],
  );
  const draftId = (upserted.rows[0] as { id: string }).id;
  if (attachmentIds.length) await tx.query('UPDATE attachments SET complement_id = $1 WHERE id = ANY($2::bigint[])', [draftId, attachmentIds]);
  await recordConversationEvent(tx, conversationId, 'draft', draftId, at);
  return draftId;
}

/**
 * Devolução (Suposição 18): parada da execução (todos os pendentes) ou "Cancelar" (só `onlyId`). Os pendentes viram o rascunho devolvido, com
 * texto e anexos, e saem da execução. O chamador já travou a execução. Devolve o id do rascunho, ou nulo se não havia o que devolver.
 */
export async function returnComplements(tx: Queryable, run: Pick<RunRow, 'id' | 'conversation_id'>, at: Date, onlyId?: string): Promise<string | null> {
  const pending = await lockPending(tx, run.id, onlyId);
  if (!pending.length) return null;
  const draftId = await mergeIntoDraft(tx, run.conversation_id, pending.map((complement) => complement.content).join('\n\n'), pending.flatMap((complement) => complement.attachmentIds), at);
  await tx.query('DELETE FROM complements WHERE id = ANY($1::bigint[])', [pending.map((complement) => complement.id)]);
  await recordConversationEvent(tx, run.conversation_id, 'run', run.id, at);
  return draftId;
}

/**
 * Desfecho com pendentes (Suposição 17), na MESMA transação que grava o estado terminal da execução: `interrupted` (parada do dono) devolve
 * como rascunho; qualquer outro desfecho (concluída, falha, limite, aprovação expirada) promove a uma execução nova na fila, com os textos
 * unidos por linha em branco e os anexos somados. O que não cabe numa execução (texto acima de 32.000 caracteres a partir do complemento que
 * passaria do limite, e anexos além de 5) volta como rascunho: nada se perde. A execução promovida não aplica o teto da fila (é trabalho já
 * aceito) nem trava o dono da fila (ver o cabeçalho). Devolve o id da execução promovida, ou nulo.
 */
export async function settleComplementsAtEnd(
  tx: Queryable,
  run: Pick<RunRow, 'id' | 'conversation_id' | 'bot_id'>,
  status: 'completed' | 'failed' | 'limit_reached' | 'interrupted' | 'expired',
  at: Date,
): Promise<string | null> {
  if (status === 'interrupted') {
    await returnComplements(tx, run, at);
    return null;
  }
  const pending = await lockPending(tx, run.id);
  if (!pending.length) return null;
  // Em ordem, enquanto o texto unido couber numa mensagem; o primeiro sempre cabe (cada complemento tem até 32.000 caracteres).
  const included: typeof pending = [];
  let length = -2;
  for (const complement of pending) {
    const next = length + 2 + complement.content.length;
    if (included.length > 0 && next > MESSAGE_MAX) break;
    included.push(complement);
    length = next;
  }
  const overflow = pending.slice(included.length);
  const files = included.flatMap((complement) => complement.attachmentIds);
  const promoted = await insertQueuedRun(tx, { botId: run.bot_id, conversationId: run.conversation_id, input: included.map((complement) => complement.content).join('\n\n'), at }, files.slice(0, ATTACHMENT_LIMIT));
  const leftover = { content: overflow.map((complement) => complement.content).join('\n\n'), files: [...files.slice(ATTACHMENT_LIMIT), ...overflow.flatMap((complement) => complement.attachmentIds)] };
  if (leftover.content !== '' || leftover.files.length) await mergeIntoDraft(tx, run.conversation_id, leftover.content, leftover.files, at);
  await tx.query('DELETE FROM complements WHERE id = ANY($1::bigint[])', [pending.map((complement) => complement.id)]);
  return promoted.id;
}

/**
 * Entrega o rascunho devolvido a UM composer (Suposição 18): trava a linha, devolve texto e anexos, solta os anexos (voltam a ser pendentes da
 * conversa, prontos para o próximo envio) e apaga o rascunho. Um segundo aparelho que pedir o mesmo rascunho espera a trava, não o encontra e
 * recebe DRAFT_NOT_FOUND: a entrega é uma só. Rascunho vencido também é DRAFT_NOT_FOUND.
 * ponytail: o anexo devolvido conserva a data do upload, então pode vencer pelo job dos pendentes antes de 24 horas depois da entrega; renovar a
 * data na entrega se isso acontecer na prática.
 */
export async function consumeDraft(tx: Queryable, conversationId: string, draftId: string, at: Date): Promise<DraftView> {
  const locked = await tx.query<ComplementRow>(
    `SELECT id::text AS id, run_id, content, created_at, returned_at FROM complements
     WHERE id = $1 AND conversation_id = $2 AND state = 'returned' AND returned_at > $3 FOR UPDATE`,
    [draftId, conversationId, new Date(at.getTime() - DRAFT_TTL_MS)],
  );
  const row = locked.rows[0];
  if (!row) throw new DomainError('DRAFT_NOT_FOUND');
  const view = toDraftView(row, (await attachmentsOf(tx, [row.id])).get(row.id));
  await tx.query('UPDATE attachments SET complement_id = NULL WHERE complement_id = $1', [row.id]);
  await tx.query('DELETE FROM complements WHERE id = $1', [row.id]);
  await recordConversationEvent(tx, conversationId, 'draft', row.id, at);
  return view;
}

/**
 * Vencimento dos rascunhos devolvidos (24 horas), no job diário de retenção dos anexos pendentes: apaga os anexos ainda ligados a eles e o
 * rascunho, em lotes, cada um num comando. Devolve quantos rascunhos venceram.
 */
export async function purgeExpiredDrafts(db: Queryable, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DRAFT_TTL_MS);
  let total = 0;
  for (;;) {
    const batch = await db.query<{ removed: string }>(
      `WITH expired AS (
         SELECT id FROM complements WHERE state = 'returned' AND returned_at < $1 ORDER BY id LIMIT 100
       ), files AS (
         DELETE FROM attachments WHERE complement_id IN (SELECT id FROM expired) RETURNING complement_id
       ), drafts AS (
         DELETE FROM complements WHERE id IN (SELECT id FROM expired) AND returned_at < $1 RETURNING id
       )
       -- Um comando só: a chave anexo -> rascunho (NO ACTION) é conferida no fim dele, quando os dois lados já saíram.
       SELECT count(*)::text AS removed FROM drafts`,
      [cutoff],
    );
    const removed = Number(batch.rows[0]?.removed ?? 0);
    total += removed;
    if (removed < 100) return total;
  }
}
