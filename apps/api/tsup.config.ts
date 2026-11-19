// Build de produção da api: um único arquivo ESM com tudo embutido (workspace e dependências de terceiros),
// então a imagem final só precisa do Node e de `dist/main.js`, sem node_modules.
import { defineConfig } from 'tsup';

export default defineConfig({
  // Entrada própria do leitor isolado de documentos.
  entry: { main: 'src/main.ts', 'attachment-extractor': '../../packages/core/src/attachments/worker.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
  // `require` dinâmico de dependências CJS embutidas em bundle ESM precisa de um `require` real.
  banner: {
    js: "import { createRequire as __aionCreateRequire } from 'node:module'; const require = __aionCreateRequire(import.meta.url);",
  },
  // `pg-native` é um require opcional (dentro de try/catch) do driver `pg`; não usamos.
  external: ['pg-native'],
});
