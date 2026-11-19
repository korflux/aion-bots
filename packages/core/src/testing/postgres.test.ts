// Prova da limpeza de clusters de teste órfãos (E9): o diretório com mais de 2 h tem o postmaster encerrado (só se o PID for mesmo de um
// postgres) e é apagado; o recente nunca é tocado; um PID que virou outro programa não é encerrado. O encerramento é simulado
// (`PostgresProcesses`), então o teste não depende de ter um PostgreSQL órfão de verdade na máquina.
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeStaleDataDirs, type PostgresProcesses } from './postgres';

const HOUR = 60 * 60 * 1000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Pasta temporária com diretórios `aion-pg-*` de idades dadas; cada um com o `postmaster.pid` do PID dado (ou sem o arquivo). */
async function fakeRoot(dirs: Array<{ name: string; ageMs: number; pid?: number }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aion-cleanup-root-'));
  roots.push(root);
  for (const { name, ageMs, pid } of dirs) {
    const dir = join(root, name);
    await mkdir(dir);
    if (pid !== undefined) await writeFile(join(dir, 'postmaster.pid'), `${pid}\n${dir}\n1700000000\n5432\n`);
    const at = new Date(Date.now() - ageMs);
    await utimes(dir, at, at);
  }
  return root;
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe('limpeza de clusters de teste órfãos', () => {
  it('encerra o postmaster do diretório antigo e o apaga; o diretório recente e o prefixo alheio ficam como estão', async () => {
    const root = await fakeRoot([
      { name: 'aion-pg-antigo', ageMs: 3 * HOUR, pid: 4242 },
      { name: 'aion-pg-recente', ageMs: 10 * 60_000, pid: 5151 },
      { name: 'outra-coisa', ageMs: 5 * HOUR, pid: 6060 },
    ]);
    const killed: number[] = [];
    const processes: PostgresProcesses = { isPostgres: () => true, kill: (pid) => void killed.push(pid) };

    await removeStaleDataDirs({ root, processes });

    expect(killed).toEqual([4242]); // só o do diretório antigo
    expect(await exists(join(root, 'aion-pg-antigo'))).toBe(false);
    expect(await exists(join(root, 'aion-pg-recente'))).toBe(true);
    expect(await exists(join(root, 'outra-coisa'))).toBe(true);
  });

  it('um PID que não é mais de um postgres (reaproveitado) não é encerrado, e um diretório sem postmaster.pid é só apagado', async () => {
    const root = await fakeRoot([
      { name: 'aion-pg-pid-reaproveitado', ageMs: 4 * HOUR, pid: 7777 },
      { name: 'aion-pg-sem-pid', ageMs: 4 * HOUR },
    ]);
    const killed: number[] = [];
    const processes: PostgresProcesses = { isPostgres: () => false, kill: (pid) => void killed.push(pid) };

    await removeStaleDataDirs({ root, processes });

    expect(killed).toEqual([]);
    expect(await exists(join(root, 'aion-pg-pid-reaproveitado'))).toBe(false);
    expect(await exists(join(root, 'aion-pg-sem-pid'))).toBe(false);
  });
});
