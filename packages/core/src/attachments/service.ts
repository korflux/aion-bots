// Fonte única da validação e armazenamento de anexos isolados por ConversationRef.
// ponytail: arquivos em bytea no PostgreSQL (uma tabela, um backup), migrar para armazenamento de objetos (S3 ou MinIO no Easypanel) se o teto total passar de alguns GB (planilhas guardam o original de até 15 MB desde a phase 4), se o original do PDF/DOCX ou o vídeo voltarem, ou se houver mais de uma instância com carga de arquivo
import { ATTACHMENT_LIMIT, ATTACHMENT_NAME_MAX, type AttachmentKind, type GeneratedFormat, type AttachmentView, type AttachmentPage, type AttachmentListQuery, type AttachmentDeleteResult, type ActivityBot } from '@aion/shared';
import type { RequestOrigin } from '../auth/service';
import { recordAudit } from '../audit';
import type { ConversationRef, ConversationService } from '../conversation/service';
import { SlidingWindowLimiter } from '../credentials/rate-limit';
import { withTransaction, type Pool } from '../db/pool';
import { DomainError } from '../errors';
import { extractDocument, validateSpreadsheet, type DocumentFormat } from './extract';

const MB = 1024 * 1024;
/**
 * Trava compartilhada do espaço global de anexos (advisory lock do PostgreSQL): uploads e arquivos gerados pelo Python (`generated.ts`) somam e
 * gravam sob ela, então dois processos nunca passam juntos do teto.
 */
export const QUOTA_LOCK_KEY = 1919019;
const META = 'id, kind, format, name, original_bytes, stored_bytes, truncated, created_at, removed_at';
// A referência da releitura nasce em writeActivity, antes da ferramenta. Comparação textual evita cast de JSON externo. Arquivo de um complemento
// pendente ou do rascunho devolvido (phase 4, F5) também está em uso: excluí-lo deixaria o envio que o espera sem ele. O arquivo que uma edição
// manteve de outra versão (phase 4, ATT-01) está em uso pela execução da versão nova, pelo vínculo extra da mensagem dela.
const IN_USE = `(a.complement_id IS NOT NULL OR EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = a.conversation_id
  AND r.status IN ('queued','running','waiting_approval') AND
  (r.id = a.run_id OR r.trigger_message_id = a.message_id OR EXISTS (
    SELECT 1 FROM message_attachment_links l WHERE l.attachment_id = a.id AND l.message_id = r.trigger_message_id) OR EXISTS (
    SELECT 1 FROM messages m WHERE m.run_id = r.id AND m.kind = 'activity'
    AND ((m.data->'detail'->>'type' = 'attachment_read' AND m.data->'detail'->>'attachmentId' = a.id::text)
      OR m.evidence_provenance->'attachments' ? a.id::text)) OR EXISTS (
    SELECT 1 FROM model_call_usage u WHERE u.run_id=r.id AND u.state='started'
      AND u.evidence_provenance->'attachments' ? a.id::text))))`;
interface AttachmentRow {
  id: string; kind: AttachmentKind; format: GeneratedFormat | null; name: string; original_bytes: number; stored_bytes: number;
  truncated: boolean; created_at: Date; removed_at: Date | null;
}

/** Remove caminhos e controles do nome externo; o nome é dado, nunca caminho local. A extensão aceita sobrevive ao corte do nome longo. */
export function sanitizeAttachmentName(raw: string): string {
  const clean = raw.replace(/[\\/]/g, '_').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').trim();
  const extension = /\.(?:pdf|docx|txt|md|csv|json|xlsx|png|jpe?g)$/i.exec(clean)?.[0] ?? '';
  return [...extension ? clean.slice(0, -extension.length) : clean].slice(0, ATTACHMENT_NAME_MAX - extension.length).join('') + extension || 'arquivo';
}

