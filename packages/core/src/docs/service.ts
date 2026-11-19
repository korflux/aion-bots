// Serviço dos docs (phase 14, passo 2; DOC-01 a DOC-03, SEC-03): FONTE ÚNICA das regras de criação, leitura, edição, versões, restauração, compartilhamento, exclusão e
// retenção dos docs em Markdown. A API do dono (passo 3a) e as ferramentas `doc_*` do bot (passo 3b) só traduzem entrada e saída: nenhum outro código escreve em `docs`,
// `doc_versions`, `doc_bot_access` nem `doc_mutation_receipts`, com UMA exceção: `BotService.eraseBotData` (bots/service.ts), que na exclusão do bot sobe `docs.access_version` e apaga as
// linhas de `doc_bot_access` dele, sob a mesma trava (`DOC_MUTATION_LOCK`). Contratos (limites, schemas, formas de resposta) em `@aion/shared` (`docs.ts`); tabelas na migration 0051.
//
// Quem chama (o `DocActor` é contexto interno confiável, nunca vem de argumento do modelo nem do corpo HTTP):
// - `{ kind: 'owner' }`: a API do dono. Vê e altera todos os docs, compartilha e exclui sem aprovação (a tela confirma).
// - `{ kind: 'bot', botId }`: a ferramenta, com o bot da EXECUÇÃO. Só enxerga os docs compartilhados com ele; o resto (id inexistente ou sem acesso) responde igual, `DOC_NOT_FOUND`,
//   sem revelar se o doc existe (A13). Não compartilha, não renomeia e só exclui com a prova de aprovação (`DOC_ACTIONS.delete`). O Chat geral não tem ator: qualquer outro
//   `kind` é recusado (`DOC_ACCESS_DENIED`).
//
// Regras:
// - Toda alteração do TEXTO cria uma versão imutável (autor dono ou bot, número crescente por doc); a criação grava a versão 1; restaurar cria uma versão nova com o texto da escolhida
//   (o histórico nunca é reescrito). Escrita leva a VERSÃO ESPERADA: divergiu = `DOC_CONFLICT` e nada é gravado. Texto igual ao atual não cria versão (`changed: false`). O título não é
//   versionado: mudá-lo não cria versão nem entra na restauração (só o dono renomeia; a versão esperada também o confere, para a tela desatualizada ser avisada).
// - Limites (A8): título 1 a 120 e texto até 100.000 CARACTERES (pontos de código), no máximo 100 docs. Título fora da faixa é `VALIDATION_FAILED` (schema); texto maior é `DOC_TOO_LARGE`
//   (inclusive o acréscimo ou a troca que o deixaria acima do limite); o 101.º doc é `DOC_LIMIT_EXCEEDED`.
// - Toda escrita é IDEMPOTENTE por (ator, `operationId`) pelos recibos: a repetição (replay de uma execução abandonada, retry de rede) devolve o resultado gravado sem gravar de novo; a
//   mesma operação com outro conteúdo é `DOC_CONFLICT`. O recibo não aponta para o doc (sobrevive à exclusão): a repetição de uma exclusão já aprovada e aplicada devolve o resultado em vez
//   de "doc inexistente". O replay respeita o acesso DE AGORA (bot que perdeu o acesso recebe `DOC_NOT_FOUND`).
// - Acesso conferido NO SERVIDOR a cada chamada, dentro da transação (nunca por cache): o bot só chega ao doc por `doc_bot_access`. O compartilhamento (só o dono) sobe `access_version`;
//   é a revisão que a proveniência das leituras do bot confere (A33) e que o compartilhamento esperado confere.
// - Toda escrita de bot confere que a execução ainda é dona do trabalho (`execution`): cancelada, sem posse, com a posse vencida ou com o sinal abortado, nada é gravado. A conferência TRAVA a linha
//   da execução (`FOR SHARE`) até o commit: a troca de posse (`claimNext` do motor, `FOR UPDATE SKIP LOCKED`) PULA a linha travada, e o batimento e o pedido de parada ESPERAM a escrita em curso,
//   então a posse conferida vale até a gravação e uma execução reivindicada por outro worker não ultrapassa uma escrita do dono antigo.
// - Auditoria registra quem, o quê, quando e de onde (ator, versão e tamanho), NUNCA o título nem o texto.
//
// Concorrência (CLAUDE.md, item 24): toda escrita roda numa transação sob UMA trava de banco (`DOC_MUTATION_LOCK`), como `TABLE_MUTATION_LOCK`. Isso serializa a contagem dos 100 docs
// com a criação, a versão nova com a atual + 1, o compartilhamento com a escrita de um bot que perde o acesso e a exclusão de bot com tudo isso, sem depender de travas de linha. As leituras
// não travam: rodam num instantâneo único (REPEATABLE READ) para o doc, o acesso e as páginas serem do mesmo instante.
// ponytail: trava global adequada a dono único e a poucos bots; trocar por trava por doc (mantendo uma só para a contagem do limite) se a espera entre escritas aparecer.
// ponytail: cada versão guarda o texto inteiro (pior caso: 100 docs x 50 versões x 100.000 caracteres, comprimido pelo TOAST do PostgreSQL); guardar diffs se o disco pesar.
// ponytail: o recibo de escrita nunca expira (como o de tabelas); podar no job de retenção se a tabela crescer.
import { createHash, randomUUID } from 'node:crypto';
import {
  DOC_ACTIONS,
  DOC_HISTORY_LIMIT,
  DOC_LIMITS,
  DOC_MIN_VERSIONS,
  DOC_RETENTION_DAYS,
  countChars,
  docCreateRequestSchema,
  docDeleteSchema,
  docIdSchema,
  docListQuerySchema,
  docReadSchema,
  docRestoreSchema,
  docShareSchema,
  docUpdateSchema,
  docVersionSchema,
  type Doc,
  type DocAuthor,
  type DocCreateInput,
  type DocDeleteInput,
  type DocDeleteResult,
  type DocEdit,
  type DocList,
  type DocListInput,
  type DocPage,
  type DocReadInput,
  type DocRestoreInput,
  type DocShareInput,
  type DocSummary,
  type DocUpdateInput,
  type DocVersionDetail,
  type DocVersionList,
  type DocWriteResult,
  type FieldError,
} from '@aion/shared';
import type { QueryResultRow } from 'pg';
import type { z } from 'zod';
import { recordAudit } from '../audit';
import { requireApprovalProof, type ApprovalProof } from '../approvals/proof';
import { withTransaction, type Pool, type PoolClient, type Queryable } from '../db/pool';
import { DomainError } from '../errors';
import { canonicalJSON } from '../tables/queries';

