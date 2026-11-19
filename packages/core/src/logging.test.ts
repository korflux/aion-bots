// Prova dos handlers reais do banco e da fila com o logger pino real: erros nunca transportam o cliente nem segredos.
import { describe, expect, it, vi } from 'vitest';
import { createPool } from './db/pool';
import { createLogger, databaseErrorForLog } from './logging';
import { createBoss, startWorkerQueue } from './queue';

describe('logs de erro do PostgreSQL e pg-boss', () => {
  it('mantém operação e código do driver sem serializar configuração, mensagem, stack, causa ou cliente', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', name: 'database-log-test', destination: { write: (line) => void lines.push(line) } });
    const secrets = ['SENHA_SENTINELA', 'URL_SENTINELA', 'CANCELAMENTO_SENTINELA', 'SQL_SENTINELA'];
    const client = { connectionParameters: { password: secrets[0], connectionString: secrets[1] }, secretKey: secrets[2] };
    const error = Object.assign(new Error(secrets.join(' ')), { code: '57P01', client, cause: client, query: secrets[3] });
    const pool = createPool('postgresql://localhost/test', { applicationName: 'log-test', logger });
    const boss = createBoss('postgresql://localhost/test', 'log-test');
    // O transporte não é necessário: conservamos o EventEmitter real e substituímos só as operações de inicialização da fila.
    vi.spyOn(boss, 'start').mockResolvedValue(boss);
    vi.spyOn(boss, 'createQueue').mockResolvedValue();
    vi.spyOn(boss, 'work').mockResolvedValue('worker-test');
    try {
      await startWorkerQueue(boss, logger);
      pool.emit('error', error, client);
      boss.emit('error', error);
      const failures = lines.map((line) => JSON.parse(line) as { err?: unknown; msg: string }).filter((line) => line.err);
      expect(failures).toEqual([
        expect.objectContaining({ msg: 'erro em conexão ociosa do pool', err: { type: 'DatabaseError', code: '57P01' } }),
        expect.objectContaining({ msg: 'erro no pg-boss', err: { type: 'DatabaseError', code: '57P01' } }),
      ]);
      for (const secret of secrets) expect(lines.join('\n')).not.toContain(secret);
      expect(lines.join('\n')).not.toMatch(/connectionParameters|connectionString|secretKey|query|stack|cause/);
      expect(databaseErrorForLog(Object.assign(error, { code: 'ECONNRESET' }))).toEqual({ type: 'DatabaseError', code: 'ECONNRESET' });
      expect(databaseErrorForLog({ code: secrets[0] })).toEqual({ type: 'DatabaseError' });
      expect(databaseErrorForLog(null)).toEqual({ type: 'DatabaseError' });
    } finally {
      vi.restoreAllMocks();
      await pool.end();
    }
  });
});
