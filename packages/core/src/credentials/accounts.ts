// Serviço das contas do conector (Composio) liberadas por bot (phase 13, CONN-02; spec decisões 5 a 8): é a FONTE ÚNICA das regras de nome da conta, liberação por bot, semeadura
// inicial e leitura das contas que cada bot pode usar. A API só traduz HTTP <-> chamadas deste serviço, e a execução do conector consulta `releasedTo` a cada chamada.
//
// O que existe e onde mora (tabelas da migration 0050):
// - A CONTA é conectada no painel do Composio (o Aion não faz OAuth) e entra em `connector_accounts` na primeira leitura do estado dela (`sync`). O banco guarda só o que a leitura ao
//   vivo não dá quando a conta some (app e nome legível), o NOME do dono e a VERSÃO. O estado (ativa, pendente, desconectada) vem sempre da leitura ao vivo, e a conta que o Composio
//   deixa de listar fica DESCONECTADA mantendo nome e liberações (A17).
// - A LIBERAÇÃO (`connector_account_bots`) é por conta e bot. Conta nova e bot novo nascem sem ela (A15); a única liberação que o sistema faz sozinho é a semeadura abaixo.
// - A SEMEADURA (decisão 5) preserva o que os bots já usavam antes da phase: a primeira conta ATIVA de cada app (regra anterior de `ComposioToolSource.read()`) fica liberada aos bots que
//   existiam quando a migration rodou (instantâneo em `connector_seed`). Só a primeira leitura bem-sucedida do Composio sabe quais são as contas, então `sync` a conclui, numa transação
//   sob `CONNECTOR_ACCOUNTS_LOCK`, uma única vez. Com o Composio fora do ar ela fica pendente e nada é liberado.
//
// Garantias:
// - Nome da conta: 1 a 40 caracteres, único DENTRO DO APP e sem diferenciar maiúsculas (NFC e minúsculas, a mesma regra do nome dos bots). O nome é o valor do parâmetro de conta que o
//   modelo usa, então o RÓTULO automático ("Gmail · ca_…1a2b") de outra conta do app também ocupa o nome: duas contas nunca respondem pelo mesmo valor.
// - Toda alteração (nome, liberação, semeadura, remoção da conta desconectada) roda numa transação sob UMA trava de banco, confere a versão esperada (`CONNECTOR_ACCOUNT_CONFLICT`) e audita
//   quem fez o quê, SEM o id inteiro da conta (só o id mascarado) e sem nenhuma chave: este serviço nunca vê a chave do Composio, só as contas lidas por quem a guarda (`ConnectorAccountSource`).
//   Na remoção não há versão: o mesmo código quer dizer "a conta não está desconectada", a tela desatualizada.
// - A conferência da execução (`releasedTo`) lê só o banco, nunca um cache: revogar vale na chamada seguinte (A4).
// - A conta DESCONECTADA (que o Composio não lista mais) não volta: reconectar o app no Composio gera outro id. Por isso o dono pode REMOVÊ-LA (`remove`, R8): some a linha e as liberações,
//   o nome e o rótulo ficam livres, e se o Composio listar o mesmo id de novo ele entra como conta NOVA, sem nome nem liberação. Só a conta ausente de uma leitura ao vivo COMPLETA é removível (leitura truncada, com mais de 100 contas no Composio, recusa: R9).
// ponytail: uma trava global (CONNECTOR_ACCOUNTS_LOCK) serializa nome, liberação, semeadura e exclusão de bot; adequada a dono único, trocar por trava por conta se a espera aparecer.
// ponytail: a semeadura escolhe a "conta em uso" na primeira leitura boa e não no deploy; uma conta conectada entre os dois e listada antes da antiga seria liberada no lugar dela,
//   então disparar a primeira leitura já na subida da API se isso acontecer.
import { connectorAccountIdSchema, releaseConnectorAccountRequestSchema, renameConnectorAccountRequestSchema, type BotConnectorAccounts, type ConnectorAccountStatus, type ConnectorAccountView } from '@aion/shared';
import type { z } from 'zod';
import { recordAudit } from '../audit';
import type { RequestOrigin } from '../auth/service';
import { withTransaction, type Pool, type PoolClient, type Queryable } from '../db/pool';
import { DomainError } from '../errors';
import type { ConnectorAccountListing, ConnectorAccountListings } from './composio';

