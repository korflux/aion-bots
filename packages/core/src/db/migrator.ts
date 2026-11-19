// Executor de migrations SQL, rodado pela API na inicialização (produção incluída).
//
// Garantias, porque isto roda sozinho a cada deploy:
// - Serializado por advisory lock: duas instâncias subindo juntas não aplicam a mesma migration duas vezes.
// - Cada migration roda numa transação com o registro em `schema_migrations`: ou entra inteira ou não entra.
// - Migration marcada `destructive` só roda com `allowDestructive` (pedido explícito do dono, AGENTS.md).
// - Todas as migrations carregam o próprio plano de rollback (`rollback`), exercitado nos testes.
// - Um RAISE WARNING dentro da migration (degradação segura, ex.: 0016 sem a extensão `unaccent`) chega ao log do serviço.
import type { Logger } from '../logging';
import type { Pool } from './pool';
import { MIGRATIONS } from './migrations';

export interface Migration {
  /** Identificador ordenável e imutável: `NNNN_descricao_curta`. */
  id: string;
  description: string;
  /** SQL aplicado no deploy. Aditivo por padrão (criar tabela/coluna/índice). */
  up: string;
  /** Plano de rollback: SQL que desfaz `up`. Executado manualmente pelo dono se um deploy precisar voltar. */
  rollback: string;
  /** Verdadeiro se `up` remove ou altera dados/estrutura de forma irreversível. */
  destructive?: boolean;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Padrão que denuncia SQL destrutivo; um teste garante que toda migration que o casa declara `destructive`. */
export const DESTRUCTIVE_SQL_PATTERN =
  /\b(DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE)\b/i;

/** Chave arbitrária e fixa do advisory lock de migrations (não colide com o lock do pg-boss). */
const MIGRATION_LOCK_KEY = 7_265_341_001;

export interface RunMigrationsOptions {
  migrations?: readonly Migration[];
  allowDestructive?: boolean;
  logger?: Logger;
}

/** Aplica as migrations pendentes em ordem e devolve os ids aplicados. */
export async function runMigrations(
  pool: Pool,
  { migrations = MIGRATIONS, allowDestructive = false, logger }: RunMigrationsOptions = {},
): Promise<string[]> {
  const client = await pool.connect();
  // Avisos que a própria migration emite (RAISE WARNING, ex.: a 0016 sem a extensão `unaccent`) vão para o log do serviço: sem este
  // ouvinte ficariam só no log do PostgreSQL, fora do alcance de quem acompanha o deploy. Só WARNING; os NOTICE de rotina (ex.: "já existe,
  // ignorando") são ruído.
  let applying = '';
  const forwardWarning = (notice: { severity?: string; message?: string }): void => {
    if (notice.severity === 'WARNING') logger?.warn({ migration: applying }, notice.message ?? 'aviso do PostgreSQL');
  };
  client.on('notice', forwardWarning);

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const appliedRows = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(appliedRows.rows.map((row) => row.id));
    const pending = migrations.filter((migration) => !applied.has(migration.id));

    // Confere antes de aplicar qualquer uma: uma destrutiva bloqueada não pode deixar as anteriores pela metade.
    const blocked = pending.filter((migration) => migration.destructive && !allowDestructive);
    if (blocked.length > 0) {
      throw new MigrationError(
        `Migration destrutiva bloqueada (${blocked.map((m) => m.id).join(', ')}): exige AION_ALLOW_DESTRUCTIVE_MIGRATIONS=true.`,
      );
    }

    const ran: string[] = [];
    for (const migration of pending) {
      applying = migration.id;
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '5min'");
        await client.query(migration.up);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new MigrationError(`Falha ao aplicar ${migration.id}: ${(error as Error).message}`);
      }
      logger?.info({ migration: migration.id }, 'migration aplicada');
      ran.push(migration.id);
    }
    return ran;
  } finally {
    client.off('notice', forwardWarning);
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

export interface WaitForSchemaOptions {
  migrations?: readonly Migration[];
  timeoutMs?: number;
  intervalMs?: number;
  logger?: Logger;
}

/**
 * Espera a API terminar de aplicar TODAS as migrations conhecidas por este código. O worker usa antes de ler tabelas do
 * app: os serviços sobem em paralelo no Easypanel e só a API migra o banco (o worker nunca escreve o schema do app).
 * Lança se o schema não ficar pronto no prazo, para o serviço reiniciar em vez de rodar contra um banco desatualizado.
 */
export async function waitForSchema(
  pool: Pool,
  { migrations = MIGRATIONS, timeoutMs = 60_000, intervalMs = 1_000, logger }: WaitForSchemaOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Antes da primeira migration a tabela de controle nem existe: a consulta falha e conta como "ainda não".
    const applied = await pool.query<{ id: string }>('SELECT id FROM schema_migrations').catch(() => null);
    const ids = new Set(applied?.rows.map((row) => row.id));
    if (migrations.every((migration) => ids.has(migration.id))) return;
    if (Date.now() >= deadline) throw new MigrationError('O banco não foi migrado a tempo: a API precisa aplicar as migrations antes.');
    logger?.warn('aguardando a API migrar o banco');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
