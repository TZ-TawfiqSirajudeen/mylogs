# syntax=docker/dockerfile:1.7
#
# One multi-target Dockerfile for every deployable:
#   docker build --target api    -t nexus/api    .
#   docker build --target worker -t nexus/worker .
#   docker build --target ingest -t nexus/ingest .
#   docker build --target web    -t nexus/web    .
#   docker build --target mock-idp -t nexus/mock-idp .   # DEVELOPMENT ONLY test identity provider
#
# STATUS: written to build with Docker/BuildKit, but NOT built in the environment this repository was developed in
# (no Docker available there). The exact same install/build/deploy commands were run locally; see docs/STATUS.md.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

# ---------------------------------------------------------------- build: install once, compile everything
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /repo
# Dependency layer first: only the lockfile and manifests, so source edits do not invalidate the install cache.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/ingest/package.json apps/ingest/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/security/package.json packages/security/package.json
COPY packages/secrets/package.json packages/secrets/package.json
COPY packages/connector-sdk/package.json packages/connector-sdk/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/connections/package.json packages/connections/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
COPY packages/logstore/package.json packages/logstore/package.json
COPY packages/tracestore/package.json packages/tracestore/package.json
COPY packages/metricstore/package.json packages/metricstore/package.json
COPY packages/ingest/package.json packages/ingest/package.json
COPY packages/mock-idp/package.json packages/mock-idp/package.json
COPY tests/e2e/package.json tests/e2e/package.json
COPY examples/sample-app/package.json examples/sample-app/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY . .
RUN pnpm --filter @nexus/api build \
 && pnpm --filter @nexus/worker build \
 && pnpm --filter @nexus/ingest-service build \
 && pnpm --filter @nexus/web build
# Production-only dependency trees (the bundles keep third-party packages external).
RUN pnpm --filter @nexus/api deploy --prod --legacy /out/api \
 && pnpm --filter @nexus/worker deploy --prod --legacy /out/worker \
 && pnpm --filter @nexus/ingest-service deploy --prod --legacy /out/ingest

# ---------------------------------------------------------------- shared runtime base
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Unprivileged user (uid 1000 from the base image); the root filesystem can be mounted read-only.
USER node

# ---------------------------------------------------------------- api (port 4000)
FROM runtime AS api
COPY --from=build --chown=node:node /out/api/node_modules ./node_modules
COPY --from=build --chown=node:node /out/api/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
ENV HOST=0.0.0.0 PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]

# ---------------------------------------------------------------- worker (health port 4100)
FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker/node_modules ./node_modules
COPY --from=build --chown=node:node /out/worker/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
ENV WORKER_HEALTH_PORT=4100
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||4100)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------- ingest (OTLP/HTTP, port 4318)
FROM runtime AS ingest
COPY --from=build --chown=node:node /out/ingest/node_modules ./node_modules
COPY --from=build --chown=node:node /out/ingest/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/ingest/dist ./dist
ENV INGEST_HOST=0.0.0.0 INGEST_PORT=4318
EXPOSE 4318
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.INGEST_PORT||4318)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]

# ---------------------------------------------------------------- web: static bundle behind nginx, /api proxied to the API
FROM ${NGINX_IMAGE} AS web
COPY infra/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/nginx-health >/dev/null || exit 1

# ---------------------------------------------------------------- mock identity provider (DEV/TEST ONLY; never deploy)
FROM build AS mock-idp
ENV NODE_ENV=development
WORKDIR /repo/packages/mock-idp
USER node
EXPOSE 9000
CMD ["node", "--import", "tsx", "src/cli.ts"]