/**
 * Trava de banco (advisory, de transação) das alterações das contas do conector: nome, liberação, semeadura e a exclusão de bot que remove liberações. Chave distinta do lock do migrator
 * (7_265_341_001), de `TABLE_MUTATION_LOCK` (7_265_341_030) e de `DOC_MUTATION_LOCK` (7_265_341_060). Ordem entre travas, a de `BotService.deleteArchived`: `TABLE_MUTATION_LOCK`, depois esta, depois
 * `DOC_MUTATION_LOCK`, e só então as linhas (exclusão de bot e liberação concordam, sem impasse; a liberação de conta toma só esta).
 */
export const CONNECTOR_ACCOUNTS_LOCK = 7_265_341_050;

/** Quem lê as contas do Composio ao vivo (o `CredentialService`, que guarda a chave; os testes trocam por uma fonte falsa). */
export interface ConnectorAccountSource {
  listConnectorAccounts(): Promise<ConnectorAccountListings>;
}

export interface ConnectorAccountServiceOptions {
  pool: Pool;
  source: ConnectorAccountSource;
  /** Relógio injetável: os testes fixam o instante gravado na auditoria. */
  now?: () => Date;
}

/** A conta como o banco a guarda, sem o estado (que só a leitura ao vivo informa): o que a alteração de nome e de liberação devolve. */
export type ConnectorAccountRecord = Omit<ConnectorAccountView, 'status'>;

/** Conta liberada a um bot, só do banco: o que a conferência de CADA execução usa para decidir qual conta o bot pode usar. O estado (ativa ou desconectada) é da leitura ao vivo. */
export interface ReleasedConnectorAccount {
  id: string;
  appSlug: string;
  appName: string;
  name: string | null;
  label: string;
}

interface AccountRow {
  id: string;
  app_slug: string;
  app_name: string;
  name: string | null;
  version: number;
  bot_ids: string[];
}

/** Sufixo do id que o rótulo e a auditoria mostram: os 4 últimos caracteres do id sem o prefixo `ca_` do Composio. */
const ID_SUFFIX_LENGTH = 4;

/** Id mascarado ("ca_…1a2b"): identifica a conta para o dono e na auditoria sem repetir o id inteiro. */
export function maskConnectorAccountId(id: string): string {
  return `ca_…${(id.startsWith('ca_') ? id.slice(3) : id).slice(-ID_SUFFIX_LENGTH)}`;
}

/** O que identifica a conta para o dono, o cartão de aprovação, a auditoria e o modelo: o nome do dono, ou o rótulo automático ("Gmail · ca_…1a2b") quando não há nome. */
export function connectorAccountLabel({ appName, id, name }: { appName: string; id: string; name: string | null }): string {
  return name ?? `${appName} · ${maskConnectorAccountId(id)}`;
}

/** Chave de comparação do nome: NFC e minúsculas (independente do locale do banco), sem distinguir maiúsculas; a mesma regra do nome dos bots (`nameKeyOf`, `bots/service.ts`). */
const nameKeyOf = (text: string): string => text.normalize('NFC').toLowerCase();

const collator = new Intl.Collator('pt-BR');
const byAppThenLabel = <T extends { appName: string; label: string }>(a: T, b: T): number => collator.compare(a.appName, b.appName) || collator.compare(a.label, b.label);