/**
 * Trava de banco (advisory, de transação) de TODA escrita de docs: criação (conta os 100 docs), edição, restauração, compartilhamento, exclusão e a exclusão de bot que apaga as
 * associações. Chave própria, distinta do lock do migrator (7_265_341_001), de `TABLE_MUTATION_LOCK` (7_265_341_030) e de `CONNECTOR_ACCOUNTS_LOCK` (7_265_341_050).
 *
 * ORDEM ENTRE TRAVAS (para nunca haver impasse): `BotService.deleteArchived` é o único que toma mais de uma e as toma nesta ordem, `TABLE_MUTATION_LOCK`, depois `CONNECTOR_ACCOUNTS_LOCK`,
 * depois esta, e só então as linhas (rotinas, bot). Este serviço toma SÓ esta, e nenhum código que a segura espera as outras duas.
 */
export const DOC_MUTATION_LOCK = 7_265_341_060;

/** Quem age sobre o doc: o dono (API) ou o bot da execução (ferramenta). Qualquer outro `kind` (Chat geral) é recusado em toda operação. */
export type DocActor = { kind: 'owner' } | { kind: 'bot'; botId: string };
/** Origem da requisição, para a auditoria (só a API a conhece). */
export interface DocOrigin {
  ip?: string;
  userAgent?: string;
}
/**
 * Fonte lida por um bot, capturada no MESMO instante autorizado da leitura (a revisão de acesso lida e não uma consulta posterior sujeita a revogação): é o que a proveniência das
 * evidências (A33) guarda para o modelo deixar de ver a leitura quando o dono revoga. Entra em toda leitura ou escrita autorizada do bot, menos na exclusão e no `peek`.
 */
export interface DocEvidenceEntry {
  docId: string;
  botId: string;
  accessVersion: number;
}

export interface DocServiceOptions {
  pool: Pool;
  /** Relógio injetável: os testes fixam o tempo (datas das versões e retenção). */
  now?: () => Date;
  /** Posse da execução do bot: a escrita só vale enquanto ela está ativa, com a posse atual e sem cancelamento. Só as ferramentas passam. */
  execution?: { runId: string; signal: AbortSignal; leaseOwner?: string };
  /** Coletor síncrono da evidência de cada leitura autorizada do bot. Só as ferramentas passam. */
  onEvidence?: (entries: readonly DocEvidenceEntry[]) => void;
}

/** Linha do doc sem o texto (a que a lista e as escritas precisam). */
interface DocRow {
  id: string;
  title: string;
  version: number;
  access_version: number;
  size: number;
  updated_by: DocAuthor;
  created_at: Date;
  updated_at: Date;
}
interface DocTextRow extends DocRow {
  content: string;
}
/** Colunas de `DocRow`, com o alias `d` da tabela `docs`. Listadas à mão: a lista nunca lê o texto. */
const DOC_FIELDS = 'd.id, d.title, d.version, d.access_version, d.size, d.updated_by, d.created_at, d.updated_at';

/** O que `apply` devolve a `mutate`: o resultado (vai ao recibo e ao chamador), o doc afetado e os detalhes da auditoria (nulos = nada mudou, sem auditoria). */
interface Applied<R> {
  result: R;
  docId: string;
  audit: Record<string, string | number | boolean | null> | null;
}

