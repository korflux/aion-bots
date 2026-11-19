# syntax=docker/dockerfile:1
# Serviço `sandbox` do Aion (CODE-01): executa Python (Pyodide/WebAssembly) isolado, opcional, só na rede interna do Easypanel.
# Contexto de build = RAIZ do repositório: docker build -f apps/sandbox/Dockerfile .
#
# Estágio de build em Node 24 (o mesmo dos outros serviços, com Corepack/pnpm, ausente da imagem do Node 26): instala pelo lockfile,
# compila e baixa os wheels com sha256 conferido (scripts/fetch-wheels.ts). A imagem final é Node 26 (bloqueio de rede do modelo de
# permissões, inexistente no Node 24) com os arquivos de root e só leitura para o usuário `node`. Nada é baixado em execução.
#
# Layout final:
#   /app/server.js                      borda HTTP e pool (processo sem restrição, sem segredo do Aion)
#   /app/runtime/runner.js              processo filho isolado; `--allow-fs-read` aponta só para /app/runtime
#   /app/runtime/node_modules/{pyodide,ws}
#   /app/runtime/wheels/                wheels conferidos + pyodide-lock.json reduzido

FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN pnpm fetch
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/sandbox/package.json ./apps/sandbox/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY tests/package.json ./tests/package.json
RUN pnpm install --offline --frozen-lockfile --filter @aion/sandbox

# Wheels antes do código: mudar o código do serviço não baixa os pacotes de novo.
COPY apps/sandbox/scripts/fetch-wheels.ts ./apps/sandbox/scripts/fetch-wheels.ts
RUN mkdir -p /out/runtime/node_modules \
  && PYODIDE="$(readlink -f apps/sandbox/node_modules/pyodide)" \
  && cp -rL "$PYODIDE" /out/runtime/node_modules/pyodide \
  && cp -rL "$(dirname "$PYODIDE")/ws" /out/runtime/node_modules/ws \
  && node apps/sandbox/scripts/fetch-wheels.ts /out/runtime/node_modules/pyodide /out/runtime/wheels

COPY tsconfig.base.json ./
COPY apps/sandbox/ ./apps/sandbox/
RUN pnpm --filter @aion/sandbox build \
  && cp apps/sandbox/dist/server.js /out/server.js \
  && cp apps/sandbox/dist/runner.js /out/runtime/runner.js \
  && echo '{"type":"module"}' > /out/package.json \
  && echo '{"type":"module"}' > /out/runtime/package.json

FROM node:26-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Arquivos de root: o usuário `node` só lê; nem um escape do processo filho altera o runtime.
COPY --from=build --chown=root:root /out/ /app/
USER node
EXPOSE 8080

# A conferência usa o próprio /health, que exige o token (variável do serviço no Easypanel).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health',{headers:{authorization:'Bearer '+process.env.AION_SANDBOX_TOKEN}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# --disable-sigusr1: um processo filho comprometido não consegue abrir o depurador do servidor mandando SIGUSR1.
CMD ["node", "--disable-sigusr1", "server.js"]
