// Prova do código de saída (phase 9, T12): importar `./postgres` (e com ele o `embedded-postgres`, que instala um gancho de saída que
// chama `process.exit(0)`) não pode transformar uma falha em sucesso. O teste roda um processo Node de verdade, que é onde o código de
// saída existe, com o mesmo caminho do Vitest: fixar `process.exitCode` e deixar o processo terminar sozinho.
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const POSTGRES_MODULE = pathToFileURL(fileURLToPath(new URL('./postgres.ts', import.meta.url))).href;

/** Executa `script` num processo Node (com `tsx`, como as demais CLIs do repo) que já importou o módulo de PostgreSQL de teste; devolve o código de saída. */
function exitCodeOf(script: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', `await import(${JSON.stringify(POSTGRES_MODULE)}); ${script}`],
      { cwd: ROOT, timeout: 60_000 },
      (error) => resolve(error ? (typeof error.code === 'number' ? error.code : -1) : 0),
    );
  });
}

describe('código de saída com o gancho do embedded-postgres carregado', () => {
  it('um processo que fixa process.exitCode e termina sozinho sai com esse código, não com 0', async () => {
    expect(await exitCodeOf('process.exitCode = 1;')).toBe(1);
    expect(await exitCodeOf('process.exitCode = 7;')).toBe(7);
  });

  it('um processo sem falha continua saindo com 0', async () => {
    expect(await exitCodeOf('')).toBe(0);
  });
});
