// Prova de que o worker se conecta à fila e a consome: um job `system.ping` enviado por outro cliente do
// pg-boss é concluído pelo worker. Prova também o job diário de retenção da memória (T8: agendado e executado), o das versões dos docs (phase 14, passo 2: idem), o de retenção das sessões do
// chat geral (T12: agendado e executado, apaga só a sessão temporária vencida) e que o worker
// recusa subir sem DATABASE_URL. Prova também o agendador das rotinas (T9): uma rotina vencida no banco vira uma execução na fila do bot, e a limpeza fria (phase 11, T7):
// o laço do worker marca, sozinho, os resultados antigos da conversa que esfriou e não toca a quente.
import { CHAT_RETENTION_CRON, CHAT_RETENTION_QUEUE, DOC_RETENTION_CRON, DOC_RETENTION_QUEUE, MEMORY_RETENTION_CRON, MEMORY_RETENTION_QUEUE, MigrationError, SYSTEM_PING_QUEUE, createBoss, createPool } from '@aion/core';
import { createTestDatabase, migrateTestDatabase, type TestDatabase } from '@aion/core/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startWorker, type WorkerRuntime } from './bootstrap';
import { ATTACHMENT_RETENTION_QUEUE, ATTACHMENT_RETENTION_CRON } from '@aion/core';

const MASTER_KEY = Buffer.alloc(32, 4).toString('base64');

let database: TestDatabase;
let worker: WorkerRuntime;

beforeAll(async () => {
  database = await createTestDatabase(inject('adminDatabaseUrl'));
  // Quem migra o banco é a API; o worker só sobe com o schema pronto.
  const pool = createPool(database.url, { applicationName: 'worker-test-migrate', max: 1 });
  try {
    await migrateTestDatabase(pool);
  } finally {
    await pool.end();
  }
  worker = await startWorker(
    { NODE_ENV: 'test', DATABASE_URL: database.url, AION_MASTER_KEY: MASTER_KEY, LOG_LEVEL: 'silent' },
    { schedulerConfig: { pollMs: 40 }, coldConfig: { pollMs: 40 } },
  );
});

afterAll(async () => {
  await worker.close();
  await database.drop();
});

