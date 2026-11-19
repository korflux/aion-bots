// Serviço da memória global e por bot (F11, T8; MEM-01 e MEM-02): FONTE ÚNICA das regras de leitura, gravação, versões, restauração
// e retenção. A API (telas), a ferramenta interna do bot (`edit_memory`), o contexto do modelo e o job diário de retenção usam este
// arquivo; nenhum outro código escreve em `bot_memories`, `global_memory` ou `memory_versions`.
//
// Regras:
// - Uma memória é UM texto de até 8.000 caracteres (pontos de código, como o contador da tela e o CHECK do banco). Cada gravação
//   que muda o texto cria uma versão IMUTÁVEL (número crescente por memória). Restaurar e desfazer criam uma versão nova: o
//   histórico nunca é reescrito.
// - Gravar do dono exige a versão esperada. Divergiu = MEMORY_CONFLICT, e nada é alterado (a tela guarda o texto digitado). Texto
//   igual ao atual não cria versão nem conflita: repetir um salvamento é inofensivo.
// - A linha da memória (`FOR UPDATE`) serializa gravações da mesma memória: a versão nova é sempre a atual + 1, e o índice único
//   de (memória, versão) é a segunda defesa.
// - O bot só chega aqui por `editAsBot(botId, ...)` com o id do PRÓPRIO bot (vem do contexto da execução, nunca de argumento do
//   modelo); a memória global não tem caminho de escrita para o bot.
// - Retenção (MEM-01): versões com mais de 90 dias saem, mas as 50 mais recentes de cada memória ficam sempre.
import {
  MEMORY_MAX_CHARS,
  MEMORY_MIN_VERSIONS,
  MEMORY_RETENTION_DAYS,
  countChars,
  countDiff,
  diffLines,
  previewDiff,
  type DiffLine,
  type MemoryAuthor,
  type MemoryCard,
  type MemoryVersionDetail,
  type MemoryVersionList,
  type MemoryView,
} from '@aion/shared';
import { recordAudit } from '../audit';
import type { RequestOrigin } from '../auth/service';
import { recordConversationEvent } from '../conversation/events';
import { withTransaction, type Pool, type PoolClient, type Queryable } from '../db/pool';
import { DomainError } from '../errors';

/** Qual memória: a global (dono único) ou a de um bot. */
export type MemoryTarget = { scope: 'global' } | { scope: 'bot'; botId: string };

export interface MemoryServiceOptions {
  pool: Pool;
  /** Relógio injetável: os testes fixam o tempo (datas das versões e retenção). */
  now?: () => Date;
}

/** Quantas versões o histórico devolve (as mais recentes). ponytail: sem paginação, paginar se o histórico passar de algumas centenas. */
export const MEMORY_HISTORY_LIMIT = 200;

/** Linha da memória atual como o serviço a lê. */
interface MemoryRow {
  content: string;
  version: number;
  updated_at: Date | null;
  updated_by: MemoryAuthor | null;
}

const toView = (row: MemoryRow): MemoryView => ({
  content: row.content,
  version: row.version,
  limit: MEMORY_MAX_CHARS,
  updatedAt: row.updated_at?.toISOString() ?? null,
  updatedBy: row.updated_by,
});

/** O texto da memória depois de acrescentar `content` ao fim, em nova linha (sem linha em branco a mais quando já termina em quebra). */
const appended = (memory: string, content: string): string => `${memory}${memory === '' || memory.endsWith('\n') ? '' : '\n'}${content}`;

/** Texto novo de uma edição do bot: `append` junta ao fim em nova linha, `replace` troca tudo. */
export type BotMemoryEdit = { operation: 'append' | 'replace'; content: string };

/** Onde a edição do bot aconteceu: a conversa recebe o cartão, e a execução fica registrada na auditoria. */
export interface BotEditContext {
  conversationId: string;
  runId: string;
}

