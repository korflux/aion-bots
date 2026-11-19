// Serviço da tela Atividades (F15, A14; T11): leitura que INDEXA o que já existe (aprovações pendentes e execuções de todos os bots e
// das sessões do chat geral), sem tabela nem estado próprios. É o único lugar que monta a visão; a API só repassa. Quem muda as execuções e as aprovações continua
// sendo o motor e o `ApprovalService`: aqui nada é escrito.
//
// Duas listas, as duas só de leitura:
// - PENDENTES: pedidos `pending` ainda dentro do prazo (a mesma definição do badge da barra, `ApprovalService.pendingCount`), do que vence
//   primeiro ao que vence depois. Sem paginação: há no máximo UM pedido aberto por execução e UMA execução ativa por conversa (índices
//   únicos no banco), então o total nunca passa do número de bots e sessões.
// - RECENTES: execuções da mais nova para a mais antiga, paginadas por cursor (o id da última execução da página; o id é crescente com a
//   criação). `cancelled` fica de fora (a execução de rotina que saiu da fila sem começar: não há cartão nem o que mostrar).
// ponytail: sem filtro por bot, estado ou período, e a lista de recentes não tem retenção; o filtro entra se o volume tornar a rolagem
// impraticável, e a retenção junto com a do histórico das conversas.
import { ACTIVITIES_PAGE_SIZE, type ActivitiesPage, type RunStatus } from '@aion/shared';
import { readActivePath } from '../conversation/path';
import { lastVisibleRunMessageSql } from '../conversation/views';
import type { Pool } from '../db/pool';

export interface ActivityServiceOptions {
  pool: Pool;
  /** Relógio injetável: os testes fixam o instante que separa pendência vigente de vencida. */
  now?: () => Date;
}

/**
 * Colunas do dono repetidas nas duas consultas: o bot (avatar, nome e se está arquivado) ou, numa sessão do chat geral, só o id da
 * sessão (as colunas do bot vêm nulas, pelo LEFT JOIN). `conversation_id` é o id da sessão quando não há bot.
 */
interface OwnerColumns {
  bot_id: string | null;
  bot_name: string | null;
  bot_color: string | null;
  bot_archived: boolean | null;
  conversation_id: string;
}

/** Junta a conversa e o bot (se houver) de uma linha que tem `conversation_id` em `ref`. */
const ownerSelect = (conversationRef: string): string =>
  `b.id AS bot_id, b.name AS bot_name, b.color AS bot_color, b.archived_at IS NOT NULL AS bot_archived, ${conversationRef} AS conversation_id`;

/**
 * O dono como a tela o recebe: `bot` preenchido, ou `sessionId` preenchido (nunca os dois). O `??` só atende o tipo do LEFT JOIN, que nunca deixa
 * nome e cor nulos quando há bot.
 */
const ownerOf = (row: OwnerColumns) =>
  row.bot_id === null
    ? { bot: null, sessionId: row.conversation_id }
    : {
        bot: { id: row.bot_id, name: row.bot_name ?? '', color: row.bot_color ?? '', archived: row.bot_archived === true },
        sessionId: null,
      };

export class ActivityService {
  private readonly pool: Pool;
  private readonly now: () => Date;

  constructor({ pool, now = () => new Date() }: ActivityServiceOptions) {
    this.pool = pool;
    this.now = now;
  }

  /**
   * Uma página da tela. Sem `cursor` é a primeira: traz as pendências e as 50 execuções mais recentes. Com `cursor` traz só as 50
   * seguintes (as pendências não se repetem). `nextCursor` é nulo na última página.
   */
  async list(cursor: string | undefined): Promise<ActivitiesPage> {
    const [pending, recent] = await Promise.all([cursor === undefined ? this.pending() : Promise.resolve([]), this.recent(cursor)]);
    return { pending, ...recent };
  }

