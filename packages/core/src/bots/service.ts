// Serviço de bots (F5 e F6): criar, editar, arquivar, desarquivar e excluir definitivamente. Fonte única das regras de A4 e A7; a API só traduz
// HTTP <-> chamadas deste serviço e a validação de formato (tamanhos, allowlist) acontece na borda, com os
// schemas de @aion/shared. Aqui ficam as regras que dependem do estado: unicidade do nome e existência do recurso.
//
// Decisões:
// - Nome único sem diferenciar maiúsculas entre bots NÃO arquivados: `name_key` (minúsculas, NFC) com índice único
//   parcial no banco. A checagem de verdade é o índice (criações concorrentes com o mesmo nome: uma vence); a
//   violação vira BOT_NAME_TAKEN.
// - Criar o bot cria, na mesma transação, a conversa única (1:1) e a memória vazia (PROD-02). Mensagens e
//   execuções (T6) e versões da memória (T8) estendem essas linhas, não as substituem.
// - Arquivar não apaga nada: conversa e memória permanecem (spec decisão 16). Arquivar e desarquivar são
//   idempotentes (repetir não erra nem gera auditoria).
// - Excluir (`deleteArchived`, DATA-01) é o ÚNICO caminho que apaga um bot e é irreversível: só vale para bot arquivado, sem execução
//   em andamento ou na fila e com o nome digitado igual ao gravado. Apaga tudo do bot numa transação e deixa só a auditoria, sem nome.
// - Modelo e effort: o formato é do schema; "o modelo consta na lista atual do provedor" e "o effort é um dos níveis
//   gravados para o modelo" dependem de estado e são conferidos aqui, via `ModelSelectionValidator` (ModelService), ANTES
//   da transação (a conferência pode chamar o provedor e não deve segurar o banco). Só se confere o que MUDOU: um modelo
//   que saiu do catálogo depois não impede editar o nome ou as instruções do bot.
// - O bot não tem personagem: a identidade visual é a Faísca na cor do bot (phase 5; a coluna `bots.mascot` saiu na migration 0028). `mascot` em criar ou
//   editar é recusado na borda como campo desconhecido (`strictObject` dos schemas de @aion/shared).
// - A lista (`list`) devolve também o estado ao vivo de cada bot (`runState`, F10): uma consulta só traz os fatos (execução ativa, última execução
//   terminal, contagem de rotinas e rotinas pausadas) e a regra de precedência é `botRunStateOf` (@aion/shared), a mesma conversão de status de execução
//   em estado do mascote que a tela Atividades usa. O estado nunca é gravado: deriva de `runs`, `routines` e `bots.archived_at`, sem coluna nem migration.
// - A lista traz também a PRÉVIA da última novidade visível da conversa (`preview`, phase 5 T5): o MESMO SELECT busca, por uma junção lateral, a última mensagem que é
//   novidade visível (`VISIBLE_NEWS_SQL`, a mesma regra da bolinha de não lido) e `preview.ts` a transforma em texto de uma linha. Derivada, nunca gravada, e fora dos logs.
// - Toda operação por id confere que o bot existe (BOT_NOT_FOUND); com dono único não há outro "dono" a comparar,
//   mas a leitura e a escrita nunca confiam no id vindo do cliente sem consultar o registro.
// - Só as colunas de `COLUMN_BY_FIELD` são atualizáveis: o SQL dinâmico do UPDATE monta nomes a partir dessa
//   allowlist fixa, nunca das chaves recebidas (sem injeção e sem mass assignment), e os valores vão parametrizados.
import { ACTIVE_RUN_STATUSES, OPEN_RUN_STATUSES, botRunStateOf, type Bot, type BotCreate, type BotRunFacts, type BotSummary, type BotUpdate, type EffortLevel, type RunStatus, type SystemCard } from '@aion/shared';
import pg from 'pg';
import type { AuditEvent } from '../audit';
import { recordAudit } from '../audit';
import { eraseConversationAttachments } from '../attachments/lifecycle';
import type { RequestOrigin } from '../auth/service';
import { SlidingWindowLimiter } from '../credentials/rate-limit';
import { withTransaction, type Pool, type PoolClient } from '../db/pool';
import { DomainError } from '../errors';
import { resolveBotModelChoice } from '../conversation/model-choice';
import { readBotObjective } from './objectives';
import { readModelContextCapacity } from '../models/context-capacity';
import { VISIBLE_NEWS_SQL, hasUnreadSql } from '../presence/service';
import { lockRoutinesOfBot, pauseRoutinesOfBot } from '../routines/queue';
import { previewOf } from './preview';
import { CONNECTOR_ACCOUNTS_LOCK } from '../credentials/accounts';
import { DOC_MUTATION_LOCK } from '../docs/service';
import { TABLE_MUTATION_LOCK } from '../tables/service';