export type BotEditResult =
  | { status: 'updated'; version: number; size: number }
  | { status: 'unchanged'; version: number; size: number }
  /** O `append` repetia o da própria execução, já aplicado na versão atual (queda do worker ou nova tentativa): nada foi gravado. */
  | { status: 'repeated'; version: number; size: number }
  /** A edição deixaria a memória com `size` caracteres, acima do limite; nada foi alterado. */
  | { status: 'too_large'; size: number };

/** Condição SQL (e parâmetros) que escolhe as versões de uma memória em `memory_versions`. */
function versionsOf(target: MemoryTarget): { where: string; params: unknown[] } {
  return target.scope === 'bot' ? { where: 'bot_id = $1', params: [target.botId] } : { where: 'bot_id IS NULL', params: [] };
}

/**
 * As memórias que entram no contexto do modelo a cada etapa (a do bot e a global), lidas do estado atual. Sem bot (sessão do chat
 * geral) não há memória própria: só a global.
 */
export async function loadContextMemories(db: Queryable, botId: string | null): Promise<{ bot: string; global: string }> {
  const [bot, global] = await Promise.all([
    botId === null ? { rows: [] as { content: string }[] } : db.query<{ content: string }>('SELECT content FROM bot_memories WHERE bot_id = $1', [botId]),
    db.query<{ content: string }>('SELECT content FROM global_memory WHERE id = 1'),
  ]);
  return { bot: bot.rows[0]?.content ?? '', global: global.rows[0]?.content ?? '' };
}

export class MemoryService {
  private readonly pool: Pool;
  private readonly now: () => Date;

  constructor({ pool, now = () => new Date() }: MemoryServiceOptions) {
    this.pool = pool;
    this.now = now;
  }

  // ---------------------------------------------------------------------------------------------
  // Leitura
  // ---------------------------------------------------------------------------------------------

  /** Lê a linha atual da memória. Bot inexistente é BOT_NOT_FOUND; `lock` segura a linha até o fim da transação. */
  private async load(db: Queryable, target: MemoryTarget, lock = false): Promise<MemoryRow> {
    const suffix = lock ? ' FOR UPDATE' : '';
    const found =
      target.scope === 'bot'
        ? await db.query<MemoryRow>(`SELECT content, version, updated_at, updated_by FROM bot_memories WHERE bot_id = $1${suffix}`, [target.botId])
        : await db.query<MemoryRow>(`SELECT content, version, updated_at, updated_by FROM global_memory WHERE id = 1${suffix}`);
    const row = found.rows[0];
    if (!row) throw new DomainError('BOT_NOT_FOUND');
    return row;
  }

  /** A memória atual, com a versão que a tela deve devolver ao salvar. */
  async read(target: MemoryTarget): Promise<MemoryView> {
    return toView(await this.load(this.pool, target));
  }

  /** Histórico: as versões mais recentes primeiro, com autor, data e tamanho da mudança. */
  async listVersions(target: MemoryTarget): Promise<MemoryVersionList> {
    await this.load(this.pool, target);
    const { where, params } = versionsOf(target);
    const found = await this.pool.query<{ version: number; author: MemoryAuthor; created_at: Date; added: number; removed: number; restored_from: number | null }>(
      `SELECT version, author, created_at, added, removed, restored_from FROM memory_versions
       WHERE ${where} ORDER BY version DESC LIMIT ${MEMORY_HISTORY_LIMIT}`,
      params,
    );
    return {
      versions: found.rows.map((row) => ({
        version: row.version,
        author: row.author,
        createdAt: row.created_at.toISOString(),
        added: row.added,
        removed: row.removed,
        restoredFrom: row.restored_from,
      })),
    };
  }

