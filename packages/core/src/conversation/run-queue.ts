// Inserção de uma execução na fila de uma conversa: o ÚNICO lugar que cria linhas `queued` em `runs`, usado pela mensagem do dono
// (`ConversationService`), pelas rotinas (disparo da agenda e "Executar agora") e pela promoção de complementos no desfecho (`complements.ts`).
// Assim a regra "fila FIFO por conversa, até 20 aguardando" não se duplica. A conversa de um bot é 1:1 com ele (a fila "do bot"); a sessão do
// chat geral tem a fila própria.
//
// A trava (`SELECT ... FOR UPDATE`) serializa quem enfileira na mesma fila: dois envios simultâneos não furam o teto de 20, e arquivar
// o bot (que também trava a linha dele) não corre ao lado de um disparo de rotina. Num bot trava-se o bot; numa sessão, a conversa
// (que também é o que a retenção trava ao apagar, então um envio nunca cai numa sessão sendo apagada).
//
// A manutenção de contexto (a execução sem rodada que compacta o histórico) também entra por aqui, em `queueContextMaintenance`: o clique do dono em "Compactar agora" e a
// compactação fria enfileirada pelo worker (phase 11, T8) compartilham a mesma inserção, o mesmo recibo e a mesma auditoria.
//
// Partes reaproveitadas fora de `queueRun`:
// - `lockPendingAttachments`: as regras de anexo de um envio, valendo também para o complemento (Suposição 19), e `lockVersionAttachments`, a
//   variante da edição no Chat geral, que também aceita arquivos já ligados a outra versão (phase 4, ATT-01);
// - `insertQueuedRun`: a inserção sem a trava do dono, para a promoção de complementos, que já segura a trava da EXECUÇÃO e não pode travar o dono
//   depois dela (impasse com o envio, ver `complements.ts`).
import { ATTACHMENT_LIMIT, QUEUE_LIMIT_PER_BOT } from '@aion/shared';
import { recordAudit } from '../audit';
import type { PoolClient, Queryable } from '../db/pool';
import { DomainError } from '../errors';
import { modelCredentialKind } from '../models/service';
import { recordConversationEvent } from './events';
import { RUN_COLUMNS, type RunRow } from './views';
import { resolveModelChoice } from './model-choice';

export interface QueueRunInput {
  /** Nulo na execução de uma sessão do chat geral (conversa sem bot). */
  botId: string | null;
  conversationId: string;
  /** Texto da execução: a mensagem do dono ou a instrução da rotina. */
  input: string;
  /** Só existe na repetição de uma execução que falhou (a mensagem do dono já está na linha do tempo). */
  triggerMessageId?: string | null;
  /** Pendentes do envio novo; retry usa os arquivos da mensagem existente. */
  attachmentIds?: readonly string[];
  /** Origem de rotina: o id e o nome na hora do disparo. */
  routine?: { id: string; name: string };
  at: Date;
  /**
   * Aplica o teto de 20 aguardando. O disparo da agenda não o aplica (a própria rotina já tem no máximo uma aguardando e o limite é
   * para barrar rajadas de mensagens do dono); "Executar agora" o aplica porque é um clique do dono como qualquer envio.
   */
  enforceLimit: boolean;
  /** Manutenção não tem mensagem/rodada; continua na mesma fila FIFO e sob o mesmo mutex. */
  contextOperationId?: string;
}

/**
 * Trava e confere os arquivos pendentes de um envio (mensagem ou complemento) da conversa: até 5, sem repetição, da própria conversa, ainda
 * soltos (nem execução, nem mensagem, nem complemento) e não removidos; com imagem, o modelo efetivo da conversa precisa de visão confirmada.
 * Recusa ATTACHMENT_LIMIT_REACHED, ATTACHMENT_NOT_FOUND (inclui repetido/alheio/ligado/removido) e MODEL_NO_IMAGE_SUPPORT.
 */
export async function lockPendingAttachments(tx: Queryable, conversationId: string, attachmentIds: readonly string[]): Promise<void> {
  if (attachmentIds.length > ATTACHMENT_LIMIT) throw new DomainError('ATTACHMENT_LIMIT_REACHED');
  if (new Set(attachmentIds).size !== attachmentIds.length) throw new DomainError('ATTACHMENT_NOT_FOUND');
  if (!attachmentIds.length) return;
  const files = await tx.query<{ id: string; kind: string }>(
    `SELECT id, kind FROM attachments WHERE conversation_id = $1 AND id = ANY($2::bigint[])
     AND run_id IS NULL AND message_id IS NULL AND complement_id IS NULL AND removed_at IS NULL ORDER BY id FOR UPDATE`,
    [conversationId, attachmentIds],
  );
  if (files.rows.length !== attachmentIds.length) throw new DomainError('ATTACHMENT_NOT_FOUND');
  await assertImagesAccepted(tx, conversationId, files.rows);
}