/** Confere marcadores JPEG, segmentos e existência de frame/scan, sem confiar em extensão ou MIME. */
function isJpeg(bytes: Buffer): boolean {
  if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false;
  let at = 2; let frame = false;
  while (at + 4 <= bytes.length) {
    if (bytes[at++] !== 0xff) return false;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (at + 2 > bytes.length) return false;
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0xd9) return false;
    const size = bytes.readUInt16BE(at);
    if (size < 2 || at + size > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (size < 8 || bytes.readUInt16BE(at + 3) === 0 || bytes.readUInt16BE(at + 5) === 0) return false;
      frame = true;
    }
    if (marker === 0xda) return frame && at + size < bytes.length - 2;
    at += size;
  }
  return false;
}

/**
 * Determina o formato real; arquivos de texto (inclui JSON, phase 4) exigem extensão permitida e UTF-8 validado pelo leitor. ZIP só vale como
 * DOCX ou `.xlsx` pela extensão e depois pelo conteúdo no leitor isolado; `.xlsm` (planilha com macro) nunca casa e é recusado aqui.
 */
function formatOf(bytes: Buffer, name: string): 'image' | 'xlsx' | DocumentFormat {
  if (isJpeg(bytes)) return 'image';
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  const zip = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  if (zip && /\.docx$/i.test(name)) return 'docx';
  if (zip && /\.xlsx$/i.test(name)) return 'xlsx';
  if (/\.(txt|md|csv|json)$/i.test(name) && !bytes.subarray(0, 4).includes(0) && !bytes.subarray(0, 2).equals(Buffer.from('MZ'))) return 'text';
  throw new DomainError('ATTACHMENT_TYPE_UNSUPPORTED');
}

/** Serializa exclusivamente metadados, sem selecionar conteúdo em operações comuns. */
function view(row: AttachmentRow): AttachmentView {
  return { id: row.id, kind: row.kind, name: row.name, originalBytes: row.original_bytes, storedBytes: row.stored_bytes, truncated: row.truncated, createdAt: row.created_at.toISOString(), removedAt: row.removed_at?.toISOString() ?? null, ...(row.format ? { format: row.format } : {}) };
}

/** Conteúdo privado entregue pela rota autenticada; a rota decide tipo de mídia, disposição e cache pelo `kind` (e pelo `format` do arquivo gerado). */
export interface AttachmentContent { kind: AttachmentKind; format?: GeneratedFormat; name: string; bytes: Buffer }

export interface AttachmentServiceOptions {
  pool: Pool;
  conversations: Pick<ConversationService, 'conversationIdOf'>;
  maxTotalBytes?: number;
  now?: () => Date;
}

/** Uploads preservam quota e máximo pendente atomicamente, mesmo entre conversas e processos concorrentes. */
export class AttachmentService {
  private readonly limiter: SlidingWindowLimiter;
  private readonly maxTotalBytes: number;
  private readonly deleteLimiter: SlidingWindowLimiter;
  constructor(private readonly options: AttachmentServiceOptions) {
    this.maxTotalBytes = options.maxTotalBytes ?? 1024 * MB;
    this.limiter = new SlidingWindowLimiter({ max: 30, windowMs: 60_000, now: options.now });
    this.deleteLimiter = new SlidingWindowLimiter({ max: 10, windowMs: 60_000, now: options.now });
  }