/** Hash estável do que o recibo guarda: a ordem das propriedades não torna o replay incompatível. */
const hashOf = (value: unknown): string => createHash('sha256').update(canonicalJSON(value)).digest('hex');
/** Identidade do recibo: texto, sem chave para o bot, para sobreviver à exclusão dele. */
const actorKey = (actor: DocActor): string => (actor.kind === 'bot' ? `bot:${actor.botId.toLowerCase()}` : 'owner');

/** Valida a entrada pelo contrato compartilhado, também para o chamador interno. O motivo é genérico: nunca ecoa o que foi enviado. */
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const seen = new Set<string>();
  const fields: FieldError[] = [];
  for (const issue of parsed.error.issues) {
    const field = issue.path.join('.') || 'corpo';
    if (seen.has(field)) continue;
    seen.add(field);
    fields.push({ field, reason: 'Valor inválido.' });
  }
  throw new DomainError('VALIDATION_FAILED', { fields });
}

/** O limite de 100.000 caracteres. Mais de 200.000 unidades UTF-16 já passam do limite sem contar (um caractere ocupa no máximo duas), o que poupa a contagem de um texto absurdo. */
function assertFits(content: string): void {
  if (content.length > DOC_LIMITS.contentChars * 2 || countChars(content) > DOC_LIMITS.contentChars) throw new DomainError('DOC_TOO_LARGE');
}

/**
 * Aplica uma das três edições ao texto atual e devolve o texto novo (o limite e a igualdade ao atual são de quem chama). `replace` é literal, sem padrões (nem `$&` nem expressão regular), e
 * exige o trecho UMA vez só: ocorrências sobrepostas contam (`aa` em `aaa` é ambíguo), para o bot nunca trocar um lugar que não viu.
 */
function applyEdit(current: string, edit: DocEdit): string {
  switch (edit.operation) {
    case 'append':
      // Como a memória: junta em nova linha se o texto não está vazio nem termina em quebra de linha; o bot que quer um parágrafo separado envia a linha em branco.
      return `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${edit.text}`;
    case 'rewrite':
      return edit.content;
    case 'replace': {
      const first = current.indexOf(edit.find);
      if (first === -1) throw new DomainError('DOC_TEXT_NOT_FOUND');
      if (current.indexOf(edit.find, first + 1) !== -1) throw new DomainError('DOC_TEXT_AMBIGUOUS');
      return current.slice(0, first) + edit.replacement + current.slice(first + edit.find.length);
    }
  }
}

export class DocService {
  private readonly pool: Pool;
  private readonly now: () => Date;

  constructor(private readonly options: DocServiceOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------------------------
  // Leitura (instantâneo único, sem trava)
  // ---------------------------------------------------------------------------------------------

  /** O doc inteiro (texto incluído). A ferramenta do bot lê por `read` (paginada); esta é a leitura da tela do dono. */
  async get(docId: string, actor: DocActor): Promise<Doc> {
    this.assertActor(actor);
    return this.readOnly(async (tx) => {
      const row = await this.select<DocTextRow>(tx, docId, actor, `${DOC_FIELDS}, d.content`);
      this.captureEvidence([row], actor);
      const { content, ...summary } = row;
      return { ...(await this.summaryOf(tx, summary, actor)), content };
    });
  }

  /**
   * Uma página do texto por CARACTERE (`offset` e `limit` contam pontos de código; nunca parte um emoji). `nextOffset` nulo é o fim. Com `expectedVersion`, as páginas lidas em sequência
   * são garantidamente do mesmo texto (`DOC_CONFLICT` se o doc mudou no meio): sem isso, uma edição entre duas páginas deslocaria o texto sem ninguém ver.
   */
  async read(docId: string, actor: DocActor, raw: DocReadInput = {}): Promise<DocPage> {
    this.assertActor(actor);
    const input = parse(docReadSchema, raw);
    return this.readOnly(async (tx) => {
      const row = await this.select<DocRow>(tx, docId, actor, DOC_FIELDS);
      if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) throw new DomainError('DOC_CONFLICT');
      this.captureEvidence([row], actor);
      // `substr` do PostgreSQL conta caracteres (pontos de código num banco UTF8, a codificação que a subida exige) e começa em 1.
      const slice = await tx.query<{ content: string }>('SELECT substr(content, $2::int, $3::int) AS content FROM docs WHERE id = $1', [row.id, input.offset + 1, input.limit]);
      const content = slice.rows[0]?.content ?? '';
      const end = input.offset + countChars(content);
      return { id: row.id, title: row.title, version: row.version, size: row.size, offset: input.offset, content, nextOffset: end < row.size ? end : null };
    });
  }