/** Com imagem entre os arquivos, o modelo efetivo da conversa precisa de visão confirmada pelo servidor; senão MODEL_NO_IMAGE_SUPPORT. */
async function assertImagesAccepted(tx: Queryable, conversationId: string, files: readonly { kind: string }[]): Promise<void> {
  if (!files.some((file) => file.kind === 'image')) return;
  const model = (await resolveModelChoice(tx, conversationId)).model;
  const profile = await tx.query<{ accepts_images: boolean | null }>('SELECT accepts_images FROM model_profiles WHERE model_id = $1', [model]);
  if (profile.rows[0]?.accepts_images !== true) throw new DomainError('MODEL_NO_IMAGE_SUPPORT');
}

/**
 * Trava e confere os arquivos da versão nova de uma mensagem editada (phase 4, F1, ATT-01): até 5, sem repetição, da própria sessão, não removidos
 * e fora de complemento ou rascunho; cada um é PENDENTE do composer (solto, vira da mensagem nova) ou já LIGADO a uma mensagem da sessão (a
 * versão nova ganha um vínculo extra, sem copiar o arquivo, então o espaço conta uma vez). Arquivo de execução que ainda não começou fica de fora
 * (não existe com a sessão parada). Mesmas recusas de `lockPendingAttachments`.
 */
export async function lockVersionAttachments(tx: Queryable, conversationId: string, attachmentIds: readonly string[]): Promise<{ pending: string[]; linked: string[] }> {
  if (attachmentIds.length > ATTACHMENT_LIMIT) throw new DomainError('ATTACHMENT_LIMIT_REACHED');
  if (new Set(attachmentIds).size !== attachmentIds.length) throw new DomainError('ATTACHMENT_NOT_FOUND');
  if (!attachmentIds.length) return { pending: [], linked: [] };
  const files = await tx.query<{ id: string; kind: string; linked: boolean }>(
    `SELECT id::text AS id, kind, message_id IS NOT NULL AS linked FROM attachments WHERE conversation_id = $1 AND id = ANY($2::bigint[])
     AND removed_at IS NULL AND complement_id IS NULL AND (message_id IS NOT NULL OR run_id IS NULL) ORDER BY id FOR UPDATE`,
    [conversationId, attachmentIds],
  );
  if (files.rows.length !== attachmentIds.length) throw new DomainError('ATTACHMENT_NOT_FOUND');
  await assertImagesAccepted(tx, conversationId, files.rows);
  return { pending: files.rows.filter((file) => !file.linked).map((file) => file.id), linked: files.rows.filter((file) => file.linked).map((file) => file.id) };
}

/** Cria fila, vínculo de anexos e evento atomicamente. Recusa QUEUE_FULL, BOT_NOT_FOUND, SESSION_NOT_FOUND e os erros de `lockPendingAttachments`. */
export async function queueRun(tx: PoolClient, { botId, conversationId, input, triggerMessageId = null, attachmentIds = [], routine, at, enforceLimit, contextOperationId }: QueueRunInput): Promise<RunRow> {
  const locked =
    botId === null
      ? await tx.query('SELECT id FROM conversations WHERE id = $1 AND bot_id IS NULL FOR UPDATE', [conversationId])
      : await tx.query('SELECT id FROM bots WHERE id = $1 FOR UPDATE', [botId]);
  // Exclusão do bot ou retenção da sessão entre resolução e trava deve responder erro de domínio antes do INSERT/FK.
  if (locked.rowCount === 0) throw new DomainError(botId === null ? 'SESSION_NOT_FOUND' : 'BOT_NOT_FOUND');
  // Locks de arquivo depois do dono da fila: descarte concorrente ou outro envio só podem ganhar uma vez.
  await lockPendingAttachments(tx, conversationId, attachmentIds);
  if (enforceLimit) {
    const queued = await tx.query<{ total: string }>("SELECT count(*) AS total FROM runs WHERE conversation_id = $1 AND status = 'queued'", [conversationId]);
    if (Number(queued.rows[0]?.total ?? 0) >= QUEUE_LIMIT_PER_BOT) throw new DomainError('QUEUE_FULL');
  }
  return insertQueuedRun(tx, { botId, conversationId, input, triggerMessageId, routine, at, contextOperationId }, attachmentIds);
}

/**
 * Por que uma compactação por resumo NÃO pode ser enfileirada agora, ou nulo se pode: a conversa não tem modelo escolhido ou o modelo não tem protocolo validado
 * (`MODEL_UNAVAILABLE`) ou não há chave do provedor (`PROVIDER_NOT_CONFIGURED`). O resumo é uma chamada paga, então as duas condições valem para quem enfileira, antes do
 * custo: o clique do dono as recusa com o erro (`ConversationService.maintainContext`) e o worker da compactação fria só desiste em silêncio (`enqueueColdCompaction`).
 */
