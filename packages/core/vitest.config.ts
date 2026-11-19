// Testes do core: regras de domínio contra PostgreSQL real (embedded-postgres, ver src/testing).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    include: ['src/**/*.test.ts'],
    globalSetup: [fileURLToPath(new URL('./src/testing/global-setup.ts', import.meta.url))],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
