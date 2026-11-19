// Vitest na raiz: cada pacote é um "project" (test.projects). `pnpm test <padrões>` filtra arquivos por caminho
// em todos os projects. O projeto `smoke` sobe api e worker reais e fica fora dos pacotes porque cruza serviços.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const globalSetupPostgres = fileURLToPath(new URL('./packages/core/src/testing/global-setup.ts', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      'packages/shared',
      'packages/core',
      'apps/api',
      'apps/worker',
      'apps/web',
      {
        test: {
          name: 'smoke',
          include: ['tests/**/*.test.ts'],
          globalSetup: [globalSetupPostgres],
          // Build dos bundles e subida de processos reais: mais lento que teste unitário.
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
