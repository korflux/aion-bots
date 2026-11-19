// Prova da CLI report:push (phase 16, passo 3): processo real contra um banco migrado e semeado com o funil do push (eventos, entregas ao FCM e
// registros do aparelho). Confere as contas por tipo de evento, a listagem por evento, a ausência de qualquer conteúdo (nome de bot, token, rótulo do
// aparelho), que as permissões mínimas de docs/operacao.md bastam e as recusas na borda sem vazar a URL do banco.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool } from '@aion/core';
import { createTestDatabase, migrateTestDatabase } from '@aion/core/testing';
import { expect, inject, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Executa a CLI com o ambiente dado e devolve código, saída e erro. */
const run = (args: string[], url?: string): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
  execFile(process.execPath, ['--import', 'tsx', 'tests/support/report-push.ts', ...args], {
    cwd: ROOT, timeout: 60_000, env: { ...process.env, AION_REPORT_DATABASE_URL: url },
  }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
});

it('report:push conta o funil por tipo, lista cada evento sem conteúdo e recusa argumentos e ambiente inválidos com envelope estável', async () => {
  const database = await createTestDatabase(inject('adminDatabaseUrl'));
  const pool = createPool(database.url, { applicationName: 'report-push-test', max: 1 });
  try {
    await migrateTestDatabase(pool);

    // Banco vazio: o relatório sai com zeros, sem erro.
    const empty = await run(['--days', '7'], database.url);
    expect(empty.code, empty.stderr).toBe(0);
    expect(empty.stdout).toContain('Eventos criados: 0');

    // Semente: nomes, token e rótulo "secretos" provam que nada disso atravessa para a saída.
    const bot = (await pool.query<{ id: string }>("INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ('Bot Segredo', 'bot segredo', '#60A5FA', now(), now()) RETURNING id")).rows[0]!.id;
    await pool.query("INSERT INTO push_devices (token, label, created_at, last_seen_at) VALUES ('tokensecretodofcm', 'Rotulo Secreto do Aparelho', now(), now())");
    const t0 = Date.now() - 3_600_000;
    const at = (seconds: number): string => new Date(t0 + seconds * 1000).toISOString();
    const [d1, d2] = [randomUUID(), randomUUID()];
    const event = async (kind: string, botId: string | null, status: string, created: number, finished: number | null, dropReason: string | null = null): Promise<string> =>
      (await pool.query<{ id: string }>(
        'INSERT INTO push_events (kind, bot_id, status, drop_reason, attempts, created_at, finished_at) VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING id::text AS id',
        [kind, botId, status, dropReason, at(created), finished === null ? null : at(finished)],
      )).rows[0]!.id;
    const delivery = (eventId: string, device: string, attempt: number, http: number | null, outcome: string, second: number) =>
      pool.query('INSERT INTO push_deliveries (event_id, device_id, attempt, http_status, outcome, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [eventId, device, attempt, http, outcome, at(second)]);
    const receipt = (eventId: string, device: string, state: string, reason: string | null, second: number) =>
      pool.query('INSERT INTO push_receipts (event_id, device_id, state, reason, created_at) VALUES ($1, $2, $3, $4, $5)', [eventId, device, state, reason, at(second)]);

    const e1 = await event('run_completed', bot, 'sent', 0, 2);
    await delivery(e1, d1, 1, 200, 'accepted', 2);
    await receipt(e1, d1, 'received', null, 4); await receipt(e1, d1, 'shown', null, 5); await receipt(e1, d1, 'clicked', null, 60);
    const e2 = await event('run_completed', null, 'sent', 100, 101);
    await delivery(e2, d1, 1, 200, 'accepted', 101);
    await receipt(e2, d1, 'received', null, 103); await receipt(e2, d1, 'suppressed', 'owner_looking', 104);
    const e3 = await event('approval_pending', bot, 'sent', 200, 203);
    await delivery(e3, d1, 1, 200, 'accepted', 203); await delivery(e3, d2, 1, 404, 'rejected_token', 203);
    await receipt(e3, d1, 'received', null, 206); await receipt(e3, d1, 'shown', 'check_timeout', 209);
    const e4 = await event('run_failed', bot, 'sent', 300, 301);
    await delivery(e4, d1, 1, 200, 'accepted', 301);
    await event('run_completed', bot, 'dropped', 400, 400, 'presence');
    await event('approval_expired', null, 'dropped', 500, 500, 'no_device');
    const e7 = await event('run_failed', bot, 'pending', 600, null);
    const e8 = await event('approval_pending', bot, 'sent', 700, 705);
    await delivery(e8, d1, 1, 503, 'failed', 702); await delivery(e8, d1, 2, 200, 'accepted', 705);
    // Fora do período de 7 dias: não conta.
    await pool.query("INSERT INTO push_events (kind, bot_id, status, attempts, created_at, finished_at) VALUES ('run_completed', $1, 'sent', 1, now() - interval '10 days', now() - interval '10 days')", [bot]);

    const ok = await run(['--days', '7', '--tz', 'America/Sao_Paulo'], database.url);
    expect(ok.code, ok.stderr).toBe(0);
    const out = ok.stdout;
    expect(out).toContain('Eventos criados: 8');
    // Eventos: criados, descartados, enviados, pendentes, pendentes presos (pendente há mais de 10 minutos).
    expect(out).toContain('| run_completed | 3 | 1 | 2 | 0 | 0 |');
    expect(out).toContain('| run_failed | 2 | 0 | 1 | 1 | 1 |');
    expect(out).toContain('| approval_pending | 2 | 0 | 2 | 0 | 0 |');
    expect(out).toContain('| approval_expired | 1 | 1 | 0 | 0 | 0 |');
    expect(out).toContain('| Total | 8 | 2 | 5 | 1 | 1 |');
    // Descartes por motivo e tipo.
    expect(out).toMatch(/\| presence \| 1 \| 0 \| 0 \| 0 \| 1 \|/);
    expect(out).toMatch(/\| no_device \| 0 \| 0 \| 0 \| 1 \| 1 \|/);
    // Entregas por resultado (aparelho a aparelho) e por HTTP.
    expect(out).toContain('| approval_pending | 4 | 2 | 1 | 1 |');
    expect(out).toContain('| Total | 7 | 5 | 1 | 1 |');
    expect(out).toContain('| 200 | 5 |');
    expect(out).toContain('| 404 | 1 |');
    expect(out).toContain('| 503 | 1 |');
    // Aparelho: aceitos, recebidos, exibidos, dos quais check_timeout, suprimidos por motivo, tocados e aceitos sem recebido.
    expect(out).toContain('| run_completed | 2 | 2 | 1 | 0 | 0 | 1 | 1 | 0 |');
    expect(out).toContain('| run_failed | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |');
    expect(out).toContain('| approval_pending | 2 | 1 | 1 | 1 | 0 | 0 | 0 | 1 |');
    expect(out).toContain('| Total | 5 | 3 | 2 | 1 | 0 | 1 | 1 | 2 |');
    // Latências em segundos: criação até o fim no servidor (enviados) e até o primeiro recebido.
    expect(out).toContain('| run_completed | 2 | 1.5 | 2.0 | 2 | 3.5 | 4.0 |');
    expect(out).toContain('| approval_pending | 2 | 4.0 | 5.0 | 1 | 6.0 | 6.0 |');
    // Listagem por evento: id, tipo, origem (sem nome), estado e destino por aparelho.
    expect(out).toMatch(new RegExp(`\\| ${e1} \\| run_completed \\| bot \\| .* \\| sent \\| 1 \\| ${d1.slice(0, 8)} #1 accepted/200 \\| ${d1.slice(0, 8)}: received .*; shown .*; clicked`));
    expect(out).toMatch(new RegExp(`\\| ${e2} \\| run_completed \\| chat_geral \\|`));
    expect(out).toMatch(new RegExp(`\\| ${e3} \\| approval_pending \\| bot \\|.*shown\\(check_timeout\\)`));
    expect(out).toMatch(new RegExp(`\\| ${e7} \\| run_failed \\| bot \\|.* \\| pending \\|`));
    expect(out).toContain('dropped:presence');
    // Nada de conteúdo: nome do bot, token e rótulo do aparelho nunca saem.
    for (const secret of ['Segredo', 'segredo', 'tokensecretodofcm', 'Rotulo Secreto', bot]) expect(out).not.toContain(secret);

    // O filtro por dias vale: com 30 dias entra o evento de 10 dias atrás, e o relatório não escreveu nada (continuam 9 linhas).
    const wide = await run(['--days', '30'], database.url);
    expect(wide.stdout).toContain('Eventos criados: 9');
    expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM push_events')).rows[0]!.n).toBe(9);

    // As permissões mínimas que docs/operacao.md recomenda para ler a produção bastam para o relatório (nome de papel único: o cluster é compartilhado).
    const role = `relatorio_push_${Date.now().toString(36)}`;
    const grants = ['GRANT SELECT (id, kind, bot_id, status, drop_reason, attempts, created_at, finished_at) ON push_events',
      'GRANT SELECT (event_id, device_id, attempt, http_status, outcome, created_at) ON push_deliveries',
      'GRANT SELECT (event_id, device_id, state, reason, created_at) ON push_receipts'];
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'senha-relatorio'`);
    try {
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      for (const grant of grants) await pool.query(`${grant} TO ${role}`);
      const limited = new URL(database.url);
      limited.username = role;
      limited.password = 'senha-relatorio';
      const restricted = await run(['--days', '7'], limited.toString());
      expect(restricted.code, restricted.stderr).toBe(0);
      expect(restricted.stdout).toContain('Eventos criados: 8');
    } finally {
      await pool.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER; DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }

    const badDays = await run(['--days', '0'], database.url);
    expect(badDays.code).toBe(1);
    expect(JSON.parse(badDays.stderr)).toEqual({ code: 'PUSH_REPORT_FAILED', message: expect.stringContaining('--days'), exitCode: 1 });
    expect((await run(['--tz', 'Lugar/Nenhum'], database.url)).code).toBe(1);
    expect((await run(['--desconhecida'], database.url)).code).toBe(1);

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