  /** Os docs que o ator enxerga, do mais recente para o mais antigo (sem paginação: no máximo 100), sem o texto. O dono pode filtrar por bot; o bot vê só os compartilhados com ele. */
  async list(actor: DocActor, raw: DocListInput = {}): Promise<DocList> {
    this.assertActor(actor);
    const query = parse(docListQuerySchema, raw);
    return this.readOnly(async (tx) => {
      const botId = actor.kind === 'bot' ? actor.botId : (query.botId ?? null);
      if (botId !== null && !(await tx.query('SELECT 1 FROM bots WHERE id = $1', [botId])).rowCount) throw new DomainError('BOT_NOT_FOUND');
      const found = await tx.query<DocRow>(
        `SELECT ${DOC_FIELDS} FROM docs d
         WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM doc_bot_access a WHERE a.doc_id = d.id AND a.bot_id = $1))
         ORDER BY d.updated_at DESC, d.id`,
        [botId],
      );
      this.captureEvidence(found.rows, actor);
      const botIds = await this.botIdsOf(tx, found.rows, actor);
      return { docs: found.rows.map((row) => this.toSummary(row, botIds.get(row.id) ?? [])) };
    });
  }

  /** Histórico: as versões mais recentes primeiro, com autor, data e tamanho (sem o texto). */
  async listVersions(docId: string, actor: DocActor): Promise<DocVersionList> {
    this.assertActor(actor);
    return this.readOnly(async (tx) => {
      const row = await this.select<DocRow>(tx, docId, actor, DOC_FIELDS);
      this.captureEvidence([row], actor);
      const found = await tx.query<{ version: number; author: DocAuthor; created_at: Date; size: number; restored_from: number | null }>(
        `SELECT version, author, created_at, size, restored_from FROM doc_versions WHERE doc_id = $1 ORDER BY version DESC LIMIT ${DOC_HISTORY_LIMIT}`,
        [row.id],
      );
      return {
        versions: found.rows.map((item) => ({ version: item.version, author: item.author, createdAt: item.created_at.toISOString(), size: item.size, restoredFrom: item.restored_from })),
      };
    });
  }

  /** Uma versão com o texto dela. `DOC_VERSION_NOT_FOUND` se nunca existiu ou a retenção a apagou. */
  async getVersion(docId: string, version: number, actor: DocActor): Promise<DocVersionDetail> {
    this.assertActor(actor);
    const number = parse(docVersionSchema, version);
    return this.readOnly(async (tx) => {
      const row = await this.select<DocRow>(tx, docId, actor, DOC_FIELDS);
      this.captureEvidence([row], actor);
      const found = await tx.query<{ content: string; author: DocAuthor; created_at: Date; size: number; restored_from: number | null }>(
        'SELECT content, author, created_at, size, restored_from FROM doc_versions WHERE doc_id = $1 AND version = $2',
        [row.id, number],
      );
      const item = found.rows[0];
      if (!item) throw new DomainError('DOC_VERSION_NOT_FOUND');
      return { version: number, author: item.author, createdAt: item.created_at.toISOString(), size: item.size, restoredFrom: item.restored_from, content: item.content };
    });
  }

  /**
   * Id e título do doc, SÓ para quem tem acesso (`DOC_NOT_FOUND` igual à de um id inexistente). É o que a aprovação de exclusão mostra ao dono (decisão 23): o título vem do banco depois da
   * checagem de acesso, nunca do argumento do modelo. Não registra evidência (não é uma leitura do conteúdo que o modelo vai ver).
   */
  async peek(docId: string, actor: DocActor): Promise<{ id: string; title: string }> {
    this.assertActor(actor);
    const row = await this.select<Pick<DocRow, 'id' | 'title'>>(this.pool, docId, actor, 'd.id, d.title');
    return { id: row.id, title: row.title };
  }

  // ---------------------------------------------------------------------------------------------
  // Escrita (uma trava, recibo por operação)
  // ---------------------------------------------------------------------------------------------

