// Testes do shared: funções puras, sem banco.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'shared', include: ['src/**/*.test.ts'] },
});
