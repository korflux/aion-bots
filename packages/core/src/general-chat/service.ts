// Serviço das sessões do chat geral (F16, A15; T12, T16): abrir o "Novo chat", listar, salvar e apagar por retenção. Uma sessão é uma conversa sem bot
// (`conversations.bot_id` nulo, ver a migration 0012); tudo que acontece DENTRO dela (mensagens, execuções, aprovações, SSE) é do
// `ConversationService` e do motor, que tratam a sessão como tratam a conversa de um bot. Aqui mora só o que é próprio da sessão: o
// ciclo de vida temporário.
//
// Regra de expiração (spec decisão 17): uma sessão NÃO salva expira 7 dias depois da última mensagem (ou da criação, se ainda não tem
// nenhuma). Salvar suspende a exclusão; desligar volta a contar a partir da última mensagem, então uma sessão salva há muito tempo e
// desligada agora já nasce vencida e sai no próximo job. A "última mensagem" é a atividade mais recente da linha do tempo (qualquer
// linha, do dono ou do bot): enquanto o bot trabalha ou o dono conversa, a sessão não vence.
//
// Rascunho (T16): a sessão ainda sem nenhuma mensagem ou execução é o "Novo chat" que a tela abre sozinha ao entrar no chat geral. Ela
// existe no banco (a conversa precisa de um id para o modelo, o SSE e as preferências), mas NÃO é uma sessão do ponto de vista do dono:
// fica fora da lista e `openDraft` devolve sempre a mesma enquanto nada for escrito nela. Assim abrir o chat geral muitas vezes, ou clicar em
// "Novo chat" sem escrever, não acumula sessões vazias.
//
// ponytail: a lista (e a vista "Salvos", que é a mesma lista filtrada) devolve só as 200 sessões mais recentes e a atividade é calculada na consulta (sem coluna
// própria); paginar ou desnormalizar `last_activity_at` se as sessões salvas passarem de algumas centenas.
import { CHAT_SESSIONS_LIST_LIMIT, CHAT_SESSION_RETENTION_MS, type ChatSession, type ChatSessionList } from '@aion/shared';
import { withTransaction, type Pool, type PoolClient, type Queryable } from '../db/pool';
import { DomainError } from '../errors';
import { eraseConversationAttachments } from '../attachments/lifecycle';
import { hasUnreadSql } from '../presence/service';

/** Chave da trava (advisory lock) que serializa `openDraft`: um número fixo qualquer, só precisa ser o mesmo em todas as chamadas. */
const DRAFT_LOCK_KEY = 7_461_016;

export interface GeneralChatServiceOptions {
  pool: Pool;
  /** Relógio injetável: os testes simulam as datas da retenção. */
  now?: () => Date;
}

interface SessionRow {
  id: string;
  title: string | null;
  saved: boolean;
  created_at: Date;
  last_activity_at: Date;
  /** Novidade não lida na sessão (regra única `hasUnreadSql`, T5). */
  unread: boolean;
}

/** Atividade mais recente da sessão: a última linha da conversa, ou a criação enquanto ela está vazia. */
const LAST_ACTIVITY_SQL = 'coalesce((SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at)';

/** Colunas da sessão como o painel a lista, inclusive `unread` (F4): a mesma regra da lista de bots, na mesma consulta (sem N+1). */
const SESSION_SELECT = `SELECT c.id, c.title, c.saved, c.created_at, ${LAST_ACTIVITY_SQL} AS last_activity_at, ${hasUnreadSql('c')} AS unread
  FROM conversations c WHERE c.bot_id IS NULL`;

/** Rascunho (ver o cabeçalho): sem mensagem, sem execução (uma mensagem só entra na linha do tempo quando o worker começa a execução) e não salva. */
const IS_DRAFT_SQL =
  'NOT c.saved AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id) AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.context_operation_id IS NULL)';

/** Execução ainda aberta (na fila, trabalhando ou esperando aprovação): uma sessão com trabalho em curso nunca é apagada. */
const OPEN_RUN_SQL = "EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.status IN ('queued', 'running', 'waiting_approval'))";

