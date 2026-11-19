// Acesso ao PostgreSQL: pool único por processo, espera pela disponibilidade e transações curtas.
//
// Todas as consultas do projeto usam parâmetros ($1, $2...): nada de concatenar entrada externa em SQL.
import pg from 'pg';
import { databaseErrorForLog, type Logger } from '../logging';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Qualquer coisa que execute queries: o pool ou um cliente dentro de transação. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export interface PoolOptions {
  /** Aparece em pg_stat_activity, ajuda a distinguir api e worker no banco. */
  applicationName: string;
  max?: number;
  logger?: Logger;
}

/**
 * Cria o pool do serviço. `statement_timeout` protege contra consulta travada; migrations ampliam o limite
 * localmente dentro da própria transação.
 */
export function createPool(databaseUrl: string, { applicationName, max = 10, logger }: PoolOptions): Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: applicationName,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  // Sem este handler, um erro em cliente ocioso (ex.: banco reiniciado) derrubaria o processo.
  pool.on('error', (error) => logger?.error({ err: databaseErrorForLog(error) }, 'erro em conexão ociosa do pool'));
  return pool;
}

export interface WaitForDatabaseOptions {
  timeoutMs?: number;
  intervalMs?: number;
  logger?: Logger;
}

/**
 * Espera o banco aceitar conexões. No Easypanel os serviços sobem em paralelo, então a api pode iniciar
 * antes do PostgreSQL; tentar por alguns segundos evita um crash-loop desnecessário.
 */
export async function waitForDatabase(
  pool: Pool,
  { timeoutMs = 30_000, intervalMs = 1_000, logger }: WaitForDatabaseOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      logger?.warn('banco ainda indisponível, tentando novamente');
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/**
 * Falha fechada se o banco não for UTF8 (E8). Um banco em SQL_ASCII ou WIN1252 sobe sem aviso e só falha depois, em texto livre (nome de
 * bot, memória, mensagem com emoji ou acento combinado), com erro no meio de uma gravação. A codificação é decidida na criação do banco e
 * não muda depois, então a checagem é uma vez na subida de cada serviço, depois de `waitForDatabase`.
 */
export async function assertUtf8Database(pool: Pool): Promise<void> {
  const result = await pool.query<{ server_encoding: string }>('SHOW server_encoding');
  const encoding = result.rows[0]?.server_encoding;
  if (encoding !== 'UTF8') {
    throw new Error(`O banco de dados usa a codificação ${encoding ?? 'desconhecida'}, e o Aion exige UTF8. Crie o banco com ENCODING 'UTF8' (o padrão do PostgreSQL do Easypanel) e migre os dados.`);
  }
}

/** Executa `fn` numa transação (BEGIN/COMMIT, ROLLBACK em erro). Mantenha `fn` curta: só operações no banco. */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
