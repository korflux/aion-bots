// Playwright só para gerar as imagens e o GIF do README (`pnpm --filter @aion/web media:readme`), fora do E2E e do gate.
// Sobe a mesma pilha de produção do E2E (tests/support/e2e-stack.ts: API, worker, Next standalone e proxy, com provedor, Composio e
// FCM falsos), semeia dados de demonstração pela API e grava em `docs/media/`. Não prova nada: é um gerador de material visual.
import { defineConfig, devices } from '@playwright/test';
import { E2E_ORIGIN } from '../../tests/support/e2e-env';

export default defineConfig({
  testDir: './e2e/media',
  testMatch: /\.media\.ts$/,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: E2E_ORIGIN, colorScheme: 'dark', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' },
  webServer: {
    command: 'pnpm exec tsx ../../tests/support/e2e-stack.ts',
    url: `${E2E_ORIGIN}/login`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