/** Sessão vencida: não salva, sem trabalho em curso e com a última atividade antes do corte (`$1`). */
const EXPIRED_SQL = `c.bot_id IS NULL AND NOT c.saved AND ${LAST_ACTIVITY_SQL} < $1 AND NOT ${OPEN_RUN_SQL}`;

/** A sessão como o painel a lista; `expiresAt` é nulo quando salva, e senão 7 dias depois da última atividade. */
const toView = (row: SessionRow): ChatSession => ({
  id: row.id,
  title: row.title,
  saved: row.saved,
  createdAt: row.created_at.toISOString(),
  lastActivityAt: row.last_activity_at.toISOString(),
  expiresAt: row.saved ? null : new Date(row.last_activity_at.getTime() + CHAT_SESSION_RETENTION_MS).toISOString(),
  unread: row.unread,
});

export class GeneralChatService {
  private readonly pool: Pool;
  private readonly now: () => Date;

  constructor({ pool, now = () => new Date() }: GeneralChatServiceOptions) {
    this.pool = pool;
    this.now = now;
  }

  /**
   * "Novo chat" (é o que a API e a tela usam): devolve o rascunho vazio que já existe ou cria um. Não há limite de criação por minuto
   * porque não há o que acumular: enquanto nada for escrito na sessão devolvida, chamar de novo devolve a mesma, e uma sessão nova só
   * nasce depois que a anterior recebeu uma mensagem (limitada pelo teto de mensagens por minuto da conversa).
   * Ao reaproveitar, a data de criação é renovada: um rascunho esquecido há quase 7 dias não pode ser apagado pela retenção logo depois
   * de o dono começar a escrever nele.
   */
  async openDraft(): Promise<ChatSession> {
    const id = await withTransaction(this.pool, async (tx) => {
      // Duas aberturas ao mesmo tempo (duas abas, ou o efeito executado duas vezes em desenvolvimento) acabam na MESMA sessão.
      await tx.query('SELECT pg_advisory_xact_lock($1)', [DRAFT_LOCK_KEY]);
      const at = this.now();
      const draft = await tx.query<{ id: string }>(
        `SELECT c.id FROM conversations c WHERE c.bot_id IS NULL AND ${IS_DRAFT_SQL} ORDER BY c.created_at DESC, c.id LIMIT 1`,
      );
      const existing = draft.rows[0];
      if (existing) {
        await tx.query('UPDATE conversations SET created_at = $2 WHERE id = $1', [existing.id, at]);
        return existing.id;
      }
      return this.insertEmpty(tx, at);
    });
    return this.get(id);
  }

  /** Insere uma conversa de sessão vazia e devolve o id: o único INSERT de sessões, de `openDraft` e de `create`. */
  private async insertEmpty(db: Queryable, at: Date): Promise<string> {
    const created = await db.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES ($1) RETURNING id', [at]);
    return (created.rows[0] as { id: string }).id;
  }

  /** Insere uma sessão vazia sem procurar rascunho. As rotas usam `openDraft`; este método só existe para os testes que precisam de várias sessões vazias ao mesmo tempo. */
  async create(): Promise<ChatSession> {
    return this.get(await this.insertEmpty(this.pool, this.now()));
  }

  /**
   * As sessões do painel, da mais recentemente ativa para a mais antiga. O rascunho vazio fica de fora (ver o cabeçalho). Com `saved`, só as salvas (a vista "Salvos" de
   * `/chats`): o filtro entra ANTES do limite, então uma sessão salva antiga aparece mesmo havendo mais de 200 sessões recentes (um filtro no navegador a perderia).
   */
  async list({ saved = false }: { saved?: boolean } = {}): Promise<ChatSessionList> {
    const found = await this.pool.query<SessionRow>(
      `${SESSION_SELECT} AND NOT (${IS_DRAFT_SQL})${saved ? ' AND c.saved' : ''} ORDER BY last_activity_at DESC, c.created_at DESC LIMIT $1`,
      [CHAT_SESSIONS_LIST_LIMIT],
    );
    return { items: found.rows.map(toView) };
  }

