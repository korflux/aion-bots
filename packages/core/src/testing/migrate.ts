// Migração dos bancos de teste: ponto único que aplica TODO o registro de migrations, inclusive as destrutivas.
//
// O padrão do migrator (e do config de produção) é recusar migration `destructive` sem AION_ALLOW_DESTRUCTIVE_MIGRATIONS=true. Um banco de teste é
// descartável e precisa do schema final, então os testes migram por aqui, com a permissão ligada, em vez de repetir `allowDestructive: true` em cada
// chamada. O teste que prova a recusa sem a permissão (migrator.test.ts e security.test.ts) chama `runMigrations` direto, de propósito.
import { runMigrations, type RunMigrationsOptions } from '../db/migrator';
import type { Pool } from '../db/pool';

/** Aplica as migrations pendentes num banco de teste com `allowDestructive: true`; as demais opções (registro, logger) passam como estão. */
export const migrateTestDatabase = (pool: Pool, options: Omit<RunMigrationsOptions, 'allowDestructive'> = {}): Promise<string[]> =>
  runMigrations(pool, { ...options, allowDestructive: true });
