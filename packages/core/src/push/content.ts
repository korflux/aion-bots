// Conteúdo do aviso (phase 16, passo 4; NOTIF-02, SEC-07): o título e o corpo em texto puro que a conferência do service worker devolve para um evento VÁLIDO de uma origem
// com "Mostrar conteúdo" ligado. É a ÚNICA peça que lê texto da conversa para o aviso, e o texto só sai pela resposta da conferência (`PushService.checkEvents`): o
// despachante nunca chama este módulo, então nada disso vai ao FCM, e nada aqui escreve em log ou auditoria.
//
// O que cada tipo mostra (decisão 2 da spec), sempre cortado em `PUSH_CONTENT_MAX` caracteres, em palavra, com reticências:
//   run_completed     o COMEÇO da resposta do bot (a primeira linha com texto, sem Markdown, `firstPlainLine` da prévia da lista de bots); numa rotina, o nome e o desfecho
//   run_failed        o título do cartão de falha ou de limite e, na falha, o motivo seguro: o texto público do código de erro; numa rotina, o nome e o desfecho
//   approval_pending  "Aprovação pendente: <ação> · <conta>", como o cartão de aprovação mostra, mais o id da aprovação (que habilita Aprovar e Recusar)
//   approval_expired  "Aprovação expirada: <ação> · <conta>"
// O título é o nome do bot ou "Chat geral". Quando o conteúdo do tipo não se monta (mensagem apagada, cartão ilegível), o corpo volta ao tipo do evento (`PUSH_EVENT_LABELS`);
// quando nem o bot existe mais, nada é devolvido e o aparelho mostra o aviso genérico.
//
// Fontes de verdade: o texto da resposta é `messages.content`; o cartão (aprovação, falha, limite, rotina) é `messages.data`, o mesmo que a conversa mostra, validado pelo schema
// dos cartões; a aprovação pendente é a tabela `approvals`. Nada é copiado para outra tabela.
//
// ponytail: o corpo da resposta é só a primeira linha com texto (`firstPlainLine`), então uma resposta que abre com "Claro!" mostra só isso; juntar as linhas seguintes até o
// limite se o dono achar o aviso curto demais.
import { ERROR_CODES, PUSH_CONTENT_MAX, PUSH_EVENT_LABELS, systemCardSchema, type SystemCard } from '@aion/shared';
import { cardTitleOf, firstPlainLine } from '../bots/preview';
import type { Queryable } from '../db/pool';
import { GENERAL_CHAT_PUSH_TITLE } from './dispatcher';
import type { PushEventFacts } from './validity';

/** O que a conferência acrescenta a um evento válido. `approvalId` só existe no `approval_pending` ainda pendente. */
export interface PushContent {
  title: string;
  body: string;
  approvalId?: string;
}

/**
 * Corta `text` em `max` pontos de código (reticências incluídas) sem partir uma palavra: o resultado termina na última palavra inteira que cabe, seguida de "…". Texto que já cabe
 * volta intacto. Uma palavra só maior que o limite é cortada no limite (corte duro). Conta pontos de código, então um emoji nunca vira meio caractere.
 */
export function clipAtWord(text: string, max: number = PUSH_CONTENT_MAX): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  let head = chars.slice(0, max - 1);
  // Se o caractere seguinte ao trecho não é espaço, a última palavra do trecho está partida: recua até o espaço anterior (se houver algum depois do começo).
  if (!/\s/u.test(chars[max - 1]!)) {
    const lastSpace = head.findLastIndex((char) => /\s/u.test(char));
    if (lastSpace > 0) head = head.slice(0, lastSpace);
  }
  return `${head.join('').trimEnd()}…`;
}

