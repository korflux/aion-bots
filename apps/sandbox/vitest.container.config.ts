// Vitest das suítes em container do sandbox (execução, fuga e limites). Só roda por scripts/test-container.ts, que sobe o container e
// passa endereço, token e canário pelo ambiente; fica fora dos projects do vitest.config.ts da raiz (o `pnpm test` padrão não tem Docker).
// Arquivos em série: os testes de concorrência e de saúde contam vagas e não podem disputar o sandbox com outro arquivo.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.container.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
