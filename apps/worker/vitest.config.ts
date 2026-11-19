// Testes do worker: consumo da fila contra PostgreSQL real (embedded-postgres do core).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'worker',
    include: ['src/**/*.test.ts'],
    globalSetup: [fileURLToPath(new URL('../../packages/core/src/testing/global-setup.ts', import.meta.url))],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
