// Testes unitários do web: lógica pura e componentes de apresentação renderizados no servidor (src/**/*.test.{ts,tsx}, ambiente node,
// sem DOM). Os specs do Playwright ficam em e2e/. O alias `@` espelha o `paths` do tsconfig para os componentes que o usam.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { name: 'web', include: ['src/**/*.test.{ts,tsx}'] },
});