/** Texto puro de uma linha: caracteres de controle e quebras viram espaço, espaços repetidos viram um e as pontas saem. */
function plain(text: string): string {
  return text.replace(/\p{Cc}+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

interface MessageRow {
  kind: string;
  content: string;
  data: unknown;
}

/** A mensagem que o evento aponta (a última visível da execução), ou nula se foi apagada ou descartada. */
async function readMessage(db: Queryable, messageId: string | null): Promise<MessageRow | null> {
  if (messageId === null) return null;
  const found = await db.query<MessageRow>("SELECT kind, content, data FROM messages WHERE id = $1 AND status <> 'discarded'", [messageId]);
  return found.rows[0] ?? null;
}

/** O cartão de sistema de uma linha de mensagem, validado pelo schema (dado ilegível não derruba o aviso: volta nulo). */
function cardOf(row: MessageRow | null): SystemCard | null {
  if (row === null || row.kind !== 'card') return null;
  const parsed = systemCardSchema.safeParse(row.data);
  return parsed.success ? parsed.data : null;
}

/** O motivo público de um código de falha (a mensagem segura do registro de erros), ou nulo se o código não é do registro. */
function reasonOf(code: string | null): string | null {
  return code !== null && Object.hasOwn(ERROR_CODES, code) ? ERROR_CODES[code as keyof typeof ERROR_CODES].message : null;
}

/** "<título>: <motivo>" quando há motivo seguro; só o título senão. */
const withReason = (title: string, reason: string | null): string => (reason === null ? title : `${title}: ${reason}`);

/** O cartão de rotina da execução (criado ao começar e atualizado ao terminar), ou nulo se a execução não é de uma rotina. */
async function routineCardOf(db: Queryable, runId: string | null): Promise<Extract<SystemCard, { type: 'routine_run' }> | null> {
  if (runId === null) return null;
  const found = await db.query<MessageRow>("SELECT kind, content, data FROM messages WHERE run_id = $1 AND kind = 'card' AND data->>'type' = 'routine_run' ORDER BY id DESC LIMIT 1", [runId]);
  const card = cardOf(found.rows[0] ?? null);
  return card?.type === 'routine_run' ? card : null;
}

/** "<ação> · <conta>" como o cartão de aprovação mostra; sem conta (ação local de tabela ou doc), só a ação. */
function approvalWhat(card: Extract<SystemCard, { type: 'approval' }>): string {
  return [card.actionLabel, card.accountLabel].filter((part): part is string => part !== undefined && part !== '').join(' · ');
}

/** O corpo específico do tipo, ou nulo se não se monta (o chamador cai no tipo do evento). */
async function bodyOf(db: Queryable, event: PushEventFacts): Promise<string | null> {
  const message = await readMessage(db, event.message_id);
  const card = cardOf(message);

  if (event.kind === 'approval_pending' || event.kind === 'approval_expired') {
    if (card?.type !== 'approval') return null;
    const label = event.kind === 'approval_pending' ? 'Aprovação pendente' : 'Aprovação expirada';
    return `${label}: ${approvalWhat(card)}`;
  }

  // Execução de rotina: o nome e o desfecho, como o cartão da rotina na conversa; o motivo só quando falhou.
  const routine = await routineCardOf(db, event.run_id);
  if (routine !== null) {
    const failed = routine.state === 'failed';
    return withReason(cardTitleOf(routine), failed ? reasonOf(routine.failureCode) : null);
  }

  if (event.kind === 'run_completed') return message?.kind === 'text' ? firstPlainLine(message.content) || null : null;
  // run_failed: o cartão de falha ou de limite.
  if (card === null) return null;
  return withReason(cardTitleOf(card), card.type === 'run_failed' ? reasonOf(card.code) : null);
}

/** O id da aprovação que o `approval_pending` espera: a do cartão do evento ou, sem cartão, a pendente da execução (a mesma regra de `validity.ts`). */
async function pendingApprovalIdOf(db: Queryable, event: PushEventFacts): Promise<string | null> {
  const found = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM approvals
     WHERE status = 'pending' AND (card_id = $1::bigint OR ($1::bigint IS NULL AND run_id = $2::bigint))
     ORDER BY id LIMIT 1`,
    [event.message_id, event.run_id],
  );
  return found.rows[0]?.id ?? null;
}

/**
 * O conteúdo do aviso de um evento, ou nulo se não há para onde apontar (o bot do evento não existe mais). QUEM CHAMA já decidiu que o evento vale e que a chave da origem está
 * ligada (`PushService.checkEvents`); este módulo não repete a regra de validade nem lê a chave.
 */
export async function pushContentOf(db: Queryable, event: PushEventFacts): Promise<PushContent | null> {
  let title = GENERAL_CHAT_PUSH_TITLE;
  if (event.bot_id !== null) {
    const bot = await db.query<{ name: string }>('SELECT name FROM bots WHERE id = $1', [event.bot_id]);
    if (bot.rows[0] === undefined) return null;
    title = bot.rows[0].name;
  }
  const body = plain((await bodyOf(db, event)) ?? '') || PUSH_EVENT_LABELS[event.kind];
  const approvalId = event.kind === 'approval_pending' ? await pendingApprovalIdOf(db, event) : null;
  return { title: clipAtWord(plain(title) || GENERAL_CHAT_PUSH_TITLE), body: clipAtWord(body), ...(approvalId === null ? {} : { approvalId }) };
}
