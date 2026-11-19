// Fixture comum das provas dos docs (phase 14, passo 2): PostgreSQL descartável com todas as migrations, o DocService e o BotService reais e o relógio do
// serviço injetável. Só testes importam este arquivo (nada em `src/index.ts` o exporta).
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import type { Bot } from '@aion/shared';
import { BotService } from '../bots/service';
import { createPool } from '../db/pool';
import { migrateTestDatabase } from '../testing/migrate';
import { createTestDatabase } from '../testing/postgres';
import { DocService, type DocActor, type DocServiceOptions } from './service';

export const owner: DocActor = { kind: 'owner' };
/** O ator bot que as ferramentas montam a partir da execução (nunca de argumento do modelo). */
export const botActor = (botId: string): DocActor => ({ kind: 'bot', botId });
/** Origem de requisição fictícia nas auditorias dos testes. */
export const ORIGIN = { ip: '203.0.113.40', userAgent: 'docs-test' };
/** Cada chamada nova recebe uma identidade de operação independente; os testes de replay reutilizam a mesma de propósito. */
export const operation = (): string => randomUUID();

/** Isola banco e relógio por arquivo de prova; nenhuma credencial externa participa. */
export async function createDocsWorld(now?: () => Date) {
  const database = await createTestDatabase(inject('adminDatabaseUrl'));
  const pool = createPool(database.url, { applicationName: 'docs-test', max: 10 });
  await migrateTestDatabase(pool);
  const docs = new DocService({ pool, ...(now ? { now } : {}) });
  const bots = new BotService({ pool, models: { validateSelection: async () => undefined }, deletesPerMinute: 1000 });
  let sequence = 0;
  return {
    pool,
    docs,
    bots,
    /** Outro DocService sobre o mesmo banco (relógio, guarda de execução ou coletor de evidência próprios). */
    service: (options: Omit<DocServiceOptions, 'pool'> = {}): DocService => new DocService({ pool, ...options }),
    /** Bot de verdade, pelo serviço real (cria também a conversa e a memória). */
    bot: (name?: string): Promise<Bot> =>
      bots.create({ name: name ?? `Bot de docs ${(sequence += 1)}`, color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 50 }, ORIGIN),
    /** Cria um doc pelo contrato público: o dono escolhe os bots; o bot nunca informa `botIds` (nasce associado a ele mesmo). */
    create: (input: { title?: string; content?: string; botIds?: string[] } = {}, actor: DocActor = owner) =>
      docs.create({ title: input.title ?? 'Plano', content: input.content ?? '', ...(actor.kind === 'owner' ? { botIds: input.botIds ?? [] } : {}), operationId: operation() }, actor),
    /** Fecha as conexões antes de remover o banco descartável. */
    async cleanup(): Promise<void> {
      await pool.end();
      await database.drop();
    },
  };
}

export type DocsWorld = Awaited<ReturnType<typeof createDocsWorld>>;
