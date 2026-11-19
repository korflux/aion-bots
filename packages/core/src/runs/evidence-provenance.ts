// Proveniência server-only de evidências automáticas. Texto/IDs produzidos pelo modelo nunca concedem acesso.
//
// Fontes: anexos, tabelas e (phase 14, A33) docs. Tabela e doc seguem a mesma regra: a leitura do bot guarda a REVISÃO DE ACESSO que leu (`accessVersion`), e a evidência só vale enquanto o bot
// ainda tem o acesso naquela revisão; revogar o compartilhamento (que sobe a revisão) tira do pedido ao modelo tudo o que veio daquela fonte, e conceder de novo não o revive.
import { z } from 'zod';
import type { Queryable } from '../db/pool';

const evidenceSchema = z.strictObject({
  attachments: z.array(z.string().regex(/^[1-9]\d{0,17}$/)),
  tables: z.array(z.strictObject({ tableId: z.uuid(), botId: z.uuid(), accessVersion: z.number().int().positive() })),
  // `default([])`: a evidência gravada antes da phase 14 (mensagens, anexos gerados, checkpoints, medições) não tem o campo e continua válida, como "nenhum doc".
  docs: z.array(z.strictObject({ docId: z.uuid(), botId: z.uuid(), accessVersion: z.number().int().positive() })).default([]),
});
export type EvidenceProvenance = z.infer<typeof evidenceSchema>;

/** NULL ou metadata legada/malformada são desconhecidos, nunca uma evidência vazia válida. */
export function parseEvidence(value: unknown): EvidenceProvenance | null {
  const parsed = evidenceSchema.safeParse(value);
  return parsed.success ? mergeEvidence(parsed.data) : null;
}

/** União canônica; versões conflitantes sobrevivem para que a validação falhe fechada. */
export function mergeEvidence(...sources: readonly EvidenceProvenance[]): EvidenceProvenance {
  const attachments = [...new Set(sources.flatMap((source) => source.attachments))].sort();
  const tables = [...new Map(sources.flatMap((source) => source.tables).map(({ tableId, botId, accessVersion }) => {
    const table = { tableId, botId, accessVersion };
    return [JSON.stringify(table), table] as const;
  })).values()]
    .sort((a, b) => a.tableId.localeCompare(b.tableId) || a.botId.localeCompare(b.botId) || a.accessVersion - b.accessVersion);
  const docs = [...new Map(sources.flatMap((source) => source.docs).map(({ docId, botId, accessVersion }) => {
    const doc = { docId, botId, accessVersion };
    return [JSON.stringify(doc), doc] as const;
  })).values()]
    .sort((a, b) => a.docId.localeCompare(b.docId) || a.botId.localeCompare(b.botId) || a.accessVersion - b.accessVersion);
  return { attachments, tables, docs };
}

/** Resolve a closure de arquivos realmente carregados, incluindo todas as gerações anteriores. */
export async function attachmentEvidence(db: Queryable, conversationId: string, botId: string | null, ids: readonly string[]): Promise<EvidenceProvenance | null> {
  let evidence = mergeEvidence({ attachments: [...ids], tables: [], docs: [] });
  if (!parseEvidence(evidence)) return null;
  const visited = new Set<string>();
  for (;;) {
    const pending = evidence.attachments.filter((id) => !visited.has(id));
    if (!pending.length) break;
    const rows = await db.query<{ id: string; kind: string; source_provenance: unknown }>(
      `SELECT id::text AS id, kind, source_provenance FROM attachments
       WHERE conversation_id=$1 AND id=ANY($2::bigint[]) AND removed_at IS NULL AND message_id IS NOT NULL`, [conversationId, pending]);
    if (rows.rows.length !== pending.length) return null;
    for (const row of rows.rows) {
      visited.add(row.id);
      if (row.kind !== 'generated') continue;
      const source = parseEvidence(row.source_provenance);
      if (!source) return null;
      evidence = mergeEvidence(evidence, source);
    }
  }
  return await validateEvidence(db, conversationId, botId, evidence) ? evidence : null;
}

/** Revalida conversa, exclusões e concessões atuais; revogar e conceder novamente não revive a evidência antiga. */
export async function validateEvidence(db: Queryable, conversationId: string, botId: string | null, raw: EvidenceProvenance): Promise<boolean> {
  const evidence = parseEvidence(raw);
  if (!evidence) return false;
  const conversation = await db.query('SELECT 1 FROM conversations WHERE id=$1 AND bot_id IS NOT DISTINCT FROM $2::uuid', [conversationId, botId]);
  if (!conversation.rowCount) return false;
  if (evidence.attachments.length) {
    const found = await db.query<{ id: string; kind: string; source_provenance: unknown }>(
      `SELECT id::text AS id, kind, source_provenance FROM attachments
       WHERE conversation_id=$1 AND id=ANY($2::bigint[]) AND removed_at IS NULL AND message_id IS NOT NULL`, [conversationId, evidence.attachments]);
    if (found.rows.length !== evidence.attachments.length) return false;
    // A closure deve já estar completa; não aceitar uma cópia que omitiu dependências de um gerado.
    for (const file of found.rows.filter((row) => row.kind === 'generated')) {
      const source = parseEvidence(file.source_provenance);
      if (!source || JSON.stringify(mergeEvidence(evidence, source)) !== JSON.stringify(evidence)) return false;
    }
  }
  if (evidence.tables.length) {
    if (!botId || evidence.tables.some((table) => table.botId !== botId)) return false;
    const found = await db.query<{ id: string; access_version: number }>(
      `SELECT t.id, t.access_version FROM data_tables t JOIN table_bot_access a ON a.table_id=t.id
       WHERE a.bot_id=$1 AND t.id=ANY($2::uuid[])`, [botId, evidence.tables.map((table) => table.tableId)]);
    if (!evidence.tables.every((table) => found.rows.some((row) => row.id === table.tableId && row.access_version === table.accessVersion))) return false;
  }
  if (evidence.docs.length) {
    // Mesma regra das tabelas: só o bot da conversa, e só enquanto o acesso dele ao doc segue na revisão que ele leu (doc excluído ou compartilhamento revogado = inválida).
    if (!botId || evidence.docs.some((doc) => doc.botId !== botId)) return false;
    const found = await db.query<{ id: string; access_version: number }>(
      `SELECT d.id, d.access_version FROM docs d JOIN doc_bot_access a ON a.doc_id=d.id
       WHERE a.bot_id=$1 AND d.id=ANY($2::uuid[])`, [botId, evidence.docs.map((doc) => doc.docId)]);
    if (!evidence.docs.every((doc) => found.rows.some((row) => row.id === doc.docId && row.access_version === doc.accessVersion))) return false;
  }
  return true;
}
