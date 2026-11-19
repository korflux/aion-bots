// Build do sandbox: dois arquivos ESM independentes. `server.js` (borda HTTP e pool, processo sem restrição) e `runner.js` (processo
// filho isolado), que o Dockerfile coloca em pastas diferentes: o filho só lê a pasta do runtime. O `pyodide` fica de fora do bundle
// porque localiza os próprios arquivos (wasm, biblioteca padrão) pela pasta do pacote instalado.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/runner.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  sourcemap: false,
  // Sem chunk compartilhado: cada arquivo vai para uma pasta diferente da imagem.
  splitting: false,
  external: ['pyodide'],
});
