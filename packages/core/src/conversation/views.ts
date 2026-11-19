// Linhas do banco da conversa (`messages`, `runs`) e o mapeamento delas para os contratos públicos de @aion/shared.
//
// É o ÚNICO lugar que converte linha -> visão, usado por igual pelo snapshot, pela paginação e pelo SSE: a tela nunca
// vê uma forma diferente da mesma mensagem conforme o caminho por onde ela chegou.
import { ACTIVE_RUN_STATUSES, type ActivityDetail, type ArtifactRef, type AttachmentKind, type ComplementView, type ConversationAttachment, type GeneratedFormat, type MessageView, type RunStatus, type RunView, type SystemCard } from '@aion/shared';
import type { Queryable } from '../db/pool';
import { clipText } from '../runs/untrusted-content';
import { readPendingComplements } from './complements';

/**
 * Vínculo mensagem -> anexo como subconsulta (`message_id`, `attachment_id`): o dono original (`attachments.message_id`) e os vínculos extras de
 * uma edição que manteve o arquivo de outra versão (`message_attachment_links`, phase 4 ATT-01). Fonte única de "os arquivos desta mensagem" para
 * a tela, o contexto do modelo e a regra de arquivo em uso; o arquivo é uma linha só, então o espaço conta uma vez.
 */
export const MESSAGE_ATTACHMENTS_SQL = `(SELECT message_id, id AS attachment_id FROM attachments WHERE message_id IS NOT NULL
  UNION ALL SELECT message_id, attachment_id FROM message_attachment_links)`;

/** Colunas lidas de `messages` (ordem e nomes que `MessageRow` espelha). */
export const MESSAGE_COLUMNS = 'id, run_id, role, kind, status, opens_round, step, content, data, created_at';

export interface MessageRow {
  /** bigint do banco, entregue pelo driver como texto. */
  id: string;
  run_id: string | null;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'activity' | 'card';
  status: 'streaming' | 'done' | 'running' | 'completed' | 'failed' | 'discarded';
  opens_round: boolean;
  step: number | null;
  content: string;
  data: unknown;
  created_at: Date;
}

/** Campos de `messages.data` de uma atividade (o resultado fica em `content`). */
export interface ActivityData {
  /** Id da chamada como o modelo a conhece (volta no turno de resultado da ferramenta). */
  callId: string;
  tool: string;
  label: string;
  arguments: string;
  /** Detalhe para a tela, no tipo do contrato compartilhado: busca no histórico, pesquisa na web (`web_search`) e leitura de páginas (`web_fetch`, T9). */
  detail: ActivityDetail | null;
  /** A ação espera a resposta do dono (aprovação pendente); sai da marca quando a execução retoma ou o pedido termina. */
  awaitingApproval?: boolean;
  /** Ferramenta com efeito fora do Aion (ação do Composio): interrompida sem resultado, a ação pode ter sido concluída. */
  external?: boolean;
  /**
   * Quando o modelo chamou uma "porta" (o conector, T29, `composio_execute_action`, ou a `use_tool`, phase 15), `tool` e `arguments` são os do DESTINO (o que a tela mostra) e
   * `via` guarda o nome da porta: o contexto do modelo reconstrói a chamada como ele a fez (ver `buildTurns`).
   */
  via?: string;
  /**
   * O resultado é de uma ferramenta SEM limite próprio (gravado íntegro até 256 KiB, CTX-10): a tela mostra só o começo (`RESULT_VIEW_MAX_CHARS`). Gravado pelo executor
   * ao fechar a atividade; linhas antigas não o têm e continuam como estavam (eram cortadas em 8.000 antes de gravar). Ferramenta autolimitada nunca o leva.
   */
  genericResult?: boolean;
  /**
   * Os artefatos (tabela ou doc) que a chamada criou ou alterou, com o título lido no servidor (phase 14, A4). Gravado pelo executor ao fechar uma atividade CONCLUÍDA de uma ferramenta que mexe em
   * artefato (`ToolOutcome.artifacts`); ausente nas demais e nas linhas antigas. Vai à tela no campo de mesmo nome da atividade e é o que os cartões de artefato da conversa agrupam.
   */
  artifacts?: ArtifactRef[];
}

/**
 * Teto, em caracteres, do resultado de ferramenta GENÉRICO na tela (phase 9, CTX-10: antes de gravar íntegro, o resultado já vinha cortado em 8.000, e a tela
 * segue igual). O íntegro fica em `messages.content`, e o modelo o lê por `read_activity`. É a mesma regra de cada via (snapshot, paginação e SSE), pois todas
 * convertem por `toMessageView`.
 */
export const RESULT_VIEW_MAX_CHARS = 8_000;

