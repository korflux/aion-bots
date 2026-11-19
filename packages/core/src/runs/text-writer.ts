// Grava no banco, aos poucos, o texto que o modelo vai produzindo numa etapa. Existe porque o streaming chega em pedaços
// minúsculos (palavra a palavra) e gravar cada um seria um UPDATE e um evento por pedaço.
//
// Como funciona: os pedaços se acumulam em memória e uma gravação junta tudo o que chegou a cada `flushMs` (a primeira sai
// na hora, para a bolha aparecer logo). Cada gravação é `content = content || pedaço` mais um evento de "mensagem mudou"
// na MESMA transação, então quem acompanha o SSE nunca vê um evento sem o texto correspondente. As gravações são
// encadeadas (nunca duas ao mesmo tempo), o que preserva a ordem do texto.
//
// A linha nasce `streaming` e `finish()` a marca `done`. `cancel()` (worker encerrando) para de gravar e deixa a linha como
// está: a retomada a descarta e a etapa é refeita do zero.
import type { Pool, PoolClient } from '../db/pool';
import { withTransaction } from '../db/pool';
import { recordConversationEvent } from '../conversation/events';
import { holdLease } from './lease';
import { validateEvidence, type EvidenceProvenance } from './evidence-provenance';
import { DomainError } from '../errors';

export interface TextWriterOptions {
  /** Closure do request que produziu o texto; NULL conserva desconhecimento legado. */
  evidence?: EvidenceProvenance;
  botId?: string | null;
  pool: Pool;
  conversationId: string;
  runId: string;
  /** Token da posse da execução: cada gravação confere que ainda é o dono (ver `lease.ts`). */
  owner: string;
  /** Etapa do modelo a que este texto pertence (agrupa o texto com as chamadas de ferramenta da mesma etapa). */
  step: number;
  flushMs: number;
  now: () => Date;
}

export class TextWriter {
  private messageId: string | null = null;
  private pending = '';
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private firstFlushDone = false;
  /** O modelo produziu algum texto nesta etapa? */
  wrote = false;

  constructor(private readonly options: TextWriterOptions) {}

  /** Acumula um pedaço e agenda a gravação. Nunca bloqueia o stream; erros de gravação aparecem em `finish()`. */
  push(text: string): void {
    this.pending += text;
    this.wrote = true;
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.enqueueFlush();
      }, this.firstFlushDone ? this.options.flushMs : 0);
    }
  }

  private enqueueFlush(): void {
    this.chain = this.chain
      .then(() => this.flush())
      .catch((error: unknown) => {
        this.failure ??= error;
      });
  }

  /** Grava o que se acumulou: cria a linha no primeiro pedaço e acrescenta nos seguintes, com o evento na mesma transação. */
  private async flush(): Promise<void> {
    const chunk = this.pending;
    if (chunk === '') return;
    this.pending = '';
    const { pool, conversationId, runId, owner, step, now } = this.options;
    const at = now();
    await withTransaction(pool, async (tx) => {
      await holdLease(tx, runId, owner);
      // Fonte revogada depois da reserva da chamada: a resposta derivada dela não é persistida (`CONTEXT_EVIDENCE_UNAVAILABLE`, não falha de resumo).
      if (this.options.evidence && !await validateEvidence(tx, conversationId, this.options.botId ?? null, this.options.evidence)) throw new DomainError('CONTEXT_EVIDENCE_UNAVAILABLE');
      if (this.messageId === null) {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO messages (conversation_id, run_id, role, kind, status, step, content, created_at, evidence_provenance)
           VALUES ($1, $2, 'assistant', 'text', 'streaming', $3, $4, $5, $6) RETURNING id`,
          [conversationId, runId, step, chunk, at, this.options.evidence === undefined ? null : JSON.stringify(this.options.evidence)],
        );
        this.messageId = (inserted.rows[0] as { id: string }).id;
      } else {
        await tx.query('UPDATE messages SET content = content || $2 WHERE id = $1', [this.messageId, chunk]);
      }
      await recordConversationEvent(tx, conversationId, 'message', this.messageId, at);
    });
    this.firstFlushDone = true;
  }

  /** Grava o resto e fecha a mensagem; `incomplete` preserva o trecho; checkpoint grava a decisão de continuação na mesma transação, inclusive sem texto. Lança o primeiro erro de gravação. */
  async finish(incomplete = false, checkpoint?: (tx: PoolClient) => Promise<void>): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.enqueueFlush();
    await this.chain;
    if (this.failure !== null) throw this.failure;
    if (this.messageId === null && !checkpoint) return;
    const { pool, conversationId, runId, owner, now } = this.options;
    const at = now();
    const id = this.messageId;
    await withTransaction(pool, async (tx) => {
      await holdLease(tx, runId, owner);
      if (this.options.evidence && !await validateEvidence(tx, conversationId, this.options.botId ?? null, this.options.evidence)) throw new DomainError('CONTEXT_EVIDENCE_UNAVAILABLE');
      if (id !== null) {
        await tx.query("UPDATE messages SET status = 'done', data = coalesce(data, '{}'::jsonb) || $2::jsonb WHERE id = $1", [id, JSON.stringify(incomplete ? { incomplete: true } : {})]);
        await recordConversationEvent(tx, conversationId, 'message', id, at);
      }
      await checkpoint?.(tx);
    });
  }

  /** Para de gravar sem fechar a mensagem (o worker está encerrando e a retomada descartará este texto). */
  async cancel(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = '';
    await this.chain;
  }
}