  /**
   * Cria o doc e a versão 1. O dono escolhe os bots (`botIds`, nenhum é permitido); o bot cria o doc já associado a ELE MESMO e não escolhe bots (o servidor decide, `botIds` do bot é
   * recusado). Devolve o doc sem o texto. `DOC_LIMIT_EXCEEDED` no 101.º, `DOC_TOO_LARGE` se o texto passa de 100.000 caracteres, `BOT_NOT_FOUND` se algum bot não existe.
   */
  async create(raw: DocCreateInput, actor: DocActor, origin: DocOrigin = {}): Promise<DocSummary> {
    this.assertActor(actor);
    const input = parse(docCreateRequestSchema, raw);
    if (actor.kind === 'bot' && input.botIds.length > 0) throw new DomainError('VALIDATION_FAILED', { fields: [{ field: 'botIds', reason: 'Só o dono escolhe os bots.' }] });
    assertFits(input.content);
    const botIds = (actor.kind === 'bot' ? [actor.botId] : input.botIds).map((id) => id.toLowerCase());
    return this.mutate<DocSummary>(actor, input.operationId, 'doc.create', input, null, origin, async (tx, at) => {
      if ((await tx.query('SELECT id FROM bots WHERE id = ANY($1::uuid[])', [botIds])).rowCount !== botIds.length) throw new DomainError('BOT_NOT_FOUND');
      // A contagem e a criação acontecem sob a trava: duas criações simultâneas no 100.º lugar nunca passam as duas.
      const total = Number((await tx.query<{ count: string }>('SELECT count(*) FROM docs')).rows[0]!.count);
      if (total >= DOC_LIMITS.docs) throw new DomainError('DOC_LIMIT_EXCEEDED');
      const id = randomUUID();
      const author = this.authorOf(actor);
      await tx.query('INSERT INTO docs (id, title, content, updated_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)', [id, input.title, input.content, author, at]);
      await tx.query("INSERT INTO doc_versions (doc_id, version, content, author, created_at) VALUES ($1, 1, $2, $3, $4)", [id, input.content, author, at]);
      if (botIds.length > 0) await tx.query('INSERT INTO doc_bot_access (doc_id, bot_id) SELECT $1, unnest($2::uuid[])', [id, botIds]);
      const row = await this.select<DocRow>(tx, id, actor, DOC_FIELDS);
      this.captureEvidence([row], actor);
      return { result: await this.summaryOf(tx, row, actor), docId: id, audit: { version: 1, size: row.size } };
    });
  }

  /**
   * Altera o texto (por uma das três edições) e/ou o título. Exige a versão esperada do TEXTO atual (`DOC_CONFLICT` se divergiu, o título sozinho também). Texto e título iguais aos atuais
   * não criam versão nem auditoria (`changed: false`). Só o dono renomeia: o bot que envia `title` recebe `VALIDATION_FAILED`.
   */
  async update(docId: string, raw: DocUpdateInput, actor: DocActor, origin: DocOrigin = {}): Promise<DocWriteResult> {
    this.assertActor(actor);
    const input = parse(docUpdateSchema, raw);
    if (actor.kind === 'bot' && input.title !== undefined) throw new DomainError('VALIDATION_FAILED', { fields: [{ field: 'title', reason: 'Só o dono renomeia o doc.' }] });
    return this.mutate<DocWriteResult>(actor, input.operationId, 'doc.update', input, docId, origin, async (tx, at) => {
      const current = await this.select<DocTextRow>(tx, docId, actor, `${DOC_FIELDS}, d.content`);
      this.captureEvidence([current], actor);
      if (current.version !== input.expectedVersion) throw new DomainError('DOC_CONFLICT');
      const content = input.edit ? applyEdit(current.content, input.edit) : current.content;
      assertFits(content);
      const title = input.title ?? current.title;
      const textChanged = content !== current.content;
      const titleChanged = title !== current.title;
      if (!textChanged && !titleChanged) return { result: { doc: await this.summaryOf(tx, current, actor), changed: false }, docId: current.id, audit: null };
      const version = textChanged ? current.version + 1 : current.version;
      const author = this.authorOf(actor);
      if (textChanged) await tx.query('INSERT INTO doc_versions (doc_id, version, content, author, created_at) VALUES ($1, $2, $3, $4, $5)', [current.id, version, content, author, at]);
      await tx.query('UPDATE docs SET title = $2, content = $3, version = $4, updated_by = $5, updated_at = $6 WHERE id = $1', [current.id, title, content, version, author, at]);
      const row = await this.select<DocRow>(tx, current.id, actor, DOC_FIELDS);
      return { result: { doc: await this.summaryOf(tx, row, actor), changed: true }, docId: current.id, audit: { version, size: row.size, text: textChanged, title: titleChanged } };
    });
  }

