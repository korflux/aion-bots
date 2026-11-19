// Build de produção do worker: ESM com dependências embutidas e leitor isolado dos arquivos gerados pelo Python.
import { defineConfig } from 'tsup';

export default defineConfig({
  // run_python usa o mesmo leitor da API para validar XLSX; a thread precisa existir também na imagem do worker.
  entry: { main: 'src/main.ts', 'attachment-extractor': '../../packages/core/src/attachments/worker.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire as __aionCreateRequire } from 'node:module'; const require = __aionCreateRequire(import.meta.url);",
  },
  external: ['pg-native'],
});