describe('worker e fila', () => {
  it('agenda e executa retenção real de pendentes, mantendo o limite exato e os vinculados', async () => {
    const pool = createPool(database.url, { applicationName: 'worker-test-attachments', max: 2 });
    const client = createBoss(database.url, 'worker-test-attachments-client');
    try {
      const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations(created_at) VALUES(now()) RETURNING id')).rows[0]!.id;
      await pool.query(`INSERT INTO attachments(conversation_id,kind,name,original_bytes,stored_bytes,extracted_text,created_at)
        SELECT $1,'document','pendente.txt',1,1,'x',now()-interval '25 hours' FROM generate_series(1,250)`, [conversation]);
      const fresh = (await pool.query<{ id: string }>("INSERT INTO attachments(conversation_id,kind,name,original_bytes,stored_bytes,extracted_text) VALUES($1,'document','recente.txt',1,1,'x') RETURNING id", [conversation])).rows[0]!.id;
      await client.start();
      expect(await client.getSchedules(ATTACHMENT_RETENTION_QUEUE)).toMatchObject([{ name: ATTACHMENT_RETENTION_QUEUE, cron: ATTACHMENT_RETENTION_CRON }]);
      const job = await client.send(ATTACHMENT_RETENTION_QUEUE, {});
      let state = 'created';
      for (let i = 0; i < 40 && state !== 'completed'; i++) {
        state = (await client.getJobById(ATTACHMENT_RETENTION_QUEUE, job!))?.state ?? 'ausente';
        if (state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(state).toBe('completed');
      expect((await pool.query('SELECT id FROM attachments WHERE conversation_id=$1', [conversation])).rows).toEqual([{ id: fresh }]);
    } finally { await client.stop({ graceful: false, timeout: 2_000 }); await pool.end(); }
  });
  it('consome jobs da fila de sistema e conclui o ping enviado por outro cliente', async () => {
    const client = createBoss(database.url, 'worker-test-client');
    await client.start();
    try {
      const id = await client.send(SYSTEM_PING_QUEUE, { origem: 'teste' });
      expect(id).toBeTruthy();

      // O polling do pg-boss leva alguns segundos; espera até o worker concluir o job.
      let state = 'created';
      for (let i = 0; i < 40 && state !== 'completed'; i += 1) {
        state = (await client.getJobById(SYSTEM_PING_QUEUE, id!))?.state ?? 'ausente';
        if (state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(state).toBe('completed');
    } finally {
      await client.stop({ graceful: false, timeout: 2_000 });
    }
  });

  it('agenda a retenção diária das versões da memória e executa o job: apaga o que passou de 90 dias além das 50 mais recentes', async () => {
    // Um bot com 55 versões antigas (200 dias) e a memória global intacta: o job tem de apagar 5 e manter as 50 mais recentes.
    const pool = createPool(database.url, { applicationName: 'worker-test-memory', max: 2 });
    const client = createBoss(database.url, 'worker-test-memory-client');
    try {
      const old = new Date(Date.now() - 200 * 86_400_000);
      const bot = await pool.query<{ id: string }>(
        `INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ('Memória', 'memória', '#60A5FA', now(), now()) RETURNING id`,
      );
      const botId = bot.rows[0]!.id;
      await pool.query(
        `INSERT INTO memory_versions (bot_id, version, content, author, added, removed, created_at)
         SELECT $1, n, 'v' || n, 'owner', 1, 0, $2 FROM generate_series(1, 55) AS n`,
        [botId, old],
      );

      await client.start();
      const schedules = await client.getSchedules(MEMORY_RETENTION_QUEUE);
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({ name: MEMORY_RETENTION_QUEUE, cron: MEMORY_RETENTION_CRON });

      const id = await client.send(MEMORY_RETENTION_QUEUE, {});
      let state = 'created';
      for (let i = 0; i < 40 && state !== 'completed'; i += 1) {
        state = (await client.getJobById(MEMORY_RETENTION_QUEUE, id!))?.state ?? 'ausente';
        if (state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(state).toBe('completed');
      const left = await pool.query<{ min: number; total: string }>('SELECT min(version), count(*) AS total FROM memory_versions WHERE bot_id = $1', [botId]);
      expect(left.rows[0]).toMatchObject({ min: 6, total: '50' });
    } finally {
      await client.stop({ graceful: false, timeout: 2_000 });
      await pool.end();
    }
  });

  it('agenda a retenção diária das versões dos docs e executa o job pelo worker real: apaga o que passou de 90 dias além das 50 mais recentes de cada doc e mantém o resto (A16)', async () => {
    const pool = createPool(database.url, { applicationName: 'worker-test-docs', max: 2 });
    const client = createBoss(database.url, 'worker-test-docs-client');
    try {
      const old = new Date(Date.now() - 200 * 86_400_000);
      // Um doc com 55 versões de 200 dias (saem as 5 mais antigas) e outro com 10 versões velhas (nenhuma sai: menos de 50).
      const docs = (
        await pool.query<{ id: string }>("INSERT INTO docs (id, title, version, updated_by) VALUES (gen_random_uuid(), 'Muitas versões', 55, 'owner'), (gen_random_uuid(), 'Poucas versões', 10, 'owner') RETURNING id")
      ).rows.map((row) => row.id);
      const [many, few] = docs as [string, string];
      await pool.query("INSERT INTO doc_versions (doc_id, version, content, author, created_at) SELECT $1, n, 'v' || n, 'owner', $2 FROM generate_series(1, 55) AS n", [many, old]);
      await pool.query("INSERT INTO doc_versions (doc_id, version, content, author, created_at) SELECT $1, n, 'v' || n, 'bot', $2 FROM generate_series(1, 10) AS n", [few, old]);

      await client.start();
      const schedules = await client.getSchedules(DOC_RETENTION_QUEUE);
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({ name: DOC_RETENTION_QUEUE, cron: DOC_RETENTION_CRON });

      const id = await client.send(DOC_RETENTION_QUEUE, {});
      let state = 'created';
      for (let i = 0; i < 40 && state !== 'completed'; i += 1) {
        state = (await client.getJobById(DOC_RETENTION_QUEUE, id!))?.state ?? 'ausente';
        if (state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(state).toBe('completed');
      const left = async (docId: string) => (await pool.query<{ min: number; total: string }>('SELECT min(version), count(*) AS total FROM doc_versions WHERE doc_id = $1', [docId])).rows[0];
      expect(await left(many)).toMatchObject({ min: 6, total: '50' });
      expect(await left(few)).toMatchObject({ min: 1, total: '10' });
    } finally {
      await client.stop({ graceful: false, timeout: 2_000 });
      await pool.end();
    }
  });

  it('agenda a retenção diária das sessões do chat geral e executa o job: apaga a sessão temporária vencida e mantém a salva, a recente e a conversa de bot', async () => {
    const pool = createPool(database.url, { applicationName: 'worker-test-chat', max: 2 });
    const client = createBoss(database.url, 'worker-test-chat-client');
    try {
      const session = async (days: number, saved: boolean): Promise<string> =>
        (await pool.query<{ id: string }>('INSERT INTO conversations (created_at, saved) VALUES (now() - make_interval(days => $1), $2) RETURNING id', [days, saved])).rows[0]!.id;
      const expired = await session(8, false);
      const savedOld = await session(30, true);
      const recent = await session(2, false);
      const bot = await pool.query<{ id: string }>(
        `INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ('Antigo', 'antigo', '#60A5FA', now(), now()) RETURNING id`,
      );
      const botConversation = (
        await pool.query<{ id: string }>("INSERT INTO conversations (bot_id, created_at) VALUES ($1, now() - interval '90 days') RETURNING id", [bot.rows[0]!.id])
      ).rows[0]!.id;

      await client.start();
      const schedules = await client.getSchedules(CHAT_RETENTION_QUEUE);
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({ name: CHAT_RETENTION_QUEUE, cron: CHAT_RETENTION_CRON });

      const id = await client.send(CHAT_RETENTION_QUEUE, {});
      let state = 'created';
      for (let i = 0; i < 40 && state !== 'completed'; i += 1) {
        state = (await client.getJobById(CHAT_RETENTION_QUEUE, id!))?.state ?? 'ausente';
        if (state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(state).toBe('completed');
      const left = (await pool.query<{ id: string }>('SELECT id FROM conversations WHERE id = ANY($1::uuid[])', [[expired, savedOld, recent, botConversation]])).rows.map((row) => row.id);
      expect(left.sort()).toEqual([savedOld, recent, botConversation].sort());
    } finally {
      await client.stop({ graceful: false, timeout: 2_000 });
      await pool.end();
    }
  });

  it('o agendador de rotinas dispara, sozinho, a rotina cujo horário previsto chegou: uma execução na fila do bot e o horário gravado uma vez só', async () => {
    const pool = createPool(database.url, { applicationName: 'worker-test-routines', max: 2 });
    try {
      const bot = await pool.query<{ id: string }>(
        `INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ('Agendado', 'agendado', '#60A5FA', now(), now()) RETURNING id`,
      );
      const botId = bot.rows[0]!.id;
      await pool.query('INSERT INTO conversations (bot_id, created_at) VALUES ($1, now())', [botId]);
      const routine = await pool.query<{ id: string }>(
        `INSERT INTO routines (bot_id, name, instruction, schedule, timezone, anchor_at, next_run_at, created_at, updated_at)
         VALUES ($1, 'Resumo', 'Resuma o dia', '{"type":"daily","times":["07:00"]}', 'America/Sao_Paulo', now(), now() - interval '5 seconds', now(), now()) RETURNING id`,
        [botId],
      );
      const routineId = routine.rows[0]!.id;

      let fired = 0;
      for (let i = 0; i < 100 && fired === 0; i += 1) {
        fired = Number((await pool.query<{ total: string }>('SELECT count(*) AS total FROM runs WHERE routine_id = $1', [routineId])).rows[0]!.total);
        if (fired === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(fired).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 300)); // vários ciclos depois: nenhuma execução duplicada
      const runs = await pool.query<{ routine_name: string; input: string }>('SELECT routine_name, input FROM runs WHERE routine_id = $1', [routineId]);
      expect(runs.rows).toEqual([{ routine_name: 'Resumo', input: 'Resuma o dia' }]);
      const occurrences = await pool.query('SELECT outcome FROM routine_occurrences WHERE routine_id = $1', [routineId]);
      expect(occurrences.rows).toEqual([{ outcome: 'fired' }]);
      const after = await pool.query<{ next_run_at: Date; run_count: number }>('SELECT next_run_at, run_count FROM routines WHERE id = $1', [routineId]);
      expect(after.rows[0]!.run_count).toBe(1);
      expect(after.rows[0]!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await pool.end();
    }
  });

  it('a limpeza fria do worker trata sozinha a conversa que esfriou: marca só o resultado grande fora das 2 rodadas recentes, uma vez, e não toca a conversa quente', async () => {
    const pool = createPool(database.url, { applicationName: 'worker-test-cold', max: 2 });
    try {
      // Um bot com 3 rodadas (cada uma com um resultado de ferramenta grande) e a última chamada ao modelo há `ago` minutos. Só o resultado da rodada 1 é elegível.
      const history = async (name: string, ago: number): Promise<{ conversation: string; result: string }> => {
        const bot = (await pool.query<{ id: string }>("INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ($1, lower($1), '#60A5FA', now(), now()) RETURNING id", [name])).rows[0]!.id;
        const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (bot_id, created_at) VALUES ($1, now()) RETURNING id', [bot])).rows[0]!.id;
        let first = '';
        let run = '';
        for (const round of [1, 2, 3]) {
          run = (await pool.query<{ id: string }>("INSERT INTO runs (conversation_id, bot_id, status, input, created_at, started_at, finished_at) VALUES ($1, $2, 'completed', 'pedido', now(), now(), now()) RETURNING id", [conversation, bot])).rows[0]!.id;
          await pool.query("INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, created_at) VALUES ($1, $2, 'user', 'text', 'done', true, 'pedido', now())", [conversation, run]);
          const result = (await pool.query<{ id: string }>(
            "INSERT INTO messages (conversation_id, run_id, role, kind, status, step, content, data, created_at) VALUES ($1, $2, 'assistant', 'activity', 'completed', 1, $3, $4, now()) RETURNING id",
            [conversation, run, 'r'.repeat(3000), JSON.stringify({ callId: `c${round}`, tool: 'table_query', label: 'x', arguments: '{}', detail: null })])).rows[0]!.id;
          if (round === 1) first = result;
        }
        await pool.query(
          "INSERT INTO model_call_usage (id, conversation_id, run_id, purpose, model, protocol, state, created_at, completed_at) VALUES (gen_random_uuid(), $1, $2, 'main', 'opencode/glm-5.1', 'chat_completions', 'completed', now() - make_interval(mins => $3), now() - make_interval(mins => $3))",
          [conversation, run, ago]);
        return { conversation, result: first };
      };
      const cold = await history('Frio', 120);
      const warm = await history('Quente', 5);
      const masked = async (conversation: string) => (await pool.query<{ message_id: string; masked_at: Date }>('SELECT message_id::text, masked_at FROM context_cold_masks WHERE conversation_id = $1 ORDER BY message_id', [conversation])).rows;

      let rows = await masked(cold.conversation);
      for (let i = 0; i < 100 && rows.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        rows = await masked(cold.conversation);
      }
      expect(rows.map((row) => row.message_id)).toEqual([cold.result]); // só o resultado da rodada 1: as rodadas 2 e 3 são as recentes
      await new Promise((resolve) => setTimeout(resolve, 300)); // vários ciclos depois: nada acrescentado e o instante da marca é o da primeira gravação
      expect(await masked(cold.conversation)).toEqual(rows);
      expect(await masked(warm.conversation)).toEqual([]); // a conversa quente (5 minutos) nunca é tocada
      // O que está gravado não muda: a marca não reescreve o resultado.
      expect((await pool.query<{ total: string }>("SELECT count(*) AS total FROM messages WHERE conversation_id = $1 AND kind = 'activity' AND content = $2", [cold.conversation, 'r'.repeat(3000)])).rows[0]!.total).toBe('3');
    } finally {
      await pool.end();
    }
  });

  it('não sobe sem DATABASE_URL nem chave mestra, citando só o nome das variáveis', async () => {
    await expect(startWorker({ NODE_ENV: 'test' })).rejects.toThrow(/DATABASE_URL ausente/);
    await expect(startWorker({ NODE_ENV: 'test', DATABASE_URL: database.url })).rejects.toThrow(/AION_MASTER_KEY ausente/);
  });

  it('não roda contra um banco que a API ainda não migrou: falha no prazo em vez de ler tabelas que não existem', async () => {
    const empty = await createTestDatabase(inject('adminDatabaseUrl'));
    try {
      await expect(
        startWorker({ NODE_ENV: 'test', DATABASE_URL: empty.url, AION_MASTER_KEY: MASTER_KEY, LOG_LEVEL: 'silent' }, { schemaTimeoutMs: 600 }),
      ).rejects.toBeInstanceOf(MigrationError);
    } finally {
      await empty.drop();
    }
  });
});
