// Arquivos gerados pelo Python (phase 4, T7; F8, Suposição 24, ATT-01): a conferência do formato pelo conteúdo real e a gravação como anexos da
// conversa. É a mesma "fonte única" dos anexos (service.ts): o nome passa por `sanitizeAttachmentName`, o espaço é o mesmo teto global
// (`AION_ATTACHMENTS_MAX_TOTAL_MB`) sob a mesma trava, e a exclusão segue as regras de qualquer anexo.
//
// Os bytes vêm do sandbox, que executou código do modelo: são dado NÃO CONFIÁVEL. A extensão do nome escolhe o formato pretendido e o conteúdo
// precisa provar que é dele (PNG pela assinatura e pelos blocos IHDR/IEND; texto por UTF-8 válido e sem NUL; JSON pelo parse; XLSX pela mesma
// validação da planilha enviada, contra zip bomb e macro). Nada do conteúdo vai a log.
import { GENERATED_FORMATS, type GeneratedFormat } from '@aion/shared';
import { withTransaction, type Pool } from '../db/pool';
import { DomainError } from '../errors';
import { validateSpreadsheet } from './extract';
import { QUOTA_LOCK_KEY, sanitizeAttachmentName } from './service';
import { mergeEvidence, type EvidenceProvenance } from '../runs/evidence-provenance';

/** Assinatura de 8 bytes do PNG. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bloco final do PNG: tamanho zero, tipo IEND e o CRC fixo dele. */
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/** PNG de verdade: assinatura, primeiro bloco IHDR de 13 bytes com largura e altura positivas e o bloco IEND no fim. */
function isPng(bytes: Buffer): boolean {
  if (bytes.length < 8 + 25 + 12 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  if (bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return false;
  if (bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0) return false;
  return bytes.subarray(bytes.length - 12).equals(PNG_IEND);
}

/** Texto UTF-8 válido e sem NUL (o PostgreSQL e a tela tratam como texto; um binário com extensão de texto é recusado). */
function utf8Text(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Formato pretendido pelo nome (extensão, sem diferenciar maiúsculas); nulo se não é um dos aceitos. */
function formatOfName(name: string): GeneratedFormat | null {
  const extension = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (GENERATED_FORMATS as readonly string[]).includes(extension ?? '') ? (extension as GeneratedFormat) : null;
}

/** Confere o formato de um arquivo de /out/ pelo conteúdo real; nulo se a extensão não é aceita ou o conteúdo não confere com ela. */
export async function generatedFormatOf(name: string, bytes: Buffer): Promise<GeneratedFormat | null> {
  const format = formatOfName(name);
  switch (format) {
    case null:
      return null;
    case 'png':
      return isPng(bytes) ? format : null;
    case 'xlsx':
      try {
        await validateSpreadsheet(bytes);
        return format;
      } catch {
        return null;
      }
    case 'json': {
      const text = utf8Text(bytes);
      if (text === null) return null;
      try {
        JSON.parse(text);
        return format;
      } catch {
        return null;
      }
    }
    default:
      return utf8Text(bytes) === null ? null : format;
  }
}

/** Um arquivo já conferido, pronto para gravar. */
export interface GeneratedFile {
  name: string;
  format: GeneratedFormat;
  bytes: Buffer;
}

/** O que foi gravado: o id do anexo e os metadados que o modelo e a tela recebem. */
export interface StoredGeneratedFile {
  id: string;
  name: string;
  format: GeneratedFormat;
  sizeBytes: number;
}

export interface StoreGeneratedFilesInput {
  conversationId: string;
  /** Execução que gerou os arquivos: ficam "em uso" enquanto ela está ativa. */
  runId: string;
  /** Atividade do `run_python`: é a parte da resposta em que os arquivos aparecem (`message_id`). */
  activityId: string;
  /** Teto global de bytes guardados em anexos (`AION_ATTACHMENTS_MAX_TOTAL_MB`). */
  maxTotalBytes: number;
  files: readonly GeneratedFile[];
  /** Closure dos arquivos usados; omitida somente por caller legado, cuja saída será inelegível no contexto. */
  evidence?: EvidenceProvenance;
}

/**
 * Grava os arquivos gerados numa transação só, sob a mesma trava do espaço dos uploads: todos ou nenhum. Se a soma passar do teto global,
 * lança `ATTACHMENT_QUOTA_EXCEEDED` e nada é gravado (Suposição 24). O nome é sanitizado pela regra dos anexos.
 */
export async function storeGeneratedFiles(pool: Pool, { conversationId, runId, activityId, maxTotalBytes, files, evidence }: StoreGeneratedFilesInput): Promise<StoredGeneratedFile[]> {
  if (!files.length) return [];
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  return withTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [QUOTA_LOCK_KEY]);
    const usage = await tx.query<{ total: string }>('SELECT COALESCE(sum(stored_bytes), 0)::text AS total FROM attachments');
    if (BigInt(usage.rows[0]!.total) + BigInt(total) > BigInt(maxTotalBytes)) throw new DomainError('ATTACHMENT_QUOTA_EXCEEDED');
    const stored: StoredGeneratedFile[] = [];
    for (const file of files) {
      const name = sanitizeAttachmentName(file.name);
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO attachments (conversation_id, run_id, message_id, kind, format, name, original_bytes, stored_bytes, file_bytes, truncated, source_provenance)
         VALUES ($1, $2, $3, 'generated', $4, $5, $6, $6, $7, false, $8) RETURNING id::text AS id`,
        [conversationId, runId, activityId, file.format, name, file.bytes.length, file.bytes, evidence ? JSON.stringify(mergeEvidence(evidence)) : null],
      );
      stored.push({ id: inserted.rows[0]!.id, name, format: file.format, sizeBytes: file.bytes.length });
    }
    return stored;
  });
}
