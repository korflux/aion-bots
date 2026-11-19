// PostgreSQL de teste: local via `embedded-postgres` (binário como dependência de desenvolvimento, sem Docker)
// ou o serviço externo indicado por AION_TEST_DATABASE_URL (no CI, o serviço `postgres:17` do GitHub Actions).
//
// Um cluster por execução de testes; cada arquivo de teste cria o próprio banco (`createTestDatabase`), então
// os testes não compartilham estado e podem rodar em paralelo.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

// Tipa `inject('adminDatabaseUrl')` em todo teste que usa este helper (o valor é provido pelo global-setup).
declare module 'vitest' {
  export interface ProvidedContext {
    /** URL de administração do PostgreSQL de teste (ver `createTestDatabase`). */
    adminDatabaseUrl: string;
  }
}

// --- Código de saída do processo -------------------------------------------------------------------------------------------------
//
// Causa raiz de `pnpm test` sair com 0 com testes falhando: ao ser IMPORTADO, o `embedded-postgres` registra um gancho do `async-exit-hook`
// em `beforeExit` que, depois de parar os clusters, chama `process.exit(0)` com código explícito. O Vitest (e as CLIs de `tests/support`)
// sinalizam a falha com `process.exitCode = 1` e deixam o processo terminar sozinho; é nesse `beforeExit` que o gancho passa por cima e
// zera o código. Importar este módulo basta para o gancho existir (nem precisa subir um cluster), então a correção mora aqui, na única
// porta de entrada do `embedded-postgres` do repositório, e vale para o Vitest da raiz (com ou sem filtro de arquivos), para o E2E e para
// as sondas. Desligar o gancho não serve: ele é o que derruba clusters esquecidos quando o processo é interrompido.
//
// Como funciona: o `beforeExit` do gancho só AGENDA o `process.exit(0)` (nextTick), então um listener nosso, registrado depois, ainda roda
// nessa mesma emissão e enxerga o `exitCode` intacto; guardamos o código de falha e o devolvemos no `exit`, o último ponto em que mudar
// `process.exitCode` ainda vale. Um código de saída diferente de zero visto no `beforeExit` nunca vira sucesso; um outro código de falha
// fixado depois é respeitado.
// ponytail: depende de o gancho agendar o `process.exit(0)` em vez de chamá-lo na hora; se uma versão futura do embedded-postgres sair de forma síncrona,
// o `exit-code.test.ts` reprova e o gancho precisa ser desligado na origem (ou o pacote atualizado).
let failureExitCode: number | string | undefined;
process.on('beforeExit', () => {
  if (process.exitCode) failureExitCode = process.exitCode;
});
process.on('exit', () => {
  if (failureExitCode && !process.exitCode) process.exitCode = failureExitCode;
});

export interface TestPostgres {
  /** URL de um superusuário no banco `postgres`, usada para criar/remover bancos de teste. */
  adminUrl: string;
  stop(): Promise<void>;
}

/** Pede ao SO uma porta livre (evita conflito com um PostgreSQL já rodando na máquina). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const DATA_DIR_PREFIX = 'aion-pg-';
const STALE_DATA_DIR_MS = 2 * 60 * 60 * 1000;

/** O que `removeStaleDataDirs` faz com processos: separado para o teste provar a regra sem encerrar um PostgreSQL de verdade. */
export interface PostgresProcesses {
  /** O processo `pid` está vivo e é um postgres? (um PID reaproveitado por outro programa nunca é encerrado) */
  isPostgres(pid: number): boolean;
  /** Encerra o processo e os filhos dele. */
  kill(pid: number): void;
}

/** Implementação real: `tasklist`/`taskkill` no Windows, `ps` e sinal nos demais. Melhor esforço: erro vira "não é postgres" ou é ignorado. */
const REAL_PROCESSES: PostgresProcesses = {
  isPostgres(pid) {
    try {
      if (process.platform === 'win32') {
        const listed = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        return listed.toLowerCase().includes('"postgres.exe"');
      }
      return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).toLowerCase().includes('postgres');
    } catch {
      return false;
    }
  },
  kill(pid) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch {
      // Já terminou ou sem permissão: o diretório é apagado do mesmo jeito.
    }
  },
};

/** PID do postmaster, na primeira linha do `postmaster.pid` que o PostgreSQL grava no diretório de dados; nulo se não há ou não é número. */
async function postmasterPidOf(dataDir: string): Promise<number | null> {
  const content = await readFile(join(dataDir, 'postmaster.pid'), 'utf8').catch(() => null);
  const pid = Number((content ?? '').split(/\r?\n/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export interface StaleCleanupOptions {
  /** Pasta onde ficam os diretórios `aion-pg-*` (padrão: a temporária do sistema). */
  root?: string;
  /** Relógio injetável. */
  now?: () => number;
  processes?: PostgresProcesses;
}

/**
 * Limpa o que execuções anteriores deixaram para trás (o Playwright derruba a pilha em árvore no Windows, sem rodar `stop`): para cada
 * diretório `aion-pg-*` com mais de 2 h, ENCERRA o postmaster que ainda o segura (o PID está no `postmaster.pid` do diretório, e só um
 * processo que de fato seja postgres é encerrado) e então apaga o diretório (~48 MB). O servidor órfão acumulava memória na máquina e
 * impedia a remoção do diretório (E9). Só toca nos com mais de 2 h para não mexer num cluster de outra execução em andamento. Melhor
 * esforço: o que estiver travado fica para a próxima.
 */
export async function removeStaleDataDirs({ root = tmpdir(), now = Date.now, processes = REAL_PROCESSES }: StaleCleanupOptions = {}): Promise<void> {
  const cutoff = now() - STALE_DATA_DIR_MS;
  for (const entry of await readdir(root).catch(() => [])) {
    if (!entry.startsWith(DATA_DIR_PREFIX)) continue;
    const path = join(root, entry);
    try {
      if ((await stat(path)).mtimeMs >= cutoff) continue;
      const pid = await postmasterPidOf(path);
      if (pid !== null && processes.isPostgres(pid)) processes.kill(pid);
      await rm(path, { recursive: true, force: true });
    } catch {
      // Em uso ou sem permissão: fica para a próxima.
    }
  }
}

/** Sobe o cluster de teste. Com AION_TEST_DATABASE_URL definido, apenas o reutiliza. */
export async function startTestPostgres(): Promise<TestPostgres> {
  const external = process.env.AION_TEST_DATABASE_URL;
  if (external) return { adminUrl: external, stop: async () => undefined };

  await removeStaleDataDirs();
  const port = await freePort();
  const password = randomBytes(12).toString('hex');
  const databaseDir = await mkdtemp(join(tmpdir(), DATA_DIR_PREFIX));
  const server = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password,
    port,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
  return {
    adminUrl: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`,
    stop: () => server.stop(),
  };
}

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

/**
 * Cria um banco vazio e único para um arquivo de teste. O banco é sempre UTF8, como o PostgreSQL de produção: o
 * cluster embarcado herda a codificação do SO (WIN1252 no Windows pt-BR), o que recusaria emoji e acentos
 * combinados em texto livre (nome de bot) só nos testes locais. `template0` é o que permite escolher a codificação.
 */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `aion_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
