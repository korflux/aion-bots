// Configuração do Next.js (serviço `web`).
//
// - `output: 'standalone'`: a imagem Docker leva só o servidor mínimo rastreado (sem node_modules inteiro);
//   `outputFileTracingRoot` na raiz do monorepo inclui o pacote workspace @aion/shared no rastreamento.
// - `transpilePackages`: @aion/shared é TypeScript de workspace, compilado pelo próprio Next.
// - Cabeçalhos de segurança e CSP com nonce NÃO ficam aqui: são aplicados por request em src/proxy.ts.
// - `rewrites` só em desenvolvimento: `next dev` encaminha /api para a API local (mesma origem, como em
//   produção, onde o Easypanel roteia /api direto ao serviço `api`).
// - `redirects`: as rotas antigas de Configurações (11 áreas, antes da phase 5) levam de forma PERMANENTE (308) às 6 áreas novas, para links salvos, avisos e favoritos
//   continuarem valendo. O Next repassa a query string da requisição ao destino (`/configuracoes/conta?a=1` vai a `/configuracoes/conta-e-seguranca?a=1`). Ficam aqui, e não
//   no `proxy.ts`, porque o redirecionamento acontece antes do proxy e não depende de sessão (o login, depois, preserva o destino novo em `next`). Do mesmo modo, as duas listas
//   antigas de tabelas (por bot e em Configurações) levam à área Artefatos (phase 14, A31); as páginas próprias de cada tabela, que têm mais um segmento, não casam e continuam.
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const apiInternalUrl = process.env.AION_API_INTERNAL_URL ?? 'http://localhost:3001';

/** Rota antiga de Configurações → área nova (spec F9, Suposição 23). `/configuracoes/arquivos` não está aqui: continua existindo, fora do menu. */
const SETTINGS_REDIRECTS: Record<string, string> = {
  provedores: 'conexoes',
  conectores: 'conexoes',
  'pesquisa-na-web': 'conexoes',
  python: 'conexoes',
  'chat-geral': 'preferencias',
  'idioma-e-fuso': 'preferencias',
  'regras-globais': 'personalizacao',
  atividades: 'atividade-e-arquivos',
  conta: 'conta-e-seguranca',
};

/** Listas antigas de tabelas → área Artefatos, que passou a listar tabelas e docs (phase 14, A31). Só a lista: `/bots/:id/tabelas/:tableId` e `/configuracoes/tabelas/:tableId` não casam. */
const TABLE_LIST_REDIRECTS: readonly string[] = ['/bots/:id/tabelas', '/configuracoes/tabelas'];

const config: NextConfig = {
  // A pilha E2E usa saída fixa isolada para não apagar/encerrar uma prévia local em .next.
  distDir: process.env.AION_E2E_ISOLATED_BUILD === '1' ? '.next-e2e' : '.next',
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  transpilePackages: ['@aion/shared'],
  poweredByHeader: false,
  // Em `next dev` o /api passa pelo proxy (rewrite) do Next, e a compressão dele põe o SSE da conversa em buffer (os quadros só
  // chegam ao fim). Em produção o Easypanel roteia /api direto à API, sem passar pelo Next, então a compressão das páginas segue ligada.
  compress: process.env.NODE_ENV !== 'development',
  reactStrictMode: true,
  async redirects() {
    return [
      ...Object.entries(SETTINGS_REDIRECTS).map(([from, to]) => ({ source: `/configuracoes/${from}`, destination: `/configuracoes/${to}`, permanent: true })),
      ...TABLE_LIST_REDIRECTS.map((source) => ({ source, destination: '/artefatos', permanent: true })),
    ];
  },
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    return [{ source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` }];
  },
};

export default config;