  /**
   * Restaura uma versão antiga COMO VERSÃO NOVA (autor: quem restaurou), com a versão esperada atual como em toda escrita. Nada é apagado: as versões posteriores continuam no histórico.
   * Restaurar o texto que já é o atual não cria versão. `DOC_VERSION_NOT_FOUND` se a versão nunca existiu ou a retenção a apagou.
   */
  async restore(docId: string, raw: DocRestoreInput, actor: DocActor, origin: DocOrigin = {}): Promise<DocWriteResult> {
    this.assertActor(actor);
    const input = parse(docRestoreSchema, raw);
    return this.mutate<DocWriteResult>(actor, input.operationId, 'doc.restore', input, docId, origin, async (tx, at) => {
      const current = await this.select<DocTextRow>(tx, docId, actor, `${DOC_FIELDS}, d.content`);
      this.captureEvidence([current], actor);
      if (current.version !== input.expectedVersion) throw new DomainError('DOC_CONFLICT');
      const found = await tx.query<{ content: string }>('SELECT content FROM doc_versions WHERE doc_id = $1 AND version = $2', [current.id, input.version]);
      const old = found.rows[0];
      if (!old) throw new DomainError('DOC_VERSION_NOT_FOUND');
      if (old.content === current.content) return { result: { doc: await this.summaryOf(tx, current, actor), changed: false }, docId: current.id, audit: null };
      const version = current.version + 1;
      const author = this.authorOf(actor);
      await tx.query('INSERT INTO doc_versions (doc_id, version, content, author, restored_from, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [current.id, version, old.content, author, input.version, at]);
      await tx.query('UPDATE docs SET content = $2, version = $3, updated_by = $4, updated_at = $5 WHERE id = $1', [current.id, old.content, version, author, at]);
      const row = await this.select<DocRow>(tx, current.id, actor, DOC_FIELDS);
      return { result: { doc: await this.summaryOf(tx, row, actor), changed: true }, docId: current.id, audit: { version, size: row.size, restoredFrom: input.version } };
    });
  }

  /**
   * Compartilhamento (SÓ o dono; o bot recebe `DOC_ACCESS_DENIED`): troca a lista de bots com acesso pela lista completa enviada, conferida pela revisão de acesso esperada
   * (`DOC_CONFLICT` se a lista mudou, inclusive por exclusão de bot). Lista igual à atual não muda nada. Subir a revisão invalida, para o modelo, o que um bot leu antes (A33). O texto e a
   * versão do doc não mudam; uma lista vazia é permitida.
   */
  async share(docId: string, raw: DocShareInput, actor: DocActor, origin: DocOrigin = {}): Promise<DocSummary> {
    this.assertActor(actor);
    const input = parse(docShareSchema, raw);
    if (actor.kind !== 'owner') throw new DomainError('DOC_ACCESS_DENIED');
    const botIds = [...new Set(input.botIds.map((id) => id.toLowerCase()))].sort();
    return this.mutate<DocSummary>(actor, input.operationId, 'doc.share', input, docId, origin, async (tx) => {
      const current = await this.select<DocRow>(tx, docId, actor, DOC_FIELDS);
      if (current.access_version !== input.expectedAccessVersion) throw new DomainError('DOC_CONFLICT');
      if ((await tx.query('SELECT id FROM bots WHERE id = ANY($1::uuid[])', [botIds])).rowCount !== botIds.length) throw new DomainError('BOT_NOT_FOUND');
      const previous = (await tx.query<{ bot_id: string }>('SELECT bot_id FROM doc_bot_access WHERE doc_id = $1 ORDER BY bot_id', [current.id])).rows.map((row) => row.bot_id);
      if (previous.length === botIds.length && previous.every((id, index) => id === botIds[index])) {
        return { result: this.toSummary(current, previous), docId: current.id, audit: null };
      }
      await tx.query('DELETE FROM doc_bot_access WHERE doc_id = $1', [current.id]);
      if (botIds.length > 0) await tx.query('INSERT INTO doc_bot_access (doc_id, bot_id) SELECT $1, unnest($2::uuid[])', [current.id, botIds]);
      await tx.query('UPDATE docs SET access_version = access_version + 1 WHERE id = $1', [current.id]);
      const row = await this.select<DocRow>(tx, current.id, actor, DOC_FIELDS);
      return { result: this.toSummary(row, botIds), docId: current.id, audit: { accessVersion: row.access_version, bots: botIds.length } };
    });
  }

  /**
   * Exclui o doc, com as versões e as associações (cascata); os recibos ficam. O dono exclui sem prova (a tela confirma); o bot SÓ com a prova de aprovação de `DOC_ACTIONS.delete`
   * (o portão do executor a emite depois da regra de aprovação), e sem ela é `APPROVAL_REQUIRED` sem apagar nada. A prova é conferida DEPOIS do replay: repetir uma exclusão já aprovada e
   * aplicada devolve o resultado gravado (`{ id, deleted }`, sem título) sem pedir a prova de novo. O acesso é conferido de novo aqui, dentro da trava, mesmo que o chamador já tenha olhado.
   * O TÍTULO SAI dos recibos: os de TODAS as escritas anteriores sobre o doc (create, update, restore, share) trocam o resultado por `{"resourceRemoved":true}`, como as tabelas fazem na exclusão, e o
   * da própria exclusão nasce sem título. A repetição de uma escrita sobre o doc excluído já é `DOC_NOT_FOUND` (o doc não existe), então o resultado trocado nunca é devolvido.
   */
  async delete(docId: string, raw: DocDeleteInput, actor: DocActor, proof?: ApprovalProof, origin: DocOrigin = {}): Promise<DocDeleteResult> {
    this.assertActor(actor);
    const input = parse(docDeleteSchema, raw);
    return this.mutate<DocDeleteResult>(actor, input.operationId, 'doc.delete', input, docId, origin, async (tx) => {
      const current = await this.select<DocRow>(tx, docId, actor, DOC_FIELDS);
      if (actor.kind === 'bot') {
        try {
          requireApprovalProof(proof, DOC_ACTIONS.delete.slug);
        } catch {
          throw new DomainError('APPROVAL_REQUIRED');
        }
      }
      await tx.query("UPDATE doc_mutation_receipts SET result = '{\"resourceRemoved\":true}'::jsonb WHERE doc_id = $1", [current.id]);
      await tx.query('DELETE FROM docs WHERE id = $1', [current.id]);
      return { result: { id: current.id, deleted: true }, docId: current.id, audit: { version: current.version, size: current.size } };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Retenção
  // ---------------------------------------------------------------------------------------------

  /**
   * Job diário (MEM-01 aplicada aos docs): apaga as versões com mais de 90 dias, MANTENDO as 50 mais recentes de cada doc (a atual é sempre a mais recente, então nunca sai). Devolve quantas
   * apagou. Idempotente e sem a trava de escrita: só remove versões fora das 50 mais recentes, que nenhuma escrita em curso precisa (a nova entra como a mais recente).
   */
  async purgeExpiredVersions(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - DOC_RETENTION_DAYS * 86_400_000);
    const removed = await this.pool.query(
      `DELETE FROM doc_versions WHERE (doc_id, version) IN (
         SELECT doc_id, version FROM (
           SELECT doc_id, version, created_at, row_number() OVER (PARTITION BY doc_id ORDER BY version DESC) AS recency FROM doc_versions
         ) ranked
         WHERE recency > $1 AND created_at < $2)`,
      [DOC_MIN_VERSIONS, cutoff],
    );
    return removed.rowCount ?? 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------------------------

  /** O ator tem de ser o dono ou um bot com id válido; o Chat geral (ou qualquer outra coisa) nunca ganha acesso por assinatura. */
  private assertActor(actor: DocActor): void {
    if (actor.kind !== 'owner' && actor.kind !== 'bot') throw new DomainError('DOC_ACCESS_DENIED');
    if (actor.kind === 'bot' && !docIdSchema.safeParse(actor.botId).success) throw new DomainError('DOC_ACCESS_DENIED');
  }

  private authorOf(actor: DocActor): DocAuthor {
    return actor.kind === 'bot' ? 'bot' : 'owner';
  }

  /**
   * Lê o doc COM a checagem de acesso na mesma consulta: o dono vê qualquer um; o bot só o que está em `doc_bot_access`. Sem linha, a resposta é `DOC_NOT_FOUND`, a MESMA de um id que
   * não existe (A13): quem não tem acesso não descobre que o doc existe. Id malformado é `VALIDATION_FAILED` (não é um id). `columns` usa o alias `d`.
   */
  private async select<R extends QueryResultRow>(db: Queryable, docId: string, actor: DocActor, columns: string): Promise<R> {
    if (!docIdSchema.safeParse(docId).success) throw new DomainError('VALIDATION_FAILED');
    const found = await db.query<R>(
      `SELECT ${columns} FROM docs d WHERE d.id = $1 AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM doc_bot_access a WHERE a.doc_id = d.id AND a.bot_id = $2))`,
      [docId, actor.kind === 'bot' ? actor.botId : null],
    );
    const row = found.rows[0];
    if (!row) throw new DomainError('DOC_NOT_FOUND');
    return row;
  }

  /** Entrega a revisão de acesso lida ao coletor de evidência (só leitura de bot): vem da mesma consulta autorizada, sem consulta posterior sujeita a revogação. */
  private captureEvidence(rows: readonly Pick<DocRow, 'id' | 'access_version'>[], actor: DocActor): void {
    if (actor.kind === 'bot' && rows.length > 0) this.options.onEvidence?.(rows.map((row) => ({ docId: row.id, botId: actor.botId, accessVersion: row.access_version })));
  }

  /** Os bots de cada doc, só para o dono. O bot não descobre quem mais acessa o doc (lista vazia), como nas tabelas. */
  private async botIdsOf(db: Queryable, rows: readonly Pick<DocRow, 'id'>[], actor: DocActor): Promise<Map<string, string[]>> {
    const byDoc = new Map<string, string[]>();
    if (actor.kind !== 'owner' || rows.length === 0) return byDoc;
    const found = await db.query<{ doc_id: string; bot_id: string }>('SELECT doc_id, bot_id FROM doc_bot_access WHERE doc_id = ANY($1::uuid[]) ORDER BY bot_id', [rows.map((row) => row.id)]);
    for (const { doc_id, bot_id } of found.rows) byDoc.set(doc_id, [...(byDoc.get(doc_id) ?? []), bot_id]);
    return byDoc;
  }

  private toSummary(row: DocRow, botIds: string[]): DocSummary {
    return {
      id: row.id,
      title: row.title,
      version: row.version,
      accessVersion: row.access_version,
      size: row.size,
      botIds,
      updatedBy: row.updated_by,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async summaryOf(db: Queryable, row: DocRow, actor: DocActor): Promise<DocSummary> {
    return this.toSummary(row, (await this.botIdsOf(db, [row], actor)).get(row.id) ?? []);
  }

  /** Transação de leitura num instantâneo único: o doc, o acesso e as páginas são do mesmo instante, sem trava. */
  private async readOnly<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await withTransaction(this.pool, async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        return work(tx);
      });
    } catch (error) {
      throw this.translateTimeout(error);
    }
  }

  /**
   * Núcleo de toda escrita: uma transação sob a trava de docs que (1) devolve o resultado gravado se a operação já foi feita (recibo por ator e operação; outra ação ou outro conteúdo com a
   * mesma identidade é `DOC_CONFLICT`; o replay respeita o acesso de agora, exceto o da exclusão, cujo doc já não existe), (2) confere (e trava) a posse da execução do bot, (3) aplica, (4) confere a
   * posse de novo antes de gravar o recibo e a auditoria no MESMO commit, ainda sob a mesma trava. Falha em qualquer ponto desfaz tudo, inclusive a versão nova.
   */
  private async mutate<R>(
    actor: DocActor,
    operationId: string,
    action: string,
    input: unknown,
    docId: string | null,
    origin: DocOrigin,
    apply: (tx: PoolClient, at: Date) => Promise<Applied<R>>,
  ): Promise<R> {
    const at = this.now();
    try {
      return await withTransaction(this.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [DOC_MUTATION_LOCK]);
        const payloadHash = hashOf({ docId, input });
        const found = await tx.query<{ doc_id: string; action: string; payload_hash: string; result: R }>(
          'SELECT doc_id, action, payload_hash, result FROM doc_mutation_receipts WHERE actor = $1 AND operation_id = $2',
          [actorKey(actor), operationId],
        );
        const receipt = found.rows[0];
        if (receipt) {
          if (receipt.action !== action || receipt.payload_hash !== payloadHash) throw new DomainError('DOC_CONFLICT');
          if (action !== 'doc.delete') {
            // O que o resultado gravado mostra ao ator só vale enquanto ele ainda enxerga o doc.
            const row = await this.select<DocRow>(tx, receipt.doc_id, actor, DOC_FIELDS);
            this.captureEvidence([row], actor);
          }
          return receipt.result;
        }
        await this.assertExecution(tx, actor);
        const applied = await apply(tx, at);
        await this.assertExecution(tx, actor);
        await tx.query('INSERT INTO doc_mutation_receipts (actor, operation_id, doc_id, action, payload_hash, result) VALUES ($1, $2, $3, $4, $5, $6)', [
          actorKey(actor),
          operationId,
          applied.docId,
          action,
          payloadHash,
          JSON.stringify(applied.result),
        ]);
        if (applied.audit) {
          await recordAudit(
            tx,
            { action, outcome: 'success', actor: actor.kind === 'owner' ? 'owner' : 'system', ip: origin.ip, userAgent: origin.userAgent, target: applied.docId, details: { actor: actorKey(actor), ...applied.audit } },
            at,
          );
        }
        return applied.result;
      });
    } catch (error) {
      throw this.translateTimeout(error);
    }
  }

  /**
   * A escrita do bot só vale com a execução ainda ativa, com a posse atual e vigente (`lease_until` no futuro) e sem cancelamento; o cancelamento ou a perda da posse, inclusive durante a espera pela trava de
   * docs, impede o commit. A leitura da linha de `runs` é `FOR SHARE` e segura a linha até o fim da transação: sem ela a conferência era um SELECT solto, e a troca de posse (`claimNext`, que reivindica a
   * execução abandonada com `FOR UPDATE SKIP LOCKED`, e por isso só a reivindica se ninguém a trava) podia acontecer entre a conferência e o commit. Com ela, `claimNext` PULA a linha enquanto esta escrita está
   * aberta, e o batimento e o pedido de parada (UPDATE da linha) ESPERAM esta escrita terminar (curta: já tem a trava de docs). Se a espera é por uma troca de posse que já tomou a linha antes, a conferência, depois
   * de esperar, relê a linha mais nova (READ COMMITTED), então uma troca de posse que terminou antes recusa a escrita.
   */
  private async assertExecution(tx: Queryable, actor: DocActor): Promise<void> {
    const execution = this.options.execution;
    if (!execution || actor.kind !== 'bot') return;
    const live =
      !execution.signal.aborted &&
      (await tx.query("SELECT 1 FROM runs WHERE id = $1 AND status = 'running' AND stop_requested_at IS NULL AND lease_until > now() AND ($2::uuid IS NULL OR lease_owner = $2) FOR SHARE", [execution.runId, execution.leaseOwner ?? null])).rowCount;
    if (!live) throw new DomainError('DOC_CONFLICT');
  }

  /** Estouro do tempo de uma consulta (inclusive a espera pela trava) é indisponibilidade, nunca um erro interno com detalhe. */
  private translateTimeout(error: unknown): unknown {
    return (error as { code?: string } | null)?.code === '57014' ? new DomainError('SERVICE_UNAVAILABLE') : error;
  }
}
