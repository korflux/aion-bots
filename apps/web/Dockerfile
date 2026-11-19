# syntax=docker/dockerfile:1
# Serviço `web` do Aion (Next.js). Contexto de build = RAIZ do repositório: docker build -f apps/web/Dockerfile .
#
# O Next gera um servidor mínimo (`output: 'standalone'`) com só os arquivos rastreados. Ele não copia
# `.next/static` nem `public`, então o estágio final os traz explicitamente. Roda sem privilégios.

FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true NEXT_TELEMETRY_DISABLED=1
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
COPY apps/web/ ./apps/web/
# O typecheck inclui os specs e a configuração Playwright; só este módulo externo é importado por eles.
COPY tests/support/e2e-env.ts ./tests/support/e2e-env.ts
RUN --mount=type=cache,id=aion-web-next,target=/repo/apps/web/.next/cache pnpm --filter @aion/web build

FROM node:24-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
WORKDIR /app/apps/web
EXPOSE 3000

# Variáveis lidas em tempo de execução: AION_API_INTERNAL_URL (rede interna do Easypanel) e AION_PUBLIC_ORIGIN.
CMD ["node", "server.js"]
