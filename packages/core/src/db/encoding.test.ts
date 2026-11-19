// Prova da checagem de codificação do banco (E8): UTF8 passa, e um banco SQL_ASCII (ou qualquer outra) é recusado na subida com uma
// mensagem que diz o que fazer. Usa bancos reais criados no cluster de teste; SQL_ASCII com locale C existe em qualquer plataforma.
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { assertUtf8Database, createPool, type Pool } from './pool';

const databases: TestDatabase[] = [];
const pools: Pool[] = [];
const droppers: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await Promise.all(databases.map((database) => database.drop()));
  for (const drop of droppers) await drop();
});

describe('codificação do banco', () => {
  it('um banco UTF8 passa', async () => {
    const database = await createTestDatabase(inject('adminDatabaseUrl'));
    databases.push(database);
    const pool = createPool(database.url, { applicationName: 'encoding-test', max: 1 });
    pools.push(pool);
    await expect(assertUtf8Database(pool)).resolves.toBeUndefined();
  });

  it('um banco SQL_ASCII é recusado com a codificação encontrada e o que fazer', async () => {
    const adminUrl = inject('adminDatabaseUrl');
    const name = `aion_enc_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C'`);
    } finally {
      await admin.end();
    }
    droppers.push(async () => {
      const cleaner = new pg.Client({ connectionString: adminUrl });
      await cleaner.connect();
      try {
        await cleaner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleaner.end();
      }
    });
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const pool = createPool(url.toString(), { applicationName: 'encoding-test', max: 1 });
    pools.push(pool);

    await expect(assertUtf8Database(pool)).rejects.toThrow(/SQL_ASCII.*exige UTF8/);
  });
});
