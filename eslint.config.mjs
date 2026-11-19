// Configuração base de lint do monorepo. Cada pacote herda daqui (apps/web acrescenta as regras do Next).
// Foco em correção de servidor: promessas soltas e variáveis mortas quebram silenciosamente em produção.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/next-env.d.ts',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Segredos e credenciais nunca devem ir para console; logs passam pelo pino com redação.
      'no-console': 'error',
    },
  },
  {
    // Regras que dependem de tipos: só código de produção e testes dentro de src/.
    files: ['**/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
);
