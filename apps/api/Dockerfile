# syntax=docker/dockerfile:1
# Serviço `api` do Aion. Contexto de build = RAIZ do repositório (o monorepo precisa de lockfile e pacotes
# irmãos): docker build -f apps/api/Dockerfile .
#
# Estágio 1 constrói o bundle único (tsup embute workspace e dependências). Estágio 2 leva só o Node e
# `dist/`, sem node_modules, sem código-fonte e sem ferramentas de build, rodando como usuário sem privilégios.

FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /repo

# Camada de dependências: depende só de lockfile e manifestos, então o cache sobrevive a mudanças de código.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN pnpm fetch
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY tests/package.json ./tests/package.json
# Todos os projetos ficam linkados: o typecheck da web também alcança os helpers E2E do core.
RUN pnpm install --offline --frozen-lockfile

# Código compartilhado e só este serviço: editar outro app não invalida esta compilação.
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
RUN pnpm --filter @aion/api build

FROM node:24-slim
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=build /repo/apps/api/dist ./dist
USER node
EXPOSE 3001

# A sonda usa o próprio /api/health (200 = processo no ar e banco respondendo).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/main.js"]