  /**
   * Uma versão com o texto dela e o diff em relação à anterior (a versão 1, em relação ao vazio). Se a anterior já saiu pela
   * retenção não há base de comparação: o texto vem inteiro como "sem mudança" e o resumo (+/−) segue o gravado na época.
   */
  async getVersion(target: MemoryTarget, version: number): Promise<MemoryVersionDetail> {
    await this.load(this.pool, target);
    const { where, params } = versionsOf(target);
    const found = await this.pool.query<{ content: string; author: MemoryAuthor; created_at: Date; added: number; removed: number; restored_from: number | null }>(
      `SELECT content, author, created_at, added, removed, restored_from FROM memory_versions WHERE ${where} AND version = $${params.length + 1}`,
      [...params, version],
    );
    const row = found.rows[0];
    if (!row) throw new DomainError('MEMORY_VERSION_NOT_FOUND');
    let before: string | null = '';
    if (version > 1) {
      const previous = await this.pool.query<{ content: string }>(
        `SELECT content FROM memory_versions WHERE ${where} AND version = $${params.length + 1}`,
        [...params, version - 1],
      );
      before = previous.rows[0]?.content ?? null;
    }
    const diff: DiffLine[] =
      before === null ? (row.content === '' ? [] : row.content.split('\n').map((text) => ({ kind: 'same' as const, text }))) : diffLines(before, row.content);
    return {
      version,
      author: row.author,
      createdAt: row.created_at.toISOString(),
      added: row.added,
      removed: row.removed,
      restoredFrom: row.restored_from,
      content: row.content,
      diff,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Gravação
  // ---------------------------------------------------------------------------------------------

  /**
   * Núcleo da gravação, já dentro da transação e com a linha travada: cria a versão `atual + 1` e atualiza a memória. Quem chama
   * já decidiu que o texto muda e cabe no limite. Devolve a versão nova e o diff contra o texto anterior.
   */
  private async commit(
    tx: PoolClient,
    target: MemoryTarget,
    current: MemoryRow,
    content: string,
    author: MemoryAuthor,
    restoredFrom: number | null,
    at: Date,
  ): Promise<{ version: number; diff: DiffLine[] }> {
    const version = current.version + 1;
    const diff = diffLines(current.content, content);
    const { added, removed } = countDiff(diff);
    await tx.query(
      `INSERT INTO memory_versions (bot_id, version, content, author, restored_from, added, removed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [target.scope === 'bot' ? target.botId : null, version, content, author, restoredFrom, added, removed, at],
    );
    if (target.scope === 'bot') {
      await tx.query('UPDATE bot_memories SET content = $2, version = $3, updated_at = $4, updated_by = $5 WHERE bot_id = $1', [target.botId, content, version, at, author]);
    } else {
      await tx.query('UPDATE global_memory SET content = $1, version = $2, updated_at = $3, updated_by = $4 WHERE id = 1', [content, version, at, author]);
    }
    return { version, diff };
  }

  /** Auditoria de uma alteração da memória (quem, o quê, quando; nunca o texto). */
  private audit(tx: PoolClient, action: string, actor: 'owner' | 'system', target: MemoryTarget, version: number, at: Date, origin?: RequestOrigin) {
    return recordAudit(
      tx,
      {
        action,
        outcome: 'success',
        actor,
        ...(origin ? { ip: origin.ip, userAgent: origin.userAgent } : {}),
        target: target.scope === 'bot' ? target.botId : 'global',
        details: { scope: target.scope, version },
      },
      at,
    );
  }

  /**
   * Salva o texto digitado pelo dono. MEMORY_TOO_LARGE acima de 8.000 caracteres; MEMORY_CONFLICT se a versão mudou desde que a
   * tela a carregou. Texto igual ao atual devolve a memória como está, sem versão nova.
   */
  async save(target: MemoryTarget, content: string, expectedVersion: number, origin: RequestOrigin): Promise<MemoryView> {
    if (countChars(content) > MEMORY_MAX_CHARS) throw new DomainError('MEMORY_TOO_LARGE');
    const at = this.now();
    return withTransaction(this.pool, async (tx) => {
      const current = await this.load(tx, target, true);
      if (content === current.content) return toView(current);
      if (current.version !== expectedVersion) throw new DomainError('MEMORY_CONFLICT');
      const { version } = await this.commit(tx, target, current, content, 'owner', null, at);
      await this.audit(tx, 'memory.save', 'owner', target, version, at, origin);
      return toView({ content, version, updated_at: at, updated_by: 'owner' });
    });
  }

  /** Texto da versão `version` (0 é a memória vazia de antes da primeira gravação), ou MEMORY_VERSION_NOT_FOUND. */
  private async contentOfVersion(tx: Queryable, target: MemoryTarget, version: number): Promise<string> {
    if (version === 0) return '';
    const { where, params } = versionsOf(target);
    const found = await tx.query<{ content: string }>(`SELECT content FROM memory_versions WHERE ${where} AND version = $${params.length + 1}`, [...params, version]);
    const row = found.rows[0];
    if (!row) throw new DomainError('MEMORY_VERSION_NOT_FOUND');
    return row.content;
  }

  /**
   * Restaura uma versão antiga COMO VERSÃO NOVA (autor: dono). Mesma regra de conflito do salvamento. Restaurar o texto que já é o
   * atual não cria versão.
   */
  async restore(target: MemoryTarget, version: number, expectedVersion: number, origin: RequestOrigin): Promise<MemoryView> {
    const at = this.now();
    return withTransaction(this.pool, async (tx) => {
      const current = await this.load(tx, target, true);
      if (current.version !== expectedVersion) throw new DomainError('MEMORY_CONFLICT');
      const content = await this.contentOfVersion(tx, target, version);
      if (content === current.content) return toView(current);
      const saved = await this.commit(tx, target, current, content, 'owner', version, at);
      await this.audit(tx, 'memory.restore', 'owner', target, saved.version, at, origin);
      return toView({ content, version: saved.version, updated_at: at, updated_by: 'owner' });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Ferramenta do bot e desfazer pelo cartão
  // ---------------------------------------------------------------------------------------------

  /**
   * Edição feita pelo bot na PRÓPRIA memória (ferramenta `edit_memory`). Grava a versão (autor: bot) e o cartão "Memória
   * atualizada" na conversa, na mesma transação. Um `append` que repete o último da mesma execução não grava nada (`repeated`, ver
   * `isRepeatedAppend`). O bot não informa versão esperada: a edição vale sobre o texto atual, e cada
   * uma é versionada e desfazível pelo dono. ponytail: um `replace` sobre um texto que o dono acabou de mudar o sobrescreve (fica
   * no histórico), travar por versão se isso incomodar no uso real.
   */
  async editAsBot(botId: string, edit: BotMemoryEdit, context: BotEditContext): Promise<BotEditResult> {
    const target: MemoryTarget = { scope: 'bot', botId };
    const at = this.now();
    return withTransaction(this.pool, async (tx): Promise<BotEditResult> => {
      const current = await this.load(tx, target, true);
      if (edit.operation === 'append' && (await this.isRepeatedAppend(tx, target, current, edit.content, context.runId))) {
        return { status: 'repeated', version: current.version, size: countChars(current.content) };
      }
      const next = edit.operation === 'append' ? appended(current.content, edit.content) : edit.content;
      const size = countChars(next);
      if (size > MEMORY_MAX_CHARS) return { status: 'too_large', size };
      if (next === current.content) return { status: 'unchanged', version: current.version, size };

      const { version, diff } = await this.commit(tx, target, current, next, 'bot', null, at);
      const { added, removed } = countDiff(diff);
      const card: MemoryCard = {
        type: 'memory_updated',
        version,
        previousVersion: current.version,
        status: 'applied',
        added,
        removed,
        size,
        limit: MEMORY_MAX_CHARS,
        preview: previewDiff(diff),
      };
      // `content` vazio de propósito: o cartão é do dono; não entra na busca do histórico nem no contexto do modelo.
      const message = await tx.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, run_id, role, kind, status, content, data, created_at)
         VALUES ($1, $2, 'system', 'card', 'done', '', $3, $4) RETURNING id::text AS id`,
        [context.conversationId, context.runId, JSON.stringify(card), at],
      );
      await recordConversationEvent(tx, context.conversationId, 'message', (message.rows[0] as { id: string }).id, at);
      await this.audit(tx, 'memory.bot_edit', 'system', target, version, at);
      return { status: 'updated', version, size };
    });
  }

