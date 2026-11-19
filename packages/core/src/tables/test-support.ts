// Fixture comum das provas de fórmulas/consultas/relações: PostgreSQL descartável e serviços reais.
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { tableCreateSchema, tableWriteSchema, type TableColumnInput, type TableCell, type DataTable, type FormulaNode, type FormulaType } from '@aion/shared';
import { BotService } from '../bots/service';
import { createPool } from '../db/pool';
import { migrateTestDatabase } from '../testing/migrate';
import { createTestDatabase } from '../testing/postgres';
import { TableService } from './service';

export const owner = { kind: 'owner' } as const;
/** Nós de teste usam o contrato público, sem strings de código interpretadas. */
export const literal = (value: string | boolean | null, type: FormulaType = 'number', currency?: string): FormulaNode => ({ kind: 'literal', type, value, ...(currency ? { currency } : {}) });
export const ref = (columnId: string): FormulaNode => ({ kind: 'ref', columnId });
export const call = (op: Extract<FormulaNode, { kind: 'call' }>['op'], ...args: FormulaNode[]): FormulaNode => ({ kind: 'call', op, args });

/** Isola banco e relógio por arquivo de prova; nenhuma credencial externa participa. */
export async function createTablesWorld(now?: () => Date) {
  const database = await createTestDatabase(inject('adminDatabaseUrl'));
  const pool = createPool(database.url, { applicationName: 'tables-t3-test' });
  await migrateTestDatabase(pool);
  const tables = new TableService({ pool, now });
  const bots = new BotService({ pool, models: { validateSelection: async () => undefined } });
  const bot = await bots.create({ name: 'Tabelas T3', color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 50 }, { ip: '203.0.113.20', userAgent: 'tables-t3-test' });
  return {
    pool, tables, bot, bots,
    /** Cria estrutura pelo serviço, com IDs gerados pelo servidor. */
    create: (columns: TableColumnInput[] = []) => tables.create(tableCreateSchema.parse({ name: 'T3', columns, operationId: randomUUID() }), owner, bot.id),
    /** Acrescenta calculadas com referências às colunas existentes e revisão atual. */
    add: (table: DataTable, columns: TableColumnInput[]) => tables.update(table.id, { expectedSchemaVersion: table.schemaVersion, operationId: randomUUID(), columns: [...table.columns, ...columns] }, owner),
    /** Lote pela validação real; tamanho máximo continua sendo cem registros. */
    write: (table: DataTable, values: Record<string, TableCell>[]) => tables.write(table.id, tableWriteSchema.parse({ operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: values.map((values) => ({ values })) }), owner),
    /** Fecha conexões antes de remover o banco descartável. */
    async cleanup() { await pool.end(); await database.drop(); },
  };
}
