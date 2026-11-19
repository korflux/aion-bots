// Global setup do Vitest: sobe um PostgreSQL de teste por projeto e o disponibiliza aos testes via `inject`.
import type { TestProject } from 'vitest/node';
import { startTestPostgres } from './postgres';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const postgres = await startTestPostgres();
  project.provide('adminDatabaseUrl', postgres.adminUrl);
  return () => postgres.stop();
}