  /** Aprovações respondíveis agora, com o cartão da conversa para onde o clique leva. */
  private async pending(): Promise<ActivitiesPage['pending']> {
    // A conta do conector (phase 13, A9) vem da chamada gravada no pedido (`call.account.label`, a mesma do cartão); pedido de antes da phase ou ação sem conta não a tem.
    // O título do doc (decisão 23, A35) vem do impacto que o executor gravou no cartão da aprovação (`approvals.card_id` -> `messages.data->'impact'`, a mesma fonte que o cartão da conversa mostra),
    // só quando o impacto é de exclusão de doc: sem coluna nova, sem migration e sem campo na `call` gravada (que a retomada reexecuta, e que o modelo escreveu). Ação do conector, tabelas e
    // pedido gravado antes da decisão não o têm.
    const found = await this.pool.query<OwnerColumns & { id: string; run_id: string; card_id: string | null; label: string; account_label: string | null; doc_title: string | null; expires_at: Date }>(
      `SELECT a.id::text AS id, a.run_id::text AS run_id, a.card_id::text AS card_id, a.expires_at, x.label, a.call->'account'->>'label' AS account_label,
              CASE WHEN c.data->'impact'->>'kind' = 'delete_doc' THEN c.data->'impact'->>'docTitle' END AS doc_title, ${ownerSelect('a.conversation_id')}
       FROM approvals a
       LEFT JOIN bots b ON b.id = a.bot_id
       LEFT JOIN messages c ON c.id = a.card_id
       JOIN approval_actions x ON x.slug = a.action_slug
       WHERE a.status = 'pending' AND a.expires_at > $1
       ORDER BY a.expires_at, a.id`,
      [this.now()],
    );
    return found.rows.map((row) => ({
      approvalId: row.id,
      runId: row.run_id,
      ...ownerOf(row),
      actionLabel: row.label,
      ...(row.account_label === null ? {} : { accountLabel: row.account_label }),
      ...(row.doc_title === null ? {} : { docTitle: row.doc_title }),
      expiresAt: row.expires_at.toISOString(),
      messageId: row.card_id,
    }));
  }

  /**
   * As execuções em vigor no caminho visível de cada sessão dada (phase 4, `readActivePath`, a mesma fonte da conversa): o que não está aqui é de
   * outra versão ou de uma rodada retrocedida. Uma leitura do caminho por sessão distinta da página.
   * ponytail: uma consulta recursiva por sessão da página (até 50), trocar por uma leitura em lote se Atividades ficar lenta com muitas sessões.
   */
  private async sessionPathRuns(sessionIds: readonly string[]): Promise<Set<string>> {
    const runs = new Set<string>();
    for (const sessionId of new Set(sessionIds)) {
      for (const round of (await readActivePath(this.pool, sessionId)).rounds) if (round.runId !== null) runs.add(round.runId);
    }
    return runs;
  }

  /** Execuções da mais nova à mais antiga, uma a mais que a página para saber se há próxima (cursor = id da última da página). */
  private async recent(cursor: string | undefined): Promise<Pick<ActivitiesPage, 'items' | 'nextCursor'>> {
    const found = await this.pool.query<OwnerColumns & { id: string; status: RunStatus; routine_name: string | null; created_at: Date; message_id: string | null }>(
      `SELECT r.id::text AS id, r.status, r.routine_name, r.created_at, ${ownerSelect('r.conversation_id')},
              coalesce(${lastVisibleRunMessageSql('r.id')}, r.trigger_message_id)::text AS message_id
       FROM runs r
       LEFT JOIN bots b ON b.id = r.bot_id
       WHERE r.status <> 'cancelled' AND r.context_operation_id IS NULL AND ($1::bigint IS NULL OR r.id < $1::bigint)
       ORDER BY r.id DESC
       LIMIT $2`,
      [cursor ?? null, ACTIVITIES_PAGE_SIZE + 1],
    );
    const page = found.rows.slice(0, ACTIVITIES_PAGE_SIZE);
    const onPath = await this.sessionPathRuns(page.filter((row) => row.bot_id === null && row.message_id !== null).map((row) => row.conversation_id));
    return {
      items: page.map((row) => ({
        runId: row.id,
        ...ownerOf(row),
        routineName: row.routine_name,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        messageId: row.message_id,
        // Phase 4 (Suposição 12): execução de sessão com cartão na conversa, mas fora do caminho visível (outra versão ou rodada retrocedida). Só vai
        // quando verdadeiro (o contrato normaliza a ausência para falso), então as demais execuções saem como antes.
        ...(row.bot_id === null && row.message_id !== null && !onPath.has(row.id) ? { offPath: true } : {}),
      })),
      nextCursor: found.rows.length > ACTIVITIES_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