  /** Uma sessão. Lança SESSION_NOT_FOUND (apagada ou inexistente). */
  async get(id: string): Promise<ChatSession> {
    const found = await this.pool.query<SessionRow>(`${SESSION_SELECT} AND c.id = $1`, [id]);
    const row = found.rows[0];
    if (!row) throw new DomainError('SESSION_NOT_FOUND');
    return toView(row);
  }

  /** Liga ou desliga "salvar". Idempotente. Lança SESSION_NOT_FOUND. */
  async setSaved(id: string, saved: boolean): Promise<ChatSession> {
    const updated = await this.pool.query('UPDATE conversations SET saved = $2 WHERE id = $1 AND bot_id IS NULL', [id, saved]);
    if (updated.rowCount === 0) throw new DomainError('SESSION_NOT_FOUND');
    return this.get(id);
  }

  /**
   * Retenção (job diário do worker): apaga as sessões vencidas, com mensagens, execuções, aprovações e eventos. Cada sessão sai numa
   * transação própria que trava a conversa e CONFERE DE NOVO o vencimento: um "salvar" ou uma mensagem que chegou depois da
   * listagem vence a corrida (o envio trava a mesma linha em `queueRun`). Devolve quantas sessões foram apagadas.
   *
   * Uma sessão que não pode ser apagada (uma chave estrangeira nova sem tratamento em `purgeOne`, por exemplo) NÃO impede as outras: a
   * falha é guardada, o laço segue, e no fim o job falha com um `AggregateError` que diz quantas ficaram e quantas saíram. Assim a
   * promessa dos 7 dias continua valendo para as demais, e o defeito aparece como falha do job, e não como silêncio (R15).
   */
  async purgeExpired(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - CHAT_SESSION_RETENTION_MS);
    const candidates = await this.pool.query<{ id: string }>(`SELECT c.id FROM conversations c WHERE ${EXPIRED_SQL}`, [cutoff]);
    let removed = 0;
    const failures: unknown[] = [];
    for (const { id } of candidates.rows) {
      try {
        if (await withTransaction(this.pool, (tx) => this.purgeOne(tx, id, cutoff))) removed += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `retenção do chat geral: ${failures.length} sessão(ões) não puderam ser apagadas e ${removed} apagada(s)`);
    }
    return removed;
  }

  /** Apaga UMA sessão se ela ainda estiver vencida, na ordem que as chaves estrangeiras pedem. Devolve se apagou. */
  private async purgeOne(tx: PoolClient, id: string, cutoff: Date): Promise<boolean> {
    // Trava e confere em DOIS comandos de propósito: no READ COMMITTED as subconsultas de um comando usam o instante em que ELE começou,
    // então uma conferência junto da trava não veria a mensagem que o envio gravou enquanto esta transação esperava a trava.
    const locked = await tx.query('SELECT id FROM conversations WHERE id = $1 AND bot_id IS NULL FOR UPDATE', [id]);
    if (locked.rowCount === 0) return false;
    const stillExpired = await tx.query(`SELECT 1 FROM conversations c WHERE c.id = $2 AND ${EXPIRED_SQL}`, [cutoff, id]);
    if (stillExpired.rowCount === 0) return false;
    // Pedidos de aprovação apontam para execuções e mensagens; a execução aponta para a mensagem que a abriu e a mensagem para a
    // execução, então a referência de volta é desfeita antes de apagar as mensagens. Os avisos de push saem junto das execuções (cascata).
    await tx.query('DELETE FROM approvals WHERE conversation_id = $1', [id]);
    await tx.query('UPDATE runs SET trigger_message_id = NULL WHERE conversation_id = $1', [id]);
    await eraseConversationAttachments(tx, id);
    // Complementos e rascunho devolvido (phase 4): apontam para execuções e são apontados pelos anexos, que já saíram.
    await tx.query('DELETE FROM complements WHERE conversation_id = $1', [id]);
    await tx.query('DELETE FROM messages WHERE conversation_id = $1', [id]);
    await tx.query('DELETE FROM runs WHERE conversation_id = $1', [id]);
    await tx.query('DELETE FROM conversation_events WHERE conversation_id = $1', [id]);
    await tx.query('DELETE FROM conversations WHERE id = $1', [id]);
    return true;
  }
}
