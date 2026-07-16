# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.4.0-bookworm-slim@sha256:1b044a60874f1b57ac8c4e708ddb3a00e55b34586ebbacce09a48796dafcc799
ARG NGINX_IMAGE=nginx:1.29.0-alpine@sha256:d67ea0d64d518b1bb04acde3b00f722ac3e9764b3209a9b0a98924ba35e4b779

FROM ${NODE_IMAGE} AS toolchain

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/agent-mcp/package.json apps/agent-mcp/package.json
COPY apps/ctrip-bridge/package.json apps/ctrip-bridge/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/authz/package.json packages/authz/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/visibility/package.json packages/visibility/package.json
COPY tests/e2e/package.json tests/e2e/package.json

RUN --mount=type=cache,id=geo-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

FROM toolchain AS builder

COPY apps ./apps
COPY packages ./packages

RUN pnpm -r \
    --filter '@geo/api...' \
    --filter '@geo/worker...' \
    --filter '@geo/agent-mcp...' \
    --filter '@geo/ctrip-bridge...' \
    --filter '@geo/web...' \
    run build

RUN pnpm --offline --filter @geo/api deploy --prod --legacy /deploy/api && \
    pnpm --offline --filter @geo/worker deploy --prod --legacy /deploy/worker && \
    pnpm --offline --filter @geo/agent-mcp deploy --prod --legacy /deploy/agent-mcp && \
    pnpm --offline --filter @geo/ctrip-bridge deploy --prod --legacy /deploy/ctrip-bridge && \
    pnpm --offline --filter @geo/db deploy --prod --legacy /deploy/db-tools

FROM ${NODE_IMAGE} AS runtime-base

ENV NODE_ENV=production
WORKDIR /app

FROM runtime-base AS api

COPY --from=builder --chown=node:node /deploy/api ./
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4100/health/ready').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.js"]

FROM runtime-base AS worker

COPY --from=builder --chown=node:node /deploy/worker ./
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "--input-type=module", "-e", "import { createDatabase } from '@geo/db'; import { sql } from 'kysely'; const urls = [process.env.DISPATCHER_DATABASE_URL, process.env.RUNTIME_DATABASE_URL]; if (urls.some((url) => !url)) process.exit(1); const databases = urls.map((connectionString) => createDatabase({ connectionString, applicationName: 'geo-worker-health', maxConnections: 1 })); try { await Promise.all(databases.map((database) => sql.raw('select 1').execute(database))); } finally { await Promise.all(databases.map((database) => database.destroy())); }"]
CMD ["node", "dist/cli.js"]

FROM runtime-base AS agent-mcp

COPY --from=builder --chown=node:node /deploy/agent-mcp ./
USER node
EXPOSE 9021
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9021/health/live').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/cli.js"]

FROM runtime-base AS ctrip-bridge

COPY --from=builder --chown=node:node /deploy/ctrip-bridge ./
USER node
EXPOSE 9030
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9030/health/live').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/cli.js"]

FROM runtime-base AS db-tools

COPY --from=builder --chown=node:node /deploy/db-tools ./
USER node
CMD ["node", "dist/cli/migrate.js"]

FROM ${NGINX_IMAGE} AS web

COPY docs/ops/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