  /**
   * O `append` repete o que esta mesma execução acabou de gravar? (phase 15, A19.) Sim quando a versão atual é do bot, o cartão dela é da execução (`messages.run_id`) e o texto
   * atual é exatamente a versão anterior mais este trecho: a execução recomeçou depois de uma queda, ou o modelo tentou de novo, e o trecho já está no fim. Roda dentro da transação,
   * com a linha da memória travada (`FOR UPDATE`), então duas chamadas simultâneas se enfileiram e a segunda enxerga a versão da primeira; sem coluna nem índice novos, porque o
   * cartão da edição já guarda a execução e a versão. Qualquer outra coisa (o dono editou depois, outro trecho no meio, outra execução, o `replace`) é uma edição nova.
   */
  private async isRepeatedAppend(tx: PoolClient, target: MemoryTarget, current: MemoryRow, content: string, runId: string): Promise<boolean> {
    if (current.updated_by !== 'bot' || current.version < 1) return false;
    const card = await tx.query(
      "SELECT 1 FROM messages WHERE run_id = $1 AND kind = 'card' AND data->>'type' = 'memory_updated' AND (data->>'version')::int = $2 LIMIT 1",
      [runId, current.version],
    );
    if (card.rowCount === 0) return false;
    return appended(await this.contentOfVersion(tx, target, current.version - 1), content) === current.content;
  }