  /**
   * Listagem global lê só metadados e soma armazenada; filtros não alteram a quota global exibida. Filtro Tipo (design phase 4, sem filtro novo):
   * "Imagens" traz também o PNG gerado pelo Python e "Documentos" traz as planilhas e os demais arquivos gerados.
   */
  async list(query: AttachmentListQuery): Promise<AttachmentPage> {
    const [found, usage] = await Promise.all([
      this.options.pool.query<AttachmentRow & { bot: ActivityBot | null; session_id: string | null; session_title: string | null; in_use: boolean }>(`SELECT
        ${META.split(', ').map((column) => `a.${column}`).join(', ')},
        CASE WHEN b.id IS NULL THEN NULL ELSE jsonb_build_object('id',b.id,'name',b.name,'color',b.color,'archived',b.archived_at IS NOT NULL) END AS bot,
        CASE WHEN b.id IS NULL THEN c.id ELSE NULL END AS session_id, CASE WHEN b.id IS NULL THEN c.title ELSE NULL END AS session_title,
        ${IN_USE} AS in_use FROM attachments a JOIN conversations c ON c.id = a.conversation_id LEFT JOIN bots b ON b.id = c.bot_id
        WHERE a.removed_at IS NULL AND ($1::bigint IS NULL OR a.id < $1)
        AND ($2::text IS NULL OR ($2 = 'chat' AND c.bot_id IS NULL) OR ($2 = 'bot' AND c.bot_id IS NOT NULL))
        AND ($3::uuid IS NULL OR c.bot_id = $3) AND ($4::text IS NULL OR a.kind = $4 OR ($4 = 'document' AND a.kind = 'spreadsheet')
          OR (a.kind = 'generated' AND ($4 = 'image') = (a.format = 'png'))) ORDER BY a.id DESC LIMIT 51`,
      [query.cursor ?? null, query.origin ?? null, query.botId ?? null, query.kind ?? null]),
      this.options.pool.query<{ bytes: string; count: string }>('SELECT COALESCE(sum(stored_bytes),0)::text AS bytes, count(*)::text AS count FROM attachments WHERE removed_at IS NULL'),
    ]);
    const page = found.rows.slice(0, 50);
    return { items: page.map((row) => ({ ...view(row), bot: row.bot, sessionId: row.session_id, sessionTitle: row.session_title, inUse: row.in_use })), nextCursor: found.rows.length > 50 ? page.at(-1)!.id : null, usedBytes: Number(usage.rows[0]!.bytes), count: Number(usage.rows[0]!.count), maxBytes: this.maxTotalBytes };
  }

  /** O único dono autenticado pode abrir qualquer origem; ConversationRef mantém a consulta de conteúdo isolada. */
  async globalContent(id: string): Promise<AttachmentContent> {
    const found = await this.options.pool.query<{ bot_id: string | null; conversation_id: string }>('SELECT c.bot_id, a.conversation_id FROM attachments a JOIN conversations c ON c.id = a.conversation_id WHERE a.id = $1', [id]);
    const row = found.rows[0];
    if (!row) throw new DomainError('ATTACHMENT_NOT_FOUND');
    return this.content(row.bot_id ?? { sessionId: row.conversation_id }, id);
  }

  /** Excluir um desconhecido/removido é idempotente; em uso mantém conteúdo e devolve o erro de domínio. */
  async remove(id: string, origin: RequestOrigin): Promise<void> {
    await this.deleteFiles([id], origin, true);
  }

  /** Cada tentativa de lote conta no limite; duplicatas não duplicam contagem ou auditoria. */
  async removeBatch(ids: readonly string[], origin: RequestOrigin): Promise<AttachmentDeleteResult> {
    this.deleteLimiter.consume();
    return this.deleteFiles(ids, origin, false);
  }