/** O resultado como a tela o recebe: o começo (sem partir emoji) e o aviso de que o íntegro está guardado, só quando o resultado é genérico e passa do teto. */
function resultForView(content: string, data: ActivityData): string {
  if (data.genericResult !== true || content.length <= RESULT_VIEW_MAX_CHARS) return content;
  const shown = clipText(content, RESULT_VIEW_MAX_CHARS);
  return `${shown}\n[mostrando ${shown.length.toLocaleString('pt-BR')} de ${content.length.toLocaleString('pt-BR')} caracteres; o resultado completo está guardado na conversa]`;
}

/**
 * O cartão como a web o recebe. `messages.data` do cartão pode levar `restore`, o instantâneo interno que só o servidor lê para desfazer a exclusão de uma rotina na recusa
 * (`routines/service.ts`): é a linha da rotina com as ocorrências e as execuções dela, nada que a tela use e nada que o navegador deva ver. O contrato do cartão não o declara e
 * o serializador da resposta HTTP já o remove, mas o canal SSE repassa o objeto como está; descartar a chave aqui, na conversão única de cartão (snapshot, paginação e SSE
 * passam por `toMessageView`), cobre todas as vias de uma vez, sem depender de cada consumidor lembrar. O dado gravado na linha não muda.
 */
function cardForView(data: unknown): SystemCard {
  const { restore: _restore, ...card } = data as SystemCard & { restore?: unknown };
  return card;
}

/**
 * Converte uma linha e os metadados já carregados, sem IO por item. `model` é o modelo da última chamada da execução (`runs.last_model`), que só
 * a resposta do assistente leva (F7); a mensagem do dono nunca leva o campo.
 */
export function toMessageView(row: MessageRow, attachments: ConversationAttachment[] = [], model: string | null = null): MessageView {
  const base = { id: row.id, runId: row.run_id, attachments, createdAt: row.created_at.toISOString() };
  if (row.kind === 'activity') {
    const data = row.data as ActivityData;
    return {
      ...base,
      kind: 'activity',
      status: row.status as 'running' | 'completed' | 'failed' | 'discarded',
      step: row.step ?? 0,
      tool: data.tool,
      label: data.label,
      arguments: data.arguments,
      result: row.status === 'running' ? null : resultForView(row.content, data),
      detail: data.detail ?? null,
      awaitingApproval: data.awaitingApproval === true,
      ...(data.artifacts?.length ? { artifacts: data.artifacts } : {}),
    };
  }
  if (row.kind === 'card') {
    return { ...base, kind: 'card', status: 'done', content: row.content, card: cardForView(row.data) };
  }
  return {
    ...base,
    kind: 'text',
    role: row.role as 'user' | 'assistant',
    status: row.status as 'streaming' | 'done' | 'discarded',
    content: row.content,
    ...(row.role === 'assistant' ? { model } : {}),
    ...(row.role === 'assistant' && (row.data as { incomplete?: unknown } | null)?.incomplete === true ? { incomplete: true } : {}),
    // Mensagem do dono lida como complemento durante a execução (phase 4, F5): a marca vive em `data` (ver `absorbComplements`).
    ...(row.role === 'user' && (row.data as { complement?: unknown } | null)?.complement === true ? { complement: true } : {}),
  };
}

/**
 * Subconsulta (escalar) da mensagem que REPRESENTA uma execução na conversa: a ÚLTIMA que o dono enxerga, cartão ou texto (nunca
 * atividade de ferramenta nem descartada). É para onde o toque do push e o clique em Atividades levam, então a regra mora num lugar só.
 * `runRef` é uma referência SQL à execução (ex.: `r.id`), escrita pelo código, nunca um valor vindo do cliente.
 */
export const lastVisibleRunMessageSql = (runRef: string): string =>
  `(SELECT m.id FROM messages m WHERE m.run_id = ${runRef} AND m.kind IN ('card', 'text') AND m.status <> 'discarded' ORDER BY m.id DESC LIMIT 1)`;

/** Colunas lidas de `runs`. */
export const RUN_COLUMNS =
  'id, conversation_id, bot_id, status, input, trigger_message_id, routine_id, routine_name, tool_calls, active_ms, stop_requested_at, failure_code, created_at, started_at, finished_at, context_operation_id';

