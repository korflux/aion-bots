// Supervisão do leitor: prazo duro e concorrência pequena protegem a API de arquivos caros.
import { Worker } from 'node:worker_threads';
import { ATTACHMENT_PREPARATION_CONCURRENCY } from '@aion/shared';
import { DomainError } from '../errors';

export type DocumentFormat = 'pdf' | 'docx' | 'text';
export interface ExtractedDocument { text: string; truncated: boolean }
/** Códigos que a thread pode devolver; qualquer outra resposta vira `ATTACHMENT_UNREADABLE`. */
type ReaderCode = 'ATTACHMENT_NO_TEXT' | 'ATTACHMENT_UNREADABLE' | 'ATTACHMENT_TYPE_UNSUPPORTED';
/** Mensagem da thread: texto extraído, planilha válida ou código de recusa. */
interface ReaderReply { error?: string; text?: string; truncated?: boolean; valid?: boolean }
let active = 0;

/**
 * Roda o leitor isolado (`worker.ts`) fora do event loop e termina a thread ao concluir, falhar ou atingir o prazo. Fonte única da supervisão
 * do texto de documentos e da validação de planilhas: os dois dividem o mesmo orçamento de concorrência.
 */
async function runReader(bytes: Uint8Array, format: DocumentFormat | 'xlsx', timeoutMs: number): Promise<ReaderReply> {
  if (active >= ATTACHMENT_PREPARATION_CONCURRENCY) throw new DomainError('RATE_LIMITED', { retryAfterSeconds: 1 });
  active++;
  let worker: Worker | undefined;
  try {
    const production = import.meta.url.endsWith('.js');
    worker = new Worker(new URL(production ? './attachment-extractor.js' : './worker.ts', import.meta.url), {
      workerData: { bytes, format }, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
    });
    // Bibliotecas podem emitir avisos contendo metadados externos. Saídas são drenadas sem encaminhar ao logger.
    worker.stdout?.resume(); worker.stderr?.resume();
    return await new Promise<ReaderReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new DomainError('ATTACHMENT_UNREADABLE')), timeoutMs);
      const fail = (code: ReaderCode = 'ATTACHMENT_UNREADABLE'): void => { clearTimeout(timer); reject(new DomainError(code)); };
      worker!.once('message', (value: ReaderReply) => {
        if (value.error === 'ATTACHMENT_NO_TEXT' || value.error === 'ATTACHMENT_TYPE_UNSUPPORTED') fail(value.error);
        else if (value.error !== undefined) fail();
        else { clearTimeout(timer); resolve(value); }
      });
      worker!.once('error', () => fail());
      worker!.once('exit', () => fail());
    });
  } finally { if (worker) await worker.terminate(); active--; }
}

/** Extrai o texto de PDF, DOCX ou texto UTF-8 (inclui JSON), limitado a 500.000 caracteres. */
export async function extractDocument(bytes: Uint8Array, format: DocumentFormat, timeoutMs = 20_000): Promise<ExtractedDocument> {
  const value = await runReader(bytes, format, timeoutMs);
  if (typeof value.text === 'string' && value.text.length <= 500_000 && typeof value.truncated === 'boolean') return { text: value.text, truncated: value.truncated };
  throw new DomainError('ATTACHMENT_UNREADABLE');
}

/**
 * Confere uma planilha `.xlsx` sem extrair texto (phase 4, ATT-01): ZIP completo, tipo de conteúdo `spreadsheetml`, sem macros e dentro do
 * orçamento contra zip bomb. Recusa com `ATTACHMENT_TYPE_UNSUPPORTED` (não é planilha ou tem macro) ou `ATTACHMENT_UNREADABLE` (corrompida
 * ou grande demais descompactada).
 */
export async function validateSpreadsheet(bytes: Uint8Array, timeoutMs = 20_000): Promise<void> {
  if ((await runReader(bytes, 'xlsx', timeoutMs)).valid !== true) throw new DomainError('ATTACHMENT_UNREADABLE');
}