/** Valida a entrada na borda do serviço (a rota já valida; o serviço não confia no chamador): campo e motivo fixos, sem repetir o valor recebido. */
function parseInput<T>(schema: z.ZodType<T>, input: unknown, field = 'body'): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? field)))].map((name) => ({ field: name, reason: 'Valor inválido.' }));
  throw new DomainError('VALIDATION_FAILED', { fields });
}

/** As contas gravadas com os bots liberados de cada uma (uma só consulta, então a lista é um retrato coerente); `id` limita a uma conta. */
async function readRows(db: Queryable, id: string | null): Promise<AccountRow[]> {
  const result = await db.query<AccountRow>(
    `SELECT a.id, a.app_slug, a.app_name, a.name, a.version,
            COALESCE(array_agg(r.bot_id::text ORDER BY r.bot_id) FILTER (WHERE r.bot_id IS NOT NULL), '{}') AS bot_ids
       FROM connector_accounts a LEFT JOIN connector_account_bots r ON r.account_id = a.id
      WHERE ($1::text IS NULL OR a.id = $1)
      GROUP BY a.id
      ORDER BY a.app_slug, a.id`,
    [id],
  );
  return result.rows;
}

const toRecord = (row: AccountRow): ConnectorAccountRecord => ({
  id: row.id,
  appSlug: row.app_slug,
  appName: row.app_name,
  name: row.name,
  label: connectorAccountLabel({ appName: row.app_name, id: row.id, name: row.name }),
  botIds: row.bot_ids,
  version: row.version,
});

/** O estado ao vivo de cada conta lida; a conta que NÃO está no mapa não veio do Composio e vale como desconectada. */
const liveStatusOf = (live: readonly ConnectorAccountListing[]): Map<string, ConnectorAccountStatus> => new Map(live.map((account) => [account.id, account.status]));

/** Uma só entrada por id (a primeira vale), na ordem recebida: o Composio não repete conta, mas o upsert em lote falharia se repetisse. */
function distinctById(live: readonly ConnectorAccountListing[]): ConnectorAccountListing[] {
  const seen = new Set<string>();
  return live.filter((account) => !seen.has(account.id) && seen.add(account.id));
}

export class ConnectorAccountService {
  private readonly pool: Pool;
  private readonly source: ConnectorAccountSource;
  private readonly now: () => Date;

  constructor({ pool, source, now = () => new Date() }: ConnectorAccountServiceOptions) {
    this.pool = pool;
    this.source = source;
    this.now = now;
  }

  // ---------------------------------------------------------------------------------------------
  // Leitura ao vivo + gravação das contas conhecidas + semeadura
  // ---------------------------------------------------------------------------------------------

