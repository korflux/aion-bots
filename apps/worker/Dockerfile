# syntax=docker/dockerfile:1
# Serviço `worker` do Aion. Contexto de build = RAIZ do repositório: docker build -f apps/worker/Dockerfile .
# Mesma estratégia da api: bundle principal e leitor isolado em estágio de build; imagem final só com Node + dist, sem privilégios.
# O worker não expõe porta nem HTTP; o Easypanel acompanha o processo e o log "worker conectado à fila".

FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /repo

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
COPY apps/worker/ ./apps/worker/
RUN pnpm --filter @aion/worker build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/worker/dist ./dist
USER node

CMD ["node", "dist/main.js"]
