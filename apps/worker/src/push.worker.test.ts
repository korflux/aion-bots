// Prova da ligação do push no worker (T10): o processo do worker, com a conta de serviço vinda do AMBIENTE, lê a caixa de saída e envia
// pelo FCM (falso) o aviso de um evento gravado no banco, e remove o dispositivo cujo token o FCM recusa. O vínculo entre o desfecho de
// uma execução e a linha do outbox é provado no core (`push.test.ts`). Usa um banco só dele: um worker SEM a conta de serviço descartaria
// os eventos que este teste grava (o do `worker.test.ts` roda sem FCM). Phase 3 (T3): o push leva o `eventId` e a tag por conversa e
// categoria. O evento gravado é uma conclusão: um `approval_pending` sem aprovação pendente seria descartado pela regra de validade.
import { generateKeyPairSync } from 'node:crypto';
import { createPool, type Pool } from '@aion/core';
import { createTestDatabase, migrateTestDatabase, startFakeUpstreams, type FakeUpstreams, type TestDatabase } from '@aion/core/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startWorker, type WorkerRuntime } from './bootstrap';

const MASTER_KEY = Buffer.alloc(32, 4).toString('base64');

let database: TestDatabase;
let upstreams: FakeUpstreams;
let pool: Pool;
let worker: WorkerRuntime;

beforeAll(async () => {
  database = await createTestDatabase(inject('adminDatabaseUrl'));
  upstreams = await startFakeUpstreams();
  pool = createPool(database.url, { applicationName: 'worker-push-test', max: 2 });
  await migrateTestDatabase(pool);
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  worker = await startWorker(
    {
      NODE_ENV: 'test',
      DATABASE_URL: database.url,
      AION_MASTER_KEY: MASTER_KEY,
      LOG_LEVEL: 'silent',
      AION_FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'aion-test', client_email: 'push@aion-test.iam.gserviceaccount.com', private_key: privateKey }),
      AION_FCM_BASE_URL: upstreams.fcmBaseUrl,
      AION_FCM_TOKEN_URL: upstreams.fcmTokenUrl,
    },
    { pushConfig: { pollMs: 40 } },
  );
});

afterAll(async () => {
  await worker.close();
  await pool.end();
  await upstreams.stop();
  await database.drop();
});

describe('despachante de push no worker', () => {
  it('envia pelo FCM o aviso do evento gravado (nome do bot, tipo, id do evento e tag) e remove o dispositivo cujo token o FCM recusa', async () => {
    const bot = await pool.query<{ id: string }>(
      `INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ('Bot do push', 'bot do push', '#60A5FA', now(), now()) RETURNING id`,
    );
    const botId = bot.rows[0]!.id;
    await pool.query(
      `INSERT INTO push_devices (token, label, created_at, last_seen_at) VALUES ('device-ok', 'Chrome no Windows', now(), now()), ('unregistered-x', 'Chrome no Android', now(), now())`,
    );
    const event = await pool.query<{ id: string }>("INSERT INTO push_events (kind, bot_id, created_at) VALUES ('run_completed', $1, now()) RETURNING id::text AS id", [botId]);
    const eventId = event.rows[0]!.id;

    for (let i = 0; i < 200 && upstreams.fcmMessages.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      upstreams.fcmMessages.map((message) => [message.token, message.data.title, message.data.body, message.data.kind, message.data.eventId, message.data.tag]).sort(),
    ).toEqual([
      ['device-ok', 'Bot do push', 'Execução concluída', 'run_completed', eventId, `aion-activity-${botId}`],
      ['unregistered-x', 'Bot do push', 'Execução concluída', 'run_completed', eventId, `aion-activity-${botId}`],
    ]);

    for (let i = 0; i < 100; i += 1) {
      if ((await pool.query("SELECT 1 FROM push_events WHERE status = 'sent'")).rowCount === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await pool.query<{ token: string }>('SELECT token FROM push_devices')).rows).toEqual([{ token: 'device-ok' }]);
    expect((await pool.query<{ status: string }>('SELECT status FROM push_events')).rows).toEqual([{ status: 'sent' }]);

    // Phase 16: a entrega de cada dispositivo fica gravada, inclusive a do recusado, que já não existe em `push_devices` (sem chave para ele, de propósito).
    const deliveries = await pool.query<{ outcome: string; http_status: number; attempt: number; still_registered: boolean }>(
      `SELECT d.outcome, d.http_status, d.attempt, EXISTS (SELECT 1 FROM push_devices p WHERE p.id = d.device_id) AS still_registered
       FROM push_deliveries d WHERE d.event_id = $1 ORDER BY d.outcome`,
      [eventId],
    );
    expect(deliveries.rows).toEqual([
      { outcome: 'accepted', http_status: 200, attempt: 1, still_registered: true },
      { outcome: 'rejected_token', http_status: 404, attempt: 1, still_registered: false },
    ]);
  });

  it('um worker SEM a conta de serviço avisa na subida, citando só o nome da variável (R19)', async () => {
    const logs: string[] = [];
    const without = await startWorker(
      { NODE_ENV: 'test', DATABASE_URL: database.url, AION_MASTER_KEY: MASTER_KEY },
      { logDestination: { write: (line) => void logs.push(line) } },
    );
    try {
      const warning = logs.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => String(entry.msg).includes('push desativado no worker'));
      expect(warning).toMatchObject({ level: 40, variable: 'AION_FCM_SERVICE_ACCOUNT' });
    } finally {
      await without.close();
    }
  });

  it('um worker com uma conta de serviço inválida SOBE mesmo assim (os bots seguem executando) e registra só o nome da variável, nunca o valor', async () => {
    const logs: string[] = [];
    const invalid = JSON.stringify({ project_id: 'x', client_email: 'a@b.c', private_key: 'valor-secreto-invalido' });
    const degraded = await startWorker(
      { NODE_ENV: 'test', DATABASE_URL: database.url, AION_MASTER_KEY: MASTER_KEY, AION_FCM_SERVICE_ACCOUNT: invalid },
      { logDestination: { write: (line) => void logs.push(line) } },
    );
    try {
      expect(degraded.engine).toBeDefined();
      const warning = logs.find((line) => line.includes('configuração opcional ignorada'));
      expect(warning).toContain('AION_FCM_SERVICE_ACCOUNT');
      expect(logs.join('')).not.toContain('valor-secreto-invalido');
    } finally {
      await degraded.close();
    }
  });
});
