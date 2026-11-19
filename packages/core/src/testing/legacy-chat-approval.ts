// Semeador da "aprovação pendente antiga no Chat geral" (phase 13, A6 e A7), compartilhado pelos testes do núcleo, da API e pelo controle da pilha do E2E (import de `@aion/core/testing`).
//
// Por que existe: o conector saiu do Chat geral na phase 13 e nenhuma mensagem cria mais uma pendência de ação do conector numa sessão. Só a pendência gravada ANTES do deploy continua
// possível (a que o dono ainda responde depois dele, A7), e os testes que provam a recusa dela, a retenção, o rollback da 0012, o push "Chat geral" e a tela de Atividades precisam
// do banco nesse estado exato. Esta é a fonte única da forma dessa linha: uma mudança no esquema de `runs`, `messages` ou `approvals` se corrige aqui, uma vez, e não em cada teste.
//
// O estado semeado é o que a phase 12 deixava: execução em `waiting_approval` (com `tool_calls = 1`), a mensagem do dono que abriu a rodada (encadeada à rodada anterior da sessão por
// `parent_run_id`, como o motor faz), a atividade "aguardando" da chamada pela "porta" `composio_execute_action`, a ação "vista" que o pedido referencia e o pedido com o cartão, criados por
// `ApprovalService.createPending`, o mesmo código de produção. Tudo numa transação: a sessão nunca fica com a execução sem o pedido.
import type { ApprovalService } from '../approvals/service';
import { withTransaction, type Pool } from '../db/pool';
import { enqueuePushEvent } from '../push/outbox';

export interface SeedLegacyChatApprovalInput {
  pool: Pool;
  approvals: ApprovalService;
  /** Sessão do Chat geral (conversa sem bot) onde a pendência nasce. */
  sessionId: string;
  /** Texto da mensagem do dono que abriu a rodada (vira `runs.input`). Padrão: um pedido de e-mail com o marcador `[gmail]` do modelo falso. */
  input?: string;
  /**
   * Grava a proveniência da atividade (`evidence_provenance`) vazia e válida. Sem ela (o padrão), o conteúdo da atividade sai do pedido ao modelo, e a recusa de A7 é uma das saídas que o
   * modelo lê mesmo assim; com ela, a atividade volta ao pedido como a de qualquer ferramenta com proveniência conhecida.
   */
  withProvenance?: boolean;
  /** Enfileira o aviso push `approval_pending` na mesma transação, como a pausa do executor (`pauseForApproval`); só tem efeito com dispositivo registrado. */
  queuePush?: boolean;
}

/** Ação do conector (Gmail) que a pendência semeada pede: fixa, porque o que os testes provam não depende de qual ação pediu. */
const SEEDED_CALL = {
  id: 'call_antiga',
  name: 'GMAIL_SEND_EMAIL',
  arguments: JSON.stringify({ to: 'dono@example.com', subject: 'Relatório', body: 'Olá, segue o relatório.' }),
  via: 'composio_execute_action',
};
const SEEDED_ACTION = { slug: 'GMAIL_SEND_EMAIL', label: 'Send Email · Gmail', appSlug: 'gmail', appName: 'Gmail' };

/** Deixa a aprovação pendente antiga na sessão e devolve a execução (já em `waiting_approval`) e o id do pedido. */
export async function seedLegacyChatApproval({
  pool,
  approvals,
  sessionId,
  input = '[gmail] envie o relatório',
  withProvenance = false,
  queuePush = false,
}: SeedLegacyChatApprovalInput): Promise<{ runId: string; approvalId: string }> {
  return withTransaction(pool, async (tx) => {
    const id = async (sql: string, params: unknown[]): Promise<string> => (await tx.query<{ id: string }>(sql, params)).rows[0]!.id;
    // A rodada anterior da sessão, se houver, é o pai da nova mensagem, como o motor encadeia.
    const parent = (await tx.query<{ id: string }>('SELECT id::text AS id FROM runs WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [sessionId])).rows[0]?.id ?? null;
    const runId = await id("INSERT INTO runs (conversation_id, status, input, created_at, started_at) VALUES ($1, 'waiting_approval', $2, now(), now()) RETURNING id::text AS id", [sessionId, input]);
    const opener = await id(
      "INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, parent_run_id, created_at) VALUES ($1, $2, 'user', 'text', 'done', true, $3, $4, now()) RETURNING id::text AS id",
      [sessionId, runId, input, parent],
    );
    await tx.query('UPDATE runs SET trigger_message_id = $2, tool_calls = 1 WHERE id = $1', [runId, opener]);
    const data = {
      callId: SEEDED_CALL.id,
      tool: SEEDED_CALL.name,
      label: SEEDED_ACTION.label,
      arguments: SEEDED_CALL.arguments,
      detail: null,
      via: SEEDED_CALL.via,
      external: true,
      awaitingApproval: true,
    };
    const provenance = withProvenance ? JSON.stringify({ attachments: [], tables: [], docs: [] }) : null;
    const activityId = await id(
      "INSERT INTO messages (conversation_id, run_id, role, kind, status, step, data, created_at, tool_arguments, evidence_provenance) VALUES ($1, $2, 'assistant', 'activity', 'running', 1, $3, now(), $4, $5::jsonb) RETURNING id::text AS id",
      [sessionId, runId, JSON.stringify(data), SEEDED_CALL.arguments, provenance],
    );
    await approvals.resolve(tx, null, SEEDED_ACTION); // a ação "vista" que o pedido referencia
    const { approvalId } = await approvals.createPending(tx, { runId, botId: null, conversationId: sessionId, action: SEEDED_ACTION, step: 1, activityId, call: SEEDED_CALL, remaining: [] });
    if (queuePush) await enqueuePushEvent(tx, 'approval_pending', runId, new Date());
    return { runId, approvalId };
  });
}
