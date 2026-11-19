// Lint do web: regras do Next (core-web-vitals + TypeScript) e as mesmas travas de correção da base do monorepo.
// Não reaproveita ../../eslint.config.mjs porque o eslint-config-next já registra o plugin @typescript-eslint
// (registrar de novo, por outra instância, é erro no ESLint 9).
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  ...nextVitals,
  ...nextTypescript,
  // As duas saídas geradas têm a mesma exclusão; todas as regras continuam valendo para código e testes.
  globalIgnores(['.next/**', '.next-e2e/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**']),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Console só para avisos/erros reais; nada de dados de sessão em log do navegador.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Login, logout e sessão expirada usam carga completa de propósito: o layout autenticado precisa ler o
      // cookie novo (ou ausente) do servidor, e o roteador do Next reaproveitaria estado antigo em cache.
      '@next/next/no-location-assign-relative-destination': 'off',
    },
  },
  {
    // O `use` dos fixtures do Playwright não é o hook do React: a regra de hooks não se aplica ao E2E.
    files: ['e2e/**/*.ts'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
  {
    // Regras que dependem de tipos: promessas soltas em handlers de UI escondem falhas silenciosas.
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
);