  /**
   * Grava no banco as contas que a leitura ao vivo trouxe (as novas e o nome legível do app, que pode mudar) e, na PRIMEIRA leitura bem-sucedida, conclui a semeadura da liberação.
   * Quem lê o Composio (a tela de Conexões, o editor do bot e a fonte das ferramentas do conector) chama isto com o resultado da leitura. Barato quando nada mudou: duas consultas, sem
   * transação nem trava. A conta que NÃO veio na leitura não é tocada (fica desconectada; o estado nunca é gravado).
   */
  async sync(live: readonly ConnectorAccountListing[]): Promise<void> {
    const accounts = distinctById(live);
    const known = new Map((await this.pool.query<{ id: string; app_name: string }>('SELECT id, app_name FROM connector_accounts')).rows.map((row) => [row.id, row.app_name]));
    const stale = accounts.filter((account) => known.get(account.id) !== account.toolkitName);
    const seed = await this.pool.query<{ pending: boolean }>('SELECT completed_at IS NULL AS pending FROM connector_seed');
    const seedPending = seed.rows[0]?.pending === true;
    if (stale.length === 0 && !seedPending) return;

    const at = this.now();
    await withTransaction(this.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [CONNECTOR_ACCOUNTS_LOCK]);
      if (stale.length > 0) {
        // Só o nome do app é atualizado numa conta conhecida: o app de uma conta não muda no Composio, e trocá-lo poderia colidir com o índice único do nome.
        await tx.query(
          `INSERT INTO connector_accounts (id, app_slug, app_name)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
           ON CONFLICT (id) DO UPDATE SET app_name = EXCLUDED.app_name`,
          [stale.map((account) => account.id), stale.map((account) => account.toolkitSlug), stale.map((account) => account.toolkitName)],
        );
      }
      if (seedPending) await this.seedOnce(tx, accounts, at);
    });
  }

  /**
   * Conclui a semeadura (decisão 5) dentro da transação de `sync`, já sob a trava: a primeira conta ATIVA de cada app, na ordem da listagem do Composio (a regra que os bots já seguiam),
   * é liberada aos bots do instantâneo que ainda existem; a versão de cada conta liberada sobe; o instantâneo é descartado e a semeadura fica concluída. Se outra instância a concluiu entre
   * a checagem de `sync` e a trava, não há linha pendente e nada acontece (uma única vez).
   */
  private async seedOnce(tx: PoolClient, accounts: readonly ConnectorAccountListing[], at: Date): Promise<void> {
    const pending = await tx.query<{ bot_ids: string[] }>('SELECT bot_ids::text[] AS bot_ids FROM connector_seed WHERE completed_at IS NULL FOR UPDATE');
    const snapshot = pending.rows[0];
    if (!snapshot) return;
    const firstActive = new Map<string, string>();
    for (const account of accounts) if (account.status === 'active' && !firstActive.has(account.toolkitSlug)) firstActive.set(account.toolkitSlug, account.id);

    let releasedAccounts = 0;
    let releasedBots = 0;
    if (firstActive.size > 0 && snapshot.bot_ids.length > 0) {
      // O bot excluído desde o instantâneo não entra (a junção com `bots` o descarta), e a chave estrangeira nunca é violada.
      const released = await tx.query<{ account_id: string; bot_id: string }>(
        `INSERT INTO connector_account_bots (account_id, bot_id)
         SELECT a.id, b.id FROM unnest($1::text[]) AS a(id) CROSS JOIN bots b WHERE b.id = ANY($2::uuid[])
         ON CONFLICT DO NOTHING RETURNING account_id, bot_id::text AS bot_id`,
        [[...firstActive.values()], snapshot.bot_ids],
      );
      const touched = [...new Set(released.rows.map((row) => row.account_id))];
      if (touched.length > 0) await tx.query('UPDATE connector_accounts SET version = version + 1 WHERE id = ANY($1::text[])', [touched]);
      releasedAccounts = touched.length;
      releasedBots = new Set(released.rows.map((row) => row.bot_id)).size;
    }
    await tx.query('UPDATE connector_seed SET completed_at = $1, bot_ids = $2::uuid[]', [at, []]);
    await recordAudit(tx, { action: 'connector_account.seed', outcome: 'success', actor: 'system', details: { accounts: releasedAccounts, bots: releasedBots } }, at);
  }

  // ---------------------------------------------------------------------------------------------
  // Leituras
  // ---------------------------------------------------------------------------------------------

  /**
   * Todas as contas conhecidas, ativas e desconectadas, cada uma com nome (ou rótulo), estado, bots liberados e versão: a tela de Conexões (A12). Lê o Composio ao vivo (e grava as
   * contas novas, `sync`); a falha da leitura (`CONNECTOR_NOT_CONFIGURED`, `CONNECTOR_KEY_INVALID`, `CONNECTOR_UNAVAILABLE`) sobe como está, sem gravar nem esconder nada.
   */
  async list(): Promise<ConnectorAccountView[]> {
    const live = await this.source.listConnectorAccounts();
    await this.sync(live);
    const status = liveStatusOf(live);
    return (await readRows(this.pool, null)).map((row) => ({ ...toRecord(row), status: status.get(row.id) ?? 'disconnected' })).sort(byAppThenLabel);
  }

  /** Uma conta, como em `list`. `NOT_FOUND` se o Aion não a conhece (a rota de alteração responde com ela depois de gravar). */
  async get(id: string): Promise<ConnectorAccountView> {
    const accountId = parseInput(connectorAccountIdSchema, id, 'id');
    const found = (await this.list()).find((account) => account.id === accountId);
    if (!found) throw new DomainError('NOT_FOUND');
    return found;
  }

  /**
   * As contas liberadas a UM bot, SÓ do banco (sem o estado): a conferência de cada execução e de cada retomada após aprovação, fora de qualquer cache (A4, A5). Ordenadas por app e id,
   * estáveis. O estado da conta (desconectada) é cruzado por quem tem a leitura ao vivo.
   */
  async releasedTo(botId: string): Promise<ReleasedConnectorAccount[]> {
    const result = await this.pool.query<{ id: string; app_slug: string; app_name: string; name: string | null }>(
      `SELECT a.id, a.app_slug, a.app_name, a.name
         FROM connector_account_bots r JOIN connector_accounts a ON a.id = r.account_id
        WHERE r.bot_id = $1 ORDER BY a.app_slug, a.id`,
      [botId],
    );
    return result.rows.map((row) => ({ id: row.id, appSlug: row.app_slug, appName: row.app_name, name: row.name, label: connectorAccountLabel({ appName: row.app_name, id: row.id, name: row.name }) }));
  }

  /**
   * As contas liberadas a um bot COM o estado ao vivo (a seção só leitura do editor do bot, A13): sem os bots nem a versão, que o editor não altera. `BOT_NOT_FOUND` para bot inexistente;
   * a falha da leitura do Composio sobe como em `list`.
   */
  async forBot(botId: string): Promise<BotConnectorAccounts['accounts']> {
    const bot = await this.pool.query('SELECT 1 FROM bots WHERE id = $1', [botId]);
    if (!bot.rowCount) throw new DomainError('BOT_NOT_FOUND');
    const live = await this.source.listConnectorAccounts();
    await this.sync(live);
    const status = liveStatusOf(live);
    return (await this.releasedTo(botId)).map((account) => ({ ...account, status: status.get(account.id) ?? 'disconnected' })).sort(byAppThenLabel);
  }

  // ---------------------------------------------------------------------------------------------
  // Alterações do dono (a rota exige sessão, Origin e CSRF; aqui valem versão, unicidade e auditoria)
  // ---------------------------------------------------------------------------------------------

  /**
   * Dá nome à conta, ou volta ao rótulo automático com `name: null` (A11). Lança `VALIDATION_FAILED` (nome vazio, acima de 40 caracteres, com caractere de controle, campo extra),
   * `NOT_FOUND` (conta que o Aion não conhece), `CONNECTOR_ACCOUNT_CONFLICT` (versão antiga) e `CONNECTOR_ACCOUNT_NAME_TAKEN` (outra conta do MESMO app já responde por esse nome ou
   * rótulo, sem diferenciar maiúsculas). Repetir o nome gravado não muda nada. Devolve a conta sem o estado (só o banco): a rota completa com `get`.
   */
  async rename(id: string, raw: unknown, origin: RequestOrigin): Promise<ConnectorAccountRecord> {
    const accountId = parseInput(connectorAccountIdSchema, id, 'id');
    const input = parseInput(renameConnectorAccountRequestSchema, raw);
    const at = this.now();
    return withTransaction(this.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [CONNECTOR_ACCOUNTS_LOCK]);
      const current = await this.lockAccount(tx, accountId);
      if (current.version !== input.expectedVersion) throw new DomainError('CONNECTOR_ACCOUNT_CONFLICT');
      if (input.name === current.name) return toRecord(current);
      if (input.name !== null) {
        const others = await tx.query<{ id: string; app_name: string; name: string | null }>('SELECT id, app_name, name FROM connector_accounts WHERE app_slug = $1 AND id <> $2', [current.app_slug, accountId]);
        const taken = new Set(others.rows.map((other) => nameKeyOf(connectorAccountLabel({ appName: other.app_name, id: other.id, name: other.name }))));
        if (taken.has(nameKeyOf(input.name))) throw new DomainError('CONNECTOR_ACCOUNT_NAME_TAKEN');
      }
      await tx.query('UPDATE connector_accounts SET name = $2, name_key = $3, version = version + 1 WHERE id = $1', [accountId, input.name, input.name === null ? null : nameKeyOf(input.name)]);
      await recordAudit(
        tx,
        {
          action: 'connector_account.rename',
          outcome: 'success',
          actor: 'owner',
          ip: origin.ip,
          userAgent: origin.userAgent,
          target: maskConnectorAccountId(accountId),
          details: { app: current.app_slug, previousName: current.name, name: input.name },
        },
        at,
      );
      return toRecord((await readRows(tx, accountId))[0] as AccountRow);
    });
  }

  /**
   * Define QUAIS bots usam a conta: a lista completa, quem sai perde o acesso e a lista vazia revoga todos (A19). Lança `VALIDATION_FAILED` (id fora do formato, repetido, mais de 100,
   * campo extra), `NOT_FOUND`, `CONNECTOR_ACCOUNT_CONFLICT` (versão antiga) e `BOT_NOT_FOUND` (algum bot não existe; nada é gravado). A mesma lista não muda nada. Cada bot liberado ou
   * revogado gera um evento de auditoria com quem fez, a conta (id mascarado e app) e o bot. Devolve a conta sem o estado, como `rename`.
   */
  async release(id: string, raw: unknown, origin: RequestOrigin): Promise<ConnectorAccountRecord> {
    const accountId = parseInput(connectorAccountIdSchema, id, 'id');
    const input = parseInput(releaseConnectorAccountRequestSchema, raw);
    const at = this.now();
    return withTransaction(this.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [CONNECTOR_ACCOUNTS_LOCK]);
      const current = await this.lockAccount(tx, accountId);
      if (current.version !== input.expectedVersion) throw new DomainError('CONNECTOR_ACCOUNT_CONFLICT');
      const bots = await tx.query('SELECT 1 FROM bots WHERE id = ANY($1::uuid[])', [input.botIds]);
      if (bots.rowCount !== input.botIds.length) throw new DomainError('BOT_NOT_FOUND');

      const previous = new Set(current.bot_ids);
      const wanted = new Set(input.botIds);
      const added = input.botIds.filter((botId) => !previous.has(botId));
      const removed = current.bot_ids.filter((botId) => !wanted.has(botId));
      if (added.length === 0 && removed.length === 0) return toRecord(current);

      if (removed.length > 0) await tx.query('DELETE FROM connector_account_bots WHERE account_id = $1 AND bot_id = ANY($2::uuid[])', [accountId, removed]);
      if (added.length > 0) await tx.query('INSERT INTO connector_account_bots (account_id, bot_id) SELECT $1, unnest($2::uuid[])', [accountId, added]);
      await tx.query('UPDATE connector_accounts SET version = version + 1 WHERE id = $1', [accountId]);
      for (const [action, botIds] of [['connector_account.release', added], ['connector_account.revoke', removed]] as const) {
        for (const botId of botIds) {
          await recordAudit(
            tx,
            { action, outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: maskConnectorAccountId(accountId), details: { app: current.app_slug, name: current.name, botId } },
            at,
          );
        }
      }
      return toRecord((await readRows(tx, accountId))[0] as AccountRow);
    });
  }

  /**
   * Remove do Aion uma conta DESCONECTADA (R8): a que o Composio não lista mais e que, como reconectar o app gera outro id, nunca voltaria a ser usada. Apaga a linha da conta e, pela
   * cascata da chave estrangeira (`connector_account_bots.account_id`, migration 0050), as liberações dela, numa transação sob a trava das contas, e audita quem removeu e qual conta
   * (id mascarado, app e nome; nunca o id inteiro nem a chave). O estado vem da leitura AO VIVO feita aqui, nunca do que a tela mostrava: uma conta que o Composio lista (ativa, pendente
   * ou que requer atenção) é recusada com `CONNECTOR_ACCOUNT_CONFLICT` ("as contas mudaram"; é a tela desatualizada que a web já trata recarregando as contas), então a remoção
   * nunca apaga uma conta em uso. A falha da leitura (`CONNECTOR_NOT_CONFIGURED`, `CONNECTOR_KEY_INVALID`, `CONNECTOR_UNAVAILABLE`) sobe como está e nada é apagado: sem a leitura não há
   * como saber que a conta sumiu. O mesmo vale para a leitura TRUNCADA (R9): o adaptador só lê a primeira página do Composio (100 contas) e marca `truncated` quando há mais, então a ausência
   * de uma conta nela não prova que o Composio a perdeu (a 101ª, ativa, apareceria como desconectada); a remoção é recusada com `CONNECTOR_UNAVAILABLE`, o código que a leitura já usa para "não
   * consegui uma leitura confiável do Composio", sem apagar nem auditar nada (`CONNECTOR_ACCOUNT_CONFLICT` mandaria recarregar a tela, e recarregar não resolve). `list` e a execução não mudam.
   * Outros erros: `VALIDATION_FAILED` (id fora do formato) e `NOT_FOUND` (conta que o Aion não conhece, inclusive já removida).
   * Efeito sobre os bots: a conta desconectada já não faz parte das definições do conector de nenhum bot (só entram contas liberadas E ativas), então a remoção não muda o campo `tools`; e uma
   * aprovação pendente que gravou essa conta é recusada na retomada como "não está mais liberada" (`resolveAccount`). Se o Composio listar o mesmo id depois, `sync` o grava como conta nova.
   * ponytail: a leitura ao vivo acontece antes da transação, sem repetir dentro dela; uma conta que o Composio voltasse a listar nessa janela de milissegundos seria removida, e o dono a
   * veria de novo na próxima leitura (sem nome nem liberação); adequado a dono único, repetir a conferência na transação se a janela passar a importar.
   */
  async remove(id: string, origin: RequestOrigin): Promise<void> {
    const accountId = parseInput(connectorAccountIdSchema, id, 'id');
    const live = await this.source.listConnectorAccounts();
    if (live.truncated) throw new DomainError('CONNECTOR_UNAVAILABLE');
    const status = liveStatusOf(live);
    const at = this.now();
    await withTransaction(this.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [CONNECTOR_ACCOUNTS_LOCK]);
      const current = await this.lockAccount(tx, accountId);
      if (status.has(accountId)) throw new DomainError('CONNECTOR_ACCOUNT_CONFLICT');
      await tx.query('DELETE FROM connector_accounts WHERE id = $1', [accountId]);
      await recordAudit(
        tx,
        {
          action: 'connector_account.remove',
          outcome: 'success',
          actor: 'owner',
          ip: origin.ip,
          userAgent: origin.userAgent,
          target: maskConnectorAccountId(accountId),
          details: { app: current.app_slug, name: current.name, bots: current.bot_ids.length },
        },
        at,
      );
    });
  }

  /** A conta travada até o fim da transação; `NOT_FOUND` se o Aion não a conhece. */
  private async lockAccount(tx: PoolClient, id: string): Promise<AccountRow> {
    const locked = await tx.query('SELECT id FROM connector_accounts WHERE id = $1 FOR UPDATE', [id]);
    if (!locked.rowCount) throw new DomainError('NOT_FOUND');
    return (await readRows(tx, id))[0] as AccountRow;
  }
}
