// Smoke da CLI report:cost: processo real contra um banco migrado e vazio (a classificação e as contas são provadas em
// packages/core/src/usage/cost-report.test.ts), mais as recusas na borda sem vazar a URL do banco.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPool } from '@aion/core';
import { createTestDatabase, migrateTestDatabase } from '@aion/core/testing';
import { expect, inject, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Executa a CLI com o ambiente dado e devolve código, saída e erro. */
const run = (args: string[], url?: string): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
  execFile(process.execPath, ['--import', 'tsx', 'tests/support/report-cost.ts', ...args], {
    cwd: ROOT, timeout: 60_000, env: { ...process.env, AION_REPORT_DATABASE_URL: url },
  }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
});

it('report:cost lê um banco vazio em modo somente leitura e recusa argumentos e ambiente inválidos com envelope estável', async () => {
  const database = await createTestDatabase(inject('adminDatabaseUrl'));
  const pool = createPool(database.url, { applicationName: 'report-cost-test', max: 1 });
  try {
    await migrateTestDatabase(pool);
    const ok = await run(['--days', '7', '--price', 'glm-5.1=1.4,0.26,4.4'], database.url);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('Chamadas com uso: 0');
    expect(ok.stdout).toContain('Checkpoints vigentes (0): nenhum');

    // As permissões mínimas que docs/operacao.md recomenda para ler a produção bastam para o relatório (nome de papel único: o cluster é compartilhado).
    const role = `relatorio_${Date.now().toString(36)}`;
    const grants = ['GRANT SELECT ON model_call_usage', 'GRANT SELECT (id, routine_id, routine_name) ON runs', 'GRANT SELECT (id, bot_id) ON conversations',
      'GRANT SELECT (run_id, decided_at) ON approvals', 'GRANT SELECT (run_id, kind, data, created_at) ON messages', 'GRANT SELECT (summary) ON conversation_context'];
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'senha-relatorio'`);
    try {
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      for (const grant of grants) await pool.query(`${grant} TO ${role}`);
      const limited = new URL(database.url);
      limited.username = role;
      limited.password = 'senha-relatorio';
      const restricted = await run([], limited.toString());
      expect(restricted.code, restricted.stderr).toBe(0);
    } finally {
      await pool.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER; DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }

    const badDays = await run(['--days', '0'], database.url);
    expect(badDays.code).toBe(1);
    expect(JSON.parse(badDays.stderr)).toEqual({ code: 'COST_REPORT_FAILED', message: expect.stringContaining('--days'), exitCode: 1 });
    expect((await run(['--price', 'modelo=abc'], database.url)).code).toBe(1);

    const missing = await run([]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr).message).toContain('AION_REPORT_DATABASE_URL');

    // Banco inacessível: mensagem genérica, sem a URL (que pode carregar senha).
    const unreachable = 'postgres://usuario:senha-secreta@127.0.0.1:1/inexistente';
    const failed = await run([], unreachable);
    expect(failed.code).toBe(1);
    expect(failed.stderr).not.toContain('senha-secreta');
  } finally {
    await pool.end();
    await database.drop();
  }
});