export async function summarizeBlocker(db: Queryable, conversationId: string): Promise<'MODEL_UNAVAILABLE' | 'PROVIDER_NOT_CONFIGURED' | null> {
  const choice = await resolveModelChoice(db, conversationId);
  if (choice.model === null) return 'MODEL_UNAVAILABLE';
  if (!(await db.query('SELECT 1 FROM model_profiles WHERE model_id = $1 AND test_protocol IS NOT NULL', [choice.model])).rowCount) return 'MODEL_UNAVAILABLE';
  // A chave é a do provedor do modelo da conversa (a Anthropic tem a dela).
  if (!(await db.query('SELECT 1 FROM credentials WHERE kind = $1', [modelCredentialKind(choice.model)])).rowCount) return 'PROVIDER_NOT_CONFIGURED';
  return null;
}

export interface QueueContextMaintenanceInput {
  /** Nulo na conversa de uma sessão do chat geral. */
  botId: string | null;
  conversationId: string;
  /** Identidade idempotente da operação (também é `runs.context_operation_id`): o pedido do dono a traz do cliente, a compactação fria a deriva da conversa e da revisão. */
  requestId: string;
  mode: 'elision' | 'summarize';
  /** Revisão do contexto que quem enfileirou viu: o executor só prossegue se ela ainda for a vigente (CAS). */
  expectedRevision: number;
  /** Sessão do dono que pediu "Compactar agora"; NULA na compactação fria, enfileirada pelo worker sem gesto do dono (migration 0048). É a marca de "manutenção fria". */
  sessionId: string | null;
  at: Date;
}

/**
 * Enfileira uma manutenção de contexto (compactação por resumo) na fila FIFO da conversa e grava o recibo dela, atomicamente e sob a trava do dono da fila. Fonte única das duas
 * origens: o clique do dono em "Compactar agora" (`ConversationService.maintainContext`) e o worker que compacta a conversa que esfriou (`enqueueColdCompaction`,
 * `runs/cold-maintenance.ts`). Quem chama confere antes o que lhe cabe (execução ativa, revisão, modelo e chave, limites); aqui só entram a execução, a linha de
 * `context_maintenance` e a auditoria. A auditoria diz quem pediu: `owner` num clique, `system` (com `trigger: 'cold'`) no worker.
 */
export async function queueContextMaintenance(tx: PoolClient, { botId, conversationId, requestId, mode, expectedRevision, sessionId, at }: QueueContextMaintenanceInput): Promise<RunRow> {
  const run = await queueRun(tx, { botId, conversationId, input: '[Manutenção de contexto]', at, enforceLimit: true, contextOperationId: requestId });
  await tx.query('INSERT INTO context_maintenance(request_id,conversation_id,run_id,session_id,mode,expected_revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [requestId, conversationId, run.id, sessionId, mode, expectedRevision, at]);
  await recordAudit(tx, { action: 'context.maintenance_requested', actor: sessionId === null ? 'system' : 'owner', outcome: 'success', target: conversationId, details: { requestId, mode, ...(sessionId === null ? { trigger: 'cold' } : {}) } }, at);
  return run;
}

/**
 * Só a inserção: a execução `queued`, o vínculo dos anexos já conferidos (que deixam de pertencer a um complemento, se pertenciam) e o evento.
 * Sem trava nem teto: quem chama já garantiu a ordem (ver o cabeçalho).
 */
export async function insertQueuedRun(
  tx: Queryable,
  { botId, conversationId, input, triggerMessageId = null, routine, at, contextOperationId }: Omit<QueueRunInput, 'attachmentIds' | 'enforceLimit'>,
  attachmentIds: readonly string[],
): Promise<RunRow> {
  const inserted = await tx.query<RunRow>(
    `INSERT INTO runs (conversation_id, bot_id, input, trigger_message_id, routine_id, routine_name, created_at,context_operation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7,$8) RETURNING ${RUN_COLUMNS}`,
    [conversationId, botId, input, triggerMessageId, routine?.id ?? null, routine?.name ?? null, at,contextOperationId ?? null],
  );
  const row = inserted.rows[0] as RunRow;
  if (attachmentIds.length) {
    await tx.query('UPDATE attachments SET run_id = $1, complement_id = NULL WHERE id = ANY($2::bigint[]) AND conversation_id = $3', [row.id, attachmentIds, conversationId]);
  }
  await recordConversationEvent(tx, conversationId, contextOperationId ? 'context' : 'run', contextOperationId ? '0' : row.id, at);
  return row;
}