/** Nome do índice único parcial (migration 0004); identifica a violação de "nome já usado". */
const ACTIVE_NAME_INDEX = 'bots_active_name_key';

/** Teto de exclusões definitivas por minuto (F6, "Rate limit"): freia uma sessão sequestrada ou um laço que apagaria vários bots. */
export const BOT_DELETES_PER_MINUTE = 5;

/** Campo público -> coluna. Única porta de entrada de nomes de coluna no UPDATE. */
const COLUMN_BY_FIELD = {
  name: 'name',
  color: 'color',
  instructions: 'instructions',
  model: 'model',
  effort: 'effort',
  stepLimit: 'step_limit',
  contextWindowTokens: 'context_window_tokens',
} as const satisfies Record<keyof BotUpdate, string>;

type Field = keyof typeof COLUMN_BY_FIELD;
const FIELDS = Object.keys(COLUMN_BY_FIELD) as Field[];

interface BotRow {
  id: string;
  name: string;
  color: string;
  instructions: string;
  model: string | null;
  effort: string | null;
  step_limit: number;
  context_window_tokens: Bot['contextWindowTokens'];
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Linha da lista de bots: o resumo mais os fatos de que `botRunStateOf` precisa (ver `BotService.list`). */
interface BotListRow extends Pick<BotRow, 'id' | 'name' | 'color' | 'archived_at'> {
  /** Status da execução ativa do bot (no máximo uma, índice único `runs_one_active_per_bot`), ou nulo. */
  active_status: BotRunFacts['activeStatus'];
  /** Status e término da execução terminal mais recente (a que terminou por último), ou nulos se o bot nunca terminou uma. */
  last_status: RunStatus | null;
  last_finished_at: Date | null;
  /** Rotinas do bot e quantas estão pausadas (a agregação sem linhas devolve 0 e 0, nunca nulo). */
  routines_total: number;
  routines_paused: number;
  /** Novidade não lida na conversa do bot (regra única `hasUnreadSql`). */
  unread: boolean;
  /** A última novidade visível da conversa (ver `list`): o texto da resposta concluída (já cortado no SQL) ou os dados do cartão; os dois nulos sem novidade. */
  last_text: string | null;
  last_card: SystemCard | null;
}

/** Quantos caracteres do texto da última resposta o SQL entrega: a prévia usa a primeira linha, então o resto da resposta nem sai do banco. */
const PREVIEW_TEXT_SCAN = 2000;

const BOT_COLUMNS = 'id, name, color, instructions, model, effort, step_limit, context_window_tokens, archived_at, created_at, updated_at';

/** Chave de comparação do nome: NFC e minúsculas (independente do locale do banco), sem distinguir maiúsculas. */
export function nameKeyOf(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

const toBot = (row: BotRow): Bot => ({
  id: row.id,
  name: row.name,
  color: row.color,
  instructions: row.instructions,
  model: row.model,
  effort: row.effort,
  stepLimit: row.step_limit,
  contextWindowTokens: row.context_window_tokens,
  archivedAt: row.archived_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** Converte a violação do índice único de nome ativo em BOT_NAME_TAKEN; qualquer outro erro segue como está. */
function translateNameConflict(error: unknown): unknown {
  if (error instanceof pg.DatabaseError && error.code === '23505' && error.constraint === ACTIVE_NAME_INDEX) {
    return new DomainError('BOT_NAME_TAKEN', { cause: error });
  }
  return error;
}

/** Conferência de modelo e effort de um bot. Implementada por `ModelService`; lança `MODEL_UNAVAILABLE` ou `VALIDATION_FAILED`. */
export interface ModelSelectionValidator {
  validateSelection(model: string | null, effort: EffortLevel | null): Promise<void>;
}

export interface BotServiceOptions {
  pool: Pool;
  models: ModelSelectionValidator;
  /** Relógio injetável: os testes fixam o tempo. */
  now?: () => Date;
  /** Exclusões definitivas aceitas por minuto; os testes sobem o teto quando não é o limite que provam. */
  deletesPerMinute?: number;
}

export class BotService {
  private readonly pool: Pool;
  private readonly models: ModelSelectionValidator;
  private readonly now: () => Date;
  private readonly deleteLimiter: SlidingWindowLimiter;

  constructor({ pool, models, now = () => new Date(), deletesPerMinute = BOT_DELETES_PER_MINUTE }: BotServiceOptions) {
    this.pool = pool;
    this.models = models;
    this.now = now;
    this.deleteLimiter = new SlidingWindowLimiter({ max: deletesPerMinute, windowMs: 60_000, now });
  }

  /**
   * Todos os bots (ativos e arquivados) em ordem alfabética sem distinguir maiúsculas; a web separa pelo
   * `archivedAt`. Nomes iguais (um arquivado e outro ativo) desempatam pela criação, para a ordem ser estável.
   * Cada item leva o estado ao vivo (`runState`), calculado no instante da leitura por `botRunStateOf` com os fatos que a MESMA consulta traz
   * (três junções laterais, uma por fato): a execução ativa, a última execução terminal (a que terminou por último; a fila e as ativas não entram,
   * então "fila conta como livre" e "o erro dura até a próxima execução começar" saem da própria forma da consulta) e a contagem de rotinas
   * com as pausadas. O relógio é o do serviço (`now`), para a janela de 60 s do "concluído" ser provada com tempo simulado.
   * As duas primeiras junções ignoram as execuções de manutenção de contexto (`context_operation_id IS NOT NULL`: "Compactar agora" e a compactação fria do worker, phase 11):
   * elas não são trabalho do bot, então não o põem em "Trabalhando" nem em "Concluiu agora" e não escondem o último desfecho verdadeiro (um erro some se uma manutenção
   * concluir depois dele). É a mesma regra de `conversation/views.ts`, `activities/service.ts` e `general-chat/service.ts`.
   * `unread` (T5, F4) vem da conversa única do bot pela regra única `hasUnreadSql`; o bot arquivado também a traz (a web decide que ele não acende Bots).
   * `preview` (phase 5 T5) vem da última novidade visível da conversa (`VISIBLE_NEWS_SQL`), uma quarta junção lateral da MESMA consulta (sem uma chamada por bot):
   * só o texto (cortado em `PREVIEW_TEXT_SCAN`) ou o `data` do cartão saem do banco, e `previewOf` o reduz à linha da tela.
   * ponytail: a lateral da prévia anda do fim da conversa para trás (índice `messages_timeline`) até achar a última novidade visível, pulando atividades de ferramenta;
   * com milhares de atividades seguidas sem resposta nem cartão, criar um índice parcial por `kind` e `status` em `messages`.
   * ponytail: lista inteira sem paginação, paginar se o dono passar de algumas centenas de bots.
   * ponytail: a lateral da última execução terminal varre as execuções do bot (índice `runs_by_bot`) e a lista roda a cada 5 s por aba aberta; com um
   * dono e dezenas de bots basta, criar o índice parcial `runs (bot_id, finished_at DESC)` das execuções terminais e trocar a releitura por um canal
   * de eventos se o histórico ou o número de abas pesar.
   */
  async list(): Promise<BotSummary[]> {
    const now = this.now();
    const rows = await this.pool.query<BotListRow>(
      `SELECT b.id, b.name, b.color, b.archived_at,
              act.status AS active_status,
              latest.status AS last_status, latest.finished_at AS last_finished_at,
              rt.total AS routines_total, rt.paused AS routines_paused,
              ${hasUnreadSql('c')} AS unread,
              news.text AS last_text, news.card AS last_card
         FROM bots b
         LEFT JOIN conversations c ON c.bot_id = b.id
         LEFT JOIN LATERAL (
           SELECT CASE WHEN m.kind = 'text' THEN left(m.content, $3::int) END AS text, CASE WHEN m.kind = 'card' THEN m.data END AS card
             FROM messages m WHERE m.conversation_id = c.id AND ${VISIBLE_NEWS_SQL} ORDER BY m.id DESC LIMIT 1
         ) news ON true
         LEFT JOIN LATERAL (
           SELECT r.status FROM runs r WHERE r.bot_id = b.id AND r.context_operation_id IS NULL AND r.status = ANY($1::text[]) LIMIT 1
         ) act ON true
         LEFT JOIN LATERAL (
           SELECT r.status, r.finished_at FROM runs r WHERE r.bot_id = b.id AND r.context_operation_id IS NULL AND r.status <> ALL($2::text[])
            ORDER BY r.finished_at DESC NULLS LAST, r.id DESC LIMIT 1
         ) latest ON true
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS total, (count(*) FILTER (WHERE r.status = 'paused'))::int AS paused FROM routines r WHERE r.bot_id = b.id
         ) rt
        ORDER BY b.name_key, b.created_at, b.id`,
      [ACTIVE_RUN_STATUSES, OPEN_RUN_STATUSES, PREVIEW_TEXT_SCAN],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      archivedAt: row.archived_at?.toISOString() ?? null,
      unread: row.unread,
      preview: previewOf({ text: row.last_text, card: row.last_card }),
      runState: botRunStateOf(
        {
          archived: row.archived_at !== null,
          activeStatus: row.active_status,
          lastTerminal: row.last_status === null ? null : { status: row.last_status, finishedAt: row.last_finished_at },
          routines: { total: row.routines_total, paused: row.routines_paused },
        },
        now,
      ),
    }));
  }

  /** Um bot completo. Lança BOT_NOT_FOUND se o id não existe. */
  async get(id: string): Promise<Bot> {
    const found = await this.pool.query<BotRow>(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = $1`, [id]);
    const row = found.rows[0];
    if (!row) throw new DomainError('BOT_NOT_FOUND');
    const choice = await resolveBotModelChoice(this.pool, id);
    const preference = await this.pool.query<{ preferred_model: string | null }>('SELECT preferred_model FROM conversations WHERE bot_id = $1', [id]);
    return { ...toBot(row), objective: await readBotObjective(this.pool, id), contextModel: { model: choice.model, fromConversation: preference.rows[0]?.preferred_model != null, capacity: readModelContextCapacity(choice.model) } };
  }

  /** Cria o bot com a conversa única e a memória vazia, tudo ou nada. Lança BOT_NAME_TAKEN. */
  async create(input: BotCreate, origin: RequestOrigin): Promise<Bot> {
    if (input.model !== null || input.effort !== null) await this.models.validateSelection(input.model, input.effort);
    const now = this.now();
    try {
      return await withTransaction(this.pool, async (tx) => {
        const inserted = await tx.query<BotRow>(
          `INSERT INTO bots (name, name_key, color, instructions, model, effort, step_limit, context_window_tokens, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           RETURNING ${BOT_COLUMNS}`,
          [input.name, nameKeyOf(input.name), input.color, input.instructions, input.model, input.effort, input.stepLimit, input.contextWindowTokens ?? null, now],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('bot não foi criado');
        await tx.query('INSERT INTO conversations (bot_id, created_at) VALUES ($1, $2)', [row.id, now]);
        await tx.query('INSERT INTO bot_memories (bot_id, created_at) VALUES ($1, $2)', [row.id, now]);
        await tx.query('INSERT INTO bot_objectives(bot_id) VALUES($1)', [row.id]);
        await recordAudit(tx, this.auditOf('bot.create', origin, row.id, { name: row.name }), now);
        return toBot(row);
      });
    } catch (error) {
      throw translateNameConflict(error);
    }
  }

  /**
   * Edição parcial: só os campos enviados e diferentes do que está salvo mudam. Sem mudança real, devolve o bot
   * como está (sem mexer em `updated_at` nem auditar). Lança BOT_NOT_FOUND ou BOT_NAME_TAKEN.
   */
  async update(id: string, input: BotUpdate, origin: RequestOrigin): Promise<Bot> {
    await this.checkModelChoice(id, input);
    const now = this.now();
    try {
      return await withTransaction(this.pool, async (tx) => {
        const current = await this.lock(tx, id);
        const before = toBot(current);
        const changed = FIELDS.filter((field) => input[field] !== undefined && input[field] !== before[field]);
        if (changed.length === 0) return before;

        // Valores já passaram pelo schema do Zod na borda; aqui vão sempre como parâmetros ($n).
        const assignments: string[] = [];
        const values: unknown[] = [id, now];
        for (const field of changed) {
          values.push(input[field]);
          assignments.push(`${COLUMN_BY_FIELD[field]} = $${values.length}`);
        }
        if (changed.includes('name') && input.name !== undefined) {
          values.push(nameKeyOf(input.name));
          assignments.push(`name_key = $${values.length}`);
        }
        const updated = await tx.query<BotRow>(
          `UPDATE bots SET ${assignments.join(', ')}, updated_at = $2 WHERE id = $1 RETURNING ${BOT_COLUMNS}`,
          values,
        );
        const row = updated.rows[0];
        if (!row) throw new DomainError('BOT_NOT_FOUND');
        await recordAudit(tx, this.auditOf('bot.update', origin, id, { fields: changed.join(',') }), now);
        return toBot(row);
      });
    } catch (error) {
      throw translateNameConflict(error);
    }
  }

  /**
   * Arquiva: o bot sai da lista principal e libera o nome. Conversa e memória permanecem. As rotinas do bot são pausadas na mesma
   * transação, com as execuções delas que ainda esperavam na fila (spec decisão 16); desarquivar não as retoma.
   */
  async archive(id: string, origin: RequestOrigin): Promise<Bot> {
    return this.setArchived(id, true, origin);
  }

  /** Desarquiva o bot. Lança BOT_NAME_TAKEN se outro bot ativo já usa o nome. As rotinas seguem pausadas. */
  async unarchive(id: string, origin: RequestOrigin): Promise<Bot> {
    try {
      return await this.setArchived(id, false, origin);
    } catch (error) {
      throw translateNameConflict(error);
    }
  }

  /**
   * Exclui o bot DEFINITIVAMENTE e tudo o que é dele (F6, DATA-01; irreversível). `confirmName` já chega na forma canônica do nome
   * (trim e NFC, aplicada pelo schema na borda) e precisa ser IGUAL ao nome gravado. Lança, nesta ordem de precedência,
   * RATE_LIMITED, BOT_NOT_FOUND (inexistente ou já excluído), BOT_NOT_ARCHIVED, BOT_HAS_OPEN_RUN e VALIDATION_FAILED (campo `confirmName`).
   *
   * Tudo roda numa transação: qualquer falha desfaz tudo e o bot continua inteiro. A ORDEM DE TRAVAS é a do arquivamento (`setArchived`):
   * as rotinas do bot antes do bot, a mesma do agendador e de `queueRun` (rotina e depois bot), para não haver impasse com um disparo em
   * andamento. A conferência de execuções vem DEPOIS da trava do bot: quem cria uma execução (mensagem, repetição, "Executar agora",
   * agenda) trava essa mesma linha em `queueRun`, então nenhuma execução nasce entre a checagem e a exclusão, e uma que acabou de nascer
   * é vista pela consulta (READ COMMITTED enxerga o que foi confirmado antes de a trava ser concedida).
   *
   * A trilha de auditoria é a única coisa que sobra: `bot.delete` leva o id e só contagens (nunca nome nem texto), e o registro antigo
   * `bot.create` perde o campo `name`, na mesma transação, para a trilha não guardar o nome de um bot que deixou de existir.
   *
   * ponytail: a exclusão herda o `statement_timeout` de 15 s do pool e o `DELETE` de mensagens é um comando só, então um histórico enorme pode
   * estourar e a transação desfaz tudo (nada fica pela metade); ampliar com `SET LOCAL statement_timeout` se isso acontecer.
   * ponytail: gravar a memória do bot no mesmo instante da exclusão pode dar impasse (40P01: a gravação segura a linha da memória e espera a
   * trava do bot; a exclusão segura o bot e espera a linha da memória); o PostgreSQL derruba uma das duas, nada fica pela metade e o dono
   * repete. Travar a linha da memória antes do bot se isso acontecer na prática.
   */
  async deleteArchived(id: string, confirmName: string, origin: RequestOrigin): Promise<void> {
    this.deleteLimiter.consume(); // cada tentativa conta, como em "Executar agora" e no envio de mensagem
    const now = this.now();
    await withTransaction(this.pool, async (tx) => {
      // A associação some, nunca a tabela. Mesma trava das mutações para invalidar revisões sem corrida com compartilhamento.
      await tx.query('SELECT pg_advisory_xact_lock($1)', [TABLE_MUTATION_LOCK]);
      // As liberações de conta do conector (phase 13) saem com o bot: a mesma trava das alterações de conta, antes das linhas, para a exclusão não esperar uma liberação em curso
      // que segura a conta e consulta o bot (a ordem entre travas está em `CONNECTOR_ACCOUNTS_LOCK`).
      await tx.query('SELECT pg_advisory_xact_lock($1)', [CONNECTOR_ACCOUNTS_LOCK]);
      // A associação doc-bot (phase 14) sai com o bot sob a trava de escrita dos docs, para a exclusão não correr com um compartilhamento nem com a escrita de um bot que ainda tem acesso.
      // Ordem fixa entre travas, a declarada em `DOC_MUTATION_LOCK`: tabelas, contas do conector, docs, e só então as linhas (rotinas e bot).
      await tx.query('SELECT pg_advisory_xact_lock($1)', [DOC_MUTATION_LOCK]);
      await lockRoutinesOfBot(tx, id);
      const bot = await this.lock(tx, id);
      if (bot.archived_at === null) throw new DomainError('BOT_NOT_ARCHIVED');
      const open = await tx.query('SELECT 1 FROM runs WHERE bot_id = $1 AND status = ANY($2::text[]) LIMIT 1', [id, OPEN_RUN_STATUSES]);
      if (open.rowCount) throw new DomainError('BOT_HAS_OPEN_RUN');
      if (confirmName !== bot.name) {
        throw new DomainError('VALIDATION_FAILED', { fields: [{ field: 'confirmName', reason: 'O nome digitado não confere.' }] });
      }
      const erased = await this.eraseBotData(tx, id);
      // ponytail: `audit_log` não tem índice em `target`, então isto lê a trilha inteira; criar o índice se ela passar de centenas de milhares de linhas.
      await tx.query("UPDATE audit_log SET details = details - 'name' WHERE action = 'bot.create' AND target = $1", [id]);
      await recordAudit(tx, this.auditOf('bot.delete', origin, id, erased), now);
    });
  }

  /**
   * Apaga, dentro da transação do chamador, TODAS as linhas que apontam para o bot, e por último o bot. Cada tabela sai explicitamente, em
   * vez de depender das poucas chaves com `ON DELETE CASCADE` ou `SET NULL` (`push_mutes`, `push_events.run_id`, `routine_occurrences`): a
   * ordem fica visível, as contagens da auditoria saem certas e uma chave `SET NULL` nunca deixa linha do bot órfã. O `bots.test.ts`
   * consulta o catálogo do banco e reprova se uma tabela nova que dependa do bot ficar de fora daqui. Devolve quantas linhas saíram de
   * cada tabela (vão para a auditoria).
   *
   * Ordem (as chaves entre as tabelas ditam, igual a `GeneralChatService.purgeOne`):
   *  1. aprovações e avisos de push: apontam para execuções e mensagens;
   *  2. ocorrências das rotinas: apontam para rotinas, execuções e mensagens;
   *  3. a referência `runs.trigger_message_id` é zerada (a execução aponta para a mensagem que a abriu e a mensagem para a execução);
   *  4. anexos, complementos (phase 4), mensagens e depois execuções (a mensagem aponta para a execução: apagar a execução antes violaria `messages.run_id`; a ordem do F6
   *     que lista execuções antes de mensagens não é executável por esse motivo);
   *  5. rotinas, eventos da conversa e a conversa;
   *  6. memória (versões e texto atual), regras de aprovação do bot, silenciados de push, liberações de conta do conector (a conta é do dono e fica; a versão dela sobe) e a associação aos
   *     docs (o doc é do dono e fica, com as versões; a revisão de acesso dele sobe);
   *  7. o bot.
   */
  private async eraseBotData(tx: PoolClient, id: string): Promise<Record<string, number>> {
    const ofConversation = '(SELECT id FROM conversations WHERE bot_id = $1)';
    const erase = async (sql: string): Promise<number> => (await tx.query(sql, [id])).rowCount ?? 0;

    const approvals = await erase('DELETE FROM approvals WHERE bot_id = $1');
    const pushEvents = await erase('DELETE FROM push_events WHERE bot_id = $1');
    const occurrences = await erase('DELETE FROM routine_occurrences WHERE routine_id IN (SELECT id FROM routines WHERE bot_id = $1)');
    await erase('UPDATE runs SET trigger_message_id = NULL WHERE bot_id = $1');
    const conversation = await tx.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [id]);
    const attachmentTotals = conversation.rows[0] ? await eraseConversationAttachments(tx, conversation.rows[0].id) : { count: 0, bytes: 0 };
    const attachments = attachmentTotals.count;
    // Complementos e rascunho devolvido (phase 4): apontam para execuções e são apontados pelos anexos, que já saíram.
    const complements = await erase(`DELETE FROM complements WHERE conversation_id IN ${ofConversation}`);
    const messages = await erase(`DELETE FROM messages WHERE conversation_id IN ${ofConversation}`);
    const runs = await erase('DELETE FROM runs WHERE bot_id = $1');
    const routines = await erase('DELETE FROM routines WHERE bot_id = $1');
    const events = await erase(`DELETE FROM conversation_events WHERE conversation_id IN ${ofConversation}`);
    await erase('DELETE FROM conversations WHERE bot_id = $1');
    const objectiveVersions = await erase('DELETE FROM objective_versions WHERE bot_id = $1');
    const objectives = await erase('DELETE FROM bot_objectives WHERE bot_id = $1');
    const memoryVersions = await erase('DELETE FROM memory_versions WHERE bot_id = $1');
    await erase('DELETE FROM bot_memories WHERE bot_id = $1');
    const rules = await erase('DELETE FROM bot_approval_rules WHERE bot_id = $1');
    const mutes = await erase('DELETE FROM push_mutes WHERE bot_id = $1');
    await tx.query('UPDATE data_tables SET version = version + 1 WHERE id IN (SELECT table_id FROM table_bot_access WHERE bot_id = $1)', [id]);
    const tableAccess = await erase('DELETE FROM table_bot_access WHERE bot_id = $1');
    // Liberações de conta do conector (phase 13, migration 0050): só a liberação depende do bot. A versão de cada conta liberada a ele sobe, como a da tabela compartilhada acima, para uma
    // tela de Conexões aberta antes da exclusão não gravar a lista de bots por cima de uma lista que mudou.
    await tx.query('UPDATE connector_accounts SET version = version + 1 WHERE id IN (SELECT account_id FROM connector_account_bots WHERE bot_id = $1)', [id]);
    const connectorAccess = await erase('DELETE FROM connector_account_bots WHERE bot_id = $1');
    // Docs (phase 14, migration 0051): o doc é do dono e fica, com as versões (o autor é só "dono" ou "bot", sem vínculo com o bot) e os recibos (sem chave para doc nem bot); só a associação sai.
    // A REVISÃO DE ACESSO do doc sobe, como a versão da tabela: uma tela de compartilhamento aberta antes da exclusão não grava a lista de bots por cima de uma lista que mudou, e a leitura que o
    // bot excluído fez deixa de valer. O texto e a versão do doc não mudam.
    await tx.query('UPDATE docs SET access_version = access_version + 1 WHERE id IN (SELECT doc_id FROM doc_bot_access WHERE bot_id = $1)', [id]);
    const docAccess = await erase('DELETE FROM doc_bot_access WHERE bot_id = $1');
    await erase('DELETE FROM bots WHERE id = $1');
    return { approvals, pushEvents, occurrences, attachments, attachmentBytes: attachmentTotals.bytes, complements, messages, runs, routines, events, objectiveVersions, objectives, memoryVersions, rules, mutes, tableAccess, connectorAccess, docAccess };
  }

  private async setArchived(id: string, archived: boolean, origin: RequestOrigin): Promise<Bot> {
    const now = this.now();
    return withTransaction(this.pool, async (tx) => {
      // Rotinas antes do bot (R14): a mesma ordem do agendador, para o arquivamento não entrar em deadlock com um disparo em andamento.
      if (archived) await lockRoutinesOfBot(tx, id);
      const current = await this.lock(tx, id);
      if ((current.archived_at !== null) === archived) return toBot(current); // já está no estado pedido
      const updated = await tx.query<BotRow>(
        `UPDATE bots SET archived_at = $2, updated_at = $3 WHERE id = $1 RETURNING ${BOT_COLUMNS}`,
        [id, archived ? now : null, now],
      );
      const row = updated.rows[0];
      if (!row) throw new DomainError('BOT_NOT_FOUND');
      if (archived) await pauseRoutinesOfBot(tx, id, now);
      await recordAudit(tx, this.auditOf(archived ? 'bot.archive' : 'bot.unarchive', origin, id), now);
      return toBot(row);
    });
  }

  /**
   * Confere modelo e effort só quando a edição os muda: troca de modelo, ou um effort novo. Um bot que só muda de nome
   * não consulta o provedor. A leitura aqui é sem trava: a conferência é de pré-condição, e a gravação segue travada.
   */
  private async checkModelChoice(id: string, input: BotUpdate): Promise<void> {
    if (input.model === undefined && input.effort === undefined) return;
    const current = await this.get(id);
    const model = input.model === undefined ? current.model : input.model;
    const effort = (input.effort === undefined ? current.effort : input.effort) as EffortLevel | null;
    const modelChanged = model !== current.model;
    const effortChosen = effort !== null && effort !== current.effort;
    if (modelChanged || effortChosen) await this.models.validateSelection(model, effort);
  }

  /** Lê o bot travando a linha até o fim da transação (edições e arquivamentos concorrentes do mesmo bot esperam). */
  private async lock(tx: PoolClient, id: string): Promise<BotRow> {
    const found = await tx.query<BotRow>(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = $1 FOR UPDATE`, [id]);
    const row = found.rows[0];
    if (!row) throw new DomainError('BOT_NOT_FOUND');
    return row;
  }

  private auditOf(action: string, origin: RequestOrigin, target: string, details?: AuditEvent['details']): AuditEvent {
    return { action, outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target, details };
  }
}