export interface RunRow {
  /** Operação sem rodada/cartão; projetada somente pelo estado de contexto. */
  context_operation_id?: string | null;
  id: string;
  conversation_id: string;
  /** Nulo na execução de uma sessão do chat geral (conversa sem bot). */
  bot_id: string | null;
  status: RunStatus;
  input: string;
  trigger_message_id: string | null;
  /** Rotina que disparou a execução (nula se foi uma mensagem do dono ou se a rotina foi excluída) e o nome dela na hora do disparo. */
  routine_id: string | null;
  routine_name: string | null;
  tool_calls: number;
  active_ms: number;
  stop_requested_at: Date | null;
  failure_code: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Execução recém-reivindicada por um worker: a linha e o token de posse (ver `runs/lease.ts`). */
export interface ClaimedRunRow extends RunRow {
  lease_owner: string;
}

/** Colunas devolvidas por uma reivindicação: as da execução mais o token da posse (nunca vai a uma visão pública). */
export const CLAIM_COLUMNS = `${RUN_COLUMNS}, lease_owner::text AS lease_owner`;

/**
 * O texto da mensagem só vai à tela enquanto a execução está na fila; depois ele já é uma mensagem da linha do tempo. `complements` são os
 * pendentes da execução ativa (phase 4, F5), que a tela mostra como "Complemento · aguardando".
 */
export function toRunView(row: RunRow, attachments: ConversationAttachment[] = [], complements: ComplementView[] = []): RunView {
  return {
    id: row.id,
    attachments,
    complements,
    status: row.status,
    input: row.status === 'queued' ? row.input : null,
    routineName: row.routine_name,
    toolCalls: row.tool_calls,
    failureCode: row.failure_code,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

interface AttachmentMetadataRow {
  owner_id: string;
  id: string;
  name: string;
  kind: AttachmentKind;
  /** Só no arquivo gerado pelo Python (decide PNG inline ou cartão na tela). */
  format: GeneratedFormat | null;
  original_bytes: number;
  removed: boolean;
}

/** Agrupa somente metadados pelo dono da visão, preservando a ordem de upload. */
function groupAttachments(rows: AttachmentMetadataRow[]): Map<string, ConversationAttachment[]> {
  const grouped = new Map<string, ConversationAttachment[]>();
  for (const row of rows) {
    const files = grouped.get(row.owner_id) ?? [];
    files.push({ id: row.id, name: row.name, kind: row.kind, sizeBytes: row.original_bytes, removed: row.removed, ...(row.format ? { format: row.format } : {}) });
    grouped.set(row.owner_id, files);
  }
  return grouped;
}

/**
 * Uma consulta de metadados por página/SSE inteiro (nunca seleciona bytes ou conteúdo extraído) e, havendo respostas do assistente, uma do
 * modelo das execuções delas: execução sem modelo registrado (anterior à migration 0023) devolve a resposta com `model: null`.
 */
export async function readMessageViews(db: Queryable, rows: MessageRow[]): Promise<MessageView[]> {
  if (!rows.length) return [];
  const found = await db.query<AttachmentMetadataRow>(
    `SELECT l.message_id::text AS owner_id, a.id, a.name, a.kind, a.format, a.original_bytes, a.removed_at IS NOT NULL AS removed
     FROM ${MESSAGE_ATTACHMENTS_SQL} l JOIN attachments a ON a.id = l.attachment_id WHERE l.message_id = ANY($1::bigint[]) ORDER BY a.id`, [rows.map((row) => row.id)],
  );
  const grouped = groupAttachments(found.rows);
  const answerRuns = [...new Set(rows.flatMap((row) => (row.kind === 'text' && row.role === 'assistant' && row.run_id !== null ? [row.run_id] : [])))];
  const models = new Map<string, string>();
  if (answerRuns.length) {
    const recorded = await db.query<{ id: string; last_model: string }>(
      'SELECT id::text AS id, last_model FROM runs WHERE id = ANY($1::bigint[]) AND last_model IS NOT NULL', [answerRuns],
    );
    for (const run of recorded.rows) models.set(run.id, run.last_model);
  }
  return rows.map((row) => toMessageView(row, grouped.get(row.id), row.run_id === null ? null : (models.get(row.run_id) ?? null)));
}

/**
 * Retry herda anexos pelo trigger (inclusive os que uma edição manteve de outra versão); o arquivo segue vinculado à execução original, sem
 * duplicar dados. Os complementos pendentes saem de uma
 * consulta em lote só para as execuções ativas (as outras nunca os têm).
 */
export async function readRunViews(db: Queryable, rows: RunRow[]): Promise<RunView[]> {
  rows = rows.filter((row) => !row.context_operation_id);
  if (!rows.length) return [];
  const found = await db.query<AttachmentMetadataRow>(
    `SELECT r.id::text AS owner_id, a.id, a.name, a.kind, a.format, a.original_bytes, a.removed_at IS NOT NULL AS removed
     FROM runs r JOIN attachments a ON a.run_id = r.id OR a.id IN (SELECT l.attachment_id FROM ${MESSAGE_ATTACHMENTS_SQL} l WHERE l.message_id = r.trigger_message_id)
     WHERE r.id = ANY($1::bigint[]) AND a.conversation_id = r.conversation_id ORDER BY r.id, a.id`, [rows.map((row) => row.id)],
  );
  const grouped = groupAttachments(found.rows);
  const complements = await readPendingComplements(db, rows.filter((row) => ACTIVE_RUN_STATUSES.includes(row.status)).map((row) => row.id));
  return rows.map((row) => toRunView(row, grouped.get(row.id), complements.get(row.id)));
}