  /**
   * Desfazer pelo cartão "Memória atualizada": restaura o texto de antes da edição do bot como versão nova (autor: dono) e marca
   * o cartão como desfeito. O cartão tem de ser da conversa deste bot (IDOR) e a memória ainda tem de estar na versão que o bot
   * gravou: se mudou depois, desfazer apagaria o que veio depois, então é MEMORY_CONFLICT (o histórico permite restaurar).
   * ponytail: o cartão antigo segue mostrando "Desfazer" depois que a memória muda; o clique é recusado com conflito.
   */
  async undoCard(botId: string, cardId: string, origin: RequestOrigin): Promise<MemoryView> {
    const target: MemoryTarget = { scope: 'bot', botId };
    const at = this.now();
    return withTransaction(this.pool, async (tx) => {
      const found = await tx.query<{ conversation_id: string; data: MemoryCard }>(
        `SELECT m.conversation_id, m.data FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = $1 AND c.bot_id = $2 AND m.kind = 'card' AND m.data->>'type' = 'memory_updated' FOR UPDATE OF m`,
        [cardId, botId],
      );
      const card = found.rows[0];
      if (!card) throw new DomainError('NOT_FOUND');
      const current = await this.load(tx, target, true);
      if (card.data.status === 'undone') return toView(current);
      if (current.version !== card.data.version) throw new DomainError('MEMORY_CONFLICT');

      const content = await this.contentOfVersion(tx, target, card.data.previousVersion);
      const saved = await this.commit(tx, target, current, content, 'owner', card.data.previousVersion === 0 ? null : card.data.previousVersion, at);
      await tx.query("UPDATE messages SET data = data || '{\"status\": \"undone\"}'::jsonb WHERE id = $1", [cardId]);
      await recordConversationEvent(tx, card.conversation_id, 'message', cardId, at);
      await this.audit(tx, 'memory.undo', 'owner', target, saved.version, at, origin);
      return toView({ content, version: saved.version, updated_at: at, updated_by: 'owner' });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Retenção
  // ---------------------------------------------------------------------------------------------

  /**
   * Job diário (MEM-01): apaga as versões com mais de 90 dias, MANTENDO as 50 mais recentes de cada memória (a atual é sempre a
   * mais recente, então nunca sai). Devolve quantas apagou. Idempotente.
   */
  async purgeExpiredVersions(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - MEMORY_RETENTION_DAYS * 86_400_000);
    const removed = await this.pool.query(
      `DELETE FROM memory_versions WHERE id IN (
         SELECT id FROM (
           SELECT id, created_at, row_number() OVER (PARTITION BY bot_id ORDER BY version DESC) AS recency FROM memory_versions
         ) ranked
         WHERE recency > $1 AND created_at < $2)`,
      [MEMORY_MIN_VERSIONS, cutoff],
    );
    return removed.rowCount ?? 0;
  }
}