  /** Ordem dono da fila -> runs -> anexos evita corrida de retry e de registro/fechamento da ferramenta. */
  private async deleteFiles(ids: readonly string[], origin: RequestOrigin, individual: boolean): Promise<AttachmentDeleteResult> {
    // O schema aceita dígitos com zeros à esquerda; normalizar mantém a identidade do bigint e a idempotência.
    const unique = [...new Set(ids.map((id) => BigInt(id).toString()))];
    return withTransaction(this.options.pool, async (tx) => {
      const owners = await tx.query<{ conversation_id: string; bot_id: string | null }>('SELECT DISTINCT a.conversation_id, c.bot_id FROM attachments a JOIN conversations c ON c.id = a.conversation_id WHERE a.id = ANY($1::bigint[]) ORDER BY a.conversation_id', [unique]);
      for (const owner of owners.rows) {
        // NO KEY UPDATE serializa com queueRun sem bloquear KEY SHARE das FKs de mensagens/push do executor.
        await tx.query(owner.bot_id ? 'SELECT id FROM bots WHERE id = $1 FOR NO KEY UPDATE' : 'SELECT id FROM conversations WHERE id = $1 FOR NO KEY UPDATE', [owner.bot_id ?? owner.conversation_id]);
        // Dois comandos: o snapshot da avaliação precisa incluir a atividade que terminou enquanto a trava esperava.
        await tx.query('SELECT id FROM runs WHERE conversation_id = $1 ORDER BY id FOR UPDATE', [owner.conversation_id]);
      }
      await tx.query('SELECT id FROM attachments WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [unique]);
      const files = await tx.query<{ id: string; kind: string; stored_bytes: number; removed: boolean; in_use: boolean }>(`SELECT a.id, a.kind, a.stored_bytes, a.removed_at IS NOT NULL AS removed, ${IN_USE} AS in_use FROM attachments a WHERE a.id = ANY($1::bigint[])`, [unique]);
      const result: AttachmentDeleteResult = { deleted: [], inUse: [], alreadyRemoved: [], freedBytes: 0 };
      for (const id of unique) {
        const file = files.rows.find((row) => row.id === id);
        if (!file || file.removed) result.alreadyRemoved.push(id);
        else if (file.in_use) result.inUse.push(id);
        else { result.deleted.push(id); result.freedBytes += file.stored_bytes; }
      }
      if (individual && result.inUse.length) throw new DomainError('ATTACHMENT_IN_USE');
      if (result.deleted.length) {
        const at = this.options.now?.() ?? new Date();
        await tx.query('UPDATE attachments SET image_bytes = NULL, extracted_text = NULL, file_bytes = NULL, stored_bytes = 0, removed_at = $2 WHERE id = ANY($1::bigint[])', [result.deleted, at]);
        await tx.query(`UPDATE messages SET content = '[conteúdo removido]', data = jsonb_set(data, '{detail}', 'null'::jsonb)
          WHERE kind = 'activity' AND data->'detail'->>'type' = 'attachment_read' AND data->'detail'->>'attachmentId' = ANY($1::text[])`, [result.deleted]);
        for (const kind of ['image', 'document', 'spreadsheet', 'generated']) {
          const removed = files.rows.filter((file) => file.kind === kind && result.deleted.includes(file.id));
          if (removed.length) await recordAudit(tx, { action: 'attachment.delete', outcome: 'success', actor: 'owner', ...origin, details: { type: kind, count: removed.length, bytes: removed.reduce((sum, file) => sum + file.stored_bytes, 0) } }, at);
        }
      }
      return result;
    });
  }

  /** Valida/extrai antes da transação curta; conteúdo rejeitado nunca chega ao banco nem ao log. */
  async upload(ref: ConversationRef, rawName: string, bytes: Buffer): Promise<AttachmentView> {
    this.limiter.consume();
    if (!Buffer.isBuffer(bytes)) throw new DomainError('ATTACHMENT_TYPE_UNSUPPORTED');
    const conversationId = await this.options.conversations.conversationIdOf(ref);
    const name = sanitizeAttachmentName(rawName);
    const format = formatOf(bytes, name);
    const limit = (format === 'image' ? 5 : format === 'text' ? 1 : 15) * MB;
    if (bytes.length > limit) throw new DomainError('ATTACHMENT_TOO_LARGE');
    if (!bytes.length) throw new DomainError('ATTACHMENT_NO_TEXT');
    // Planilha guarda o original e não tem texto (ATT-01); o original conta inteiro no espaço total, como o JPEG.
    if (format === 'xlsx') await validateSpreadsheet(bytes);
    const extracted = format === 'image' || format === 'xlsx' ? null : await extractDocument(bytes, format);
    const kind: AttachmentKind = format === 'image' ? 'image' : format === 'xlsx' ? 'spreadsheet' : 'document';
    const storedBytes = extracted ? Buffer.byteLength(extracted.text, 'utf8') : bytes.length;
    return withTransaction(this.options.pool, async (tx) => {
      // Uma trava compartilhada entre instâncias protege a soma global; extração nunca ocupa esta trava.
      await tx.query('SELECT pg_advisory_xact_lock($1)', [QUOTA_LOCK_KEY]);
      if (typeof ref === 'string') {
        const bot = await tx.query<{ archived_at: Date | null }>('SELECT archived_at FROM bots WHERE id = $1 FOR UPDATE', [ref]);
        if (!bot.rows[0]) throw new DomainError('BOT_NOT_FOUND');
        if (bot.rows[0].archived_at) throw new DomainError('BOT_ARCHIVED');
      }
      const conversation = await tx.query('SELECT id FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
      if (!conversation.rowCount) throw new DomainError(typeof ref === 'string' ? 'BOT_NOT_FOUND' : 'SESSION_NOT_FOUND');
      const pending = await tx.query<{ total: string }>('SELECT count(*) AS total FROM attachments WHERE conversation_id = $1 AND run_id IS NULL AND complement_id IS NULL AND removed_at IS NULL', [conversationId]);
      if (Number(pending.rows[0]!.total) >= ATTACHMENT_LIMIT) throw new DomainError('ATTACHMENT_LIMIT_REACHED');
      const usage = await tx.query<{ total: string }>('SELECT COALESCE(sum(stored_bytes), 0)::text AS total FROM attachments');
      if (BigInt(usage.rows[0]!.total) + BigInt(storedBytes) > BigInt(this.maxTotalBytes)) throw new DomainError('ATTACHMENT_QUOTA_EXCEEDED');
      const result = await tx.query<AttachmentRow>(`INSERT INTO attachments (conversation_id, kind, name, original_bytes, stored_bytes, image_bytes, extracted_text, file_bytes, truncated)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${META}`, [conversationId, kind, name, bytes.length, storedBytes, kind === 'image' ? bytes : null, extracted?.text ?? null, kind === 'spreadsheet' ? bytes : null, extracted?.truncated ?? false]);
      return view(result.rows[0]!);
    });
  }

  /** Descartar só é permitido para pendente da conversa; id de outra conversa parece inexistente. */
  async discard(ref: ConversationRef, id: string): Promise<void> {
    const conversationId = await this.options.conversations.conversationIdOf(ref);
    const result = await this.options.pool.query('DELETE FROM attachments WHERE id = $1 AND conversation_id = $2 AND run_id IS NULL AND message_id IS NULL AND complement_id IS NULL AND removed_at IS NULL', [id, conversationId]);
    if (!result.rowCount) throw new DomainError('ATTACHMENT_NOT_FOUND');
  }

  /**
   * Conteúdo é selecionado somente por id + conversa, e arquivo removido nunca volta: JPEG, original (planilha ou arquivo gerado pelo Python) ou
   * texto extraído.
   */
  async content(ref: ConversationRef, id: string): Promise<AttachmentContent> {
    const conversationId = await this.options.conversations.conversationIdOf(ref);
    const result = await this.options.pool.query<{ kind: AttachmentKind; format: GeneratedFormat | null; name: string; image_bytes: Buffer | null; extracted_text: string | null; file_bytes: Buffer | null }>('SELECT kind, format, name, image_bytes, extracted_text, file_bytes FROM attachments WHERE id = $1 AND conversation_id = $2 AND removed_at IS NULL', [id, conversationId]);
    const row = result.rows[0];
    if (!row) throw new DomainError('ATTACHMENT_NOT_FOUND');
    return { kind: row.kind, ...(row.format ? { format: row.format } : {}), name: row.name, bytes: row.kind === 'image' ? row.image_bytes! : row.kind === 'document' ? Buffer.from(row.extracted_text!, 'utf8') : row.file_bytes! };
  }
}
