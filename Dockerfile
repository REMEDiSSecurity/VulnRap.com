# syntax=docker/dockerfile:1.7
#
# Production Dockerfile for VulnRap (self-hosting).
#
# Builds a single image that serves both the api-server and the prerendered
# SPA's static assets. Optimised for self-hosters running on a tiny VPS:
# multi-stage, slim Node base, non-root user, healthcheck against
# /api/healthz, respects $PORT (default 8080).
#
# This image is intentionally NOT what Replit Deploy uses — Replit Deploy
# keeps its current path (see `.replit`'s `[deployment]` block). This file
# exists so anyone with `docker compose up` can run the full stack.
#
# Build:
#   docker build -t vulnrap:local .
# Run (standalone, requires external Postgres):
#   docker run --rm -p 8080:8080 \
#     -e DATABASE_URL=postgresql://user:pass@host:5432/db \
#     vulnrap:local
# Or use the bundled docker-compose.yml:
#   docker compose up

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
# deps stage — install the workspace's dependencies once. Copies only the
# package manifests + lockfile so this layer caches cleanly across source-
# only edits.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1

# corepack ships with Node 24; enabling it lets pnpm be resolved from the
# repo's expectations without a global `npm install -g pnpm`.
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /workspace

# Copy workspace manifests first so an unrelated source edit doesn't bust
# the install cache. Each `package.json` is copied into its real path so
# pnpm sees the workspace layout.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json tsconfig.base.json tsconfig.json ./
COPY scripts/package.json ./scripts/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/vulnrap/package.json ./artifacts/vulnrap/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/avri-rubric/package.json ./lib/avri-rubric/
COPY lib/db/package.json ./lib/db/
COPY lib/mcp-server/package.json ./lib/mcp-server/

# `--ignore-scripts` skips the root `postinstall` (codegen + tsc --build);
# we run those explicitly in the build stage once the source is present.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# build stage — bring in the source, run codegen + typecheck-libs, build
# the SPA (without the playwright-driven prerender, which would balloon the
# image), build the api-server bundle, then export a self-contained prod
# deployment for the api-server via `pnpm deploy --prod`.
# ---------------------------------------------------------------------------
FROM deps AS build

WORKDIR /workspace
COPY . .

ENV NODE_ENV=production

# Generate the OpenAPI client + zod schemas the rest of the build depends on.
RUN pnpm --filter @workspace/api-spec run codegen

# Build composite TS project references (lib/*).
RUN pnpm run typecheck:libs

# Build the SPA. We deliberately use `build:no-prerender` so the runtime
# image does not need to ship a chromium binary; SSR-style prerendering
# is a Replit-hosted optimisation and not required for self-hosters. The
# SPA is fully functional client-side without it.
RUN pnpm --filter @workspace/vulnrap run build:no-prerender

# Build the api-server (esbuild bundle → artifacts/api-server/dist/index.mjs
# plus the openapi.yaml the spec router serves).
RUN pnpm --filter @workspace/api-server run build

# Export a self-contained prod deployment of just the api-server, with a
# flat node_modules containing only its real (non-bundled, externalised)
# dependencies. This is what we ship in the runtime layer.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @workspace/api-server deploy --prod /deploy

# ---------------------------------------------------------------------------
# runtime stage — slim, non-root, no pnpm/build tools. Layout mirrors the
# repo's `artifacts/<name>/dist` paths so app.ts's relative resolution of
# the SPA static directory still works without code changes.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

# Non-root runtime user. /app is owned by it so volumes / writes stay
# within a non-privileged identity.
RUN groupadd --system --gid 10001 vulnrap \
 && useradd  --system --uid 10001 --gid vulnrap \
             --home-dir /app --shell /usr/sbin/nologin vulnrap \
 && mkdir -p /app/artifacts/api-server /app/artifacts/vulnrap/dist/public \
 && chown -R vulnrap:vulnrap /app

# api-server: built bundle + sibling openapi.yaml.
COPY --from=build --chown=vulnrap:vulnrap \
     /workspace/artifacts/api-server/dist \
     /app/artifacts/api-server/dist

# api-server: production node_modules + package.json from `pnpm deploy`.
# Node's resolution from /app/artifacts/api-server/dist/index.mjs walks
# up to /app/artifacts/api-server/node_modules, so externalised deps
# (pino, @resvg/resvg-js, etc.) are found at runtime.
COPY --from=build --chown=vulnrap:vulnrap \
     /deploy/node_modules \
     /app/artifacts/api-server/node_modules
COPY --from=build --chown=vulnrap:vulnrap \
     /deploy/package.json \
     /app/artifacts/api-server/package.json

# Static JSON data files (presets, gallery, incidents, roadmap, showcase,
# blog-posts, handwavy-phrases, ai-self-disclosure-phrases, cwe-hierarchy,
# avri-drift-notifications, score-stability-alerts, …). Several route
# modules (`routes/presets.ts`, `routes/gallery.ts`, `routes/incidents.ts`,
# `routes/roadmap.ts`, `routes/showcase.ts`, `routes/blog.ts`, …) load
# these eagerly at import time via
# `path.resolve(process.cwd(), "artifacts/api-server/data/<name>.json")`,
# so omitting them would crash the api-server during boot. The CMD below
# runs with WORKDIR=/app, so the cwd-relative lookup resolves cleanly to
# /app/artifacts/api-server/data/.
COPY --from=build --chown=vulnrap:vulnrap \
     /workspace/artifacts/api-server/data \
     /app/artifacts/api-server/data

# SPA static assets — app.ts resolves
# `__dirname/../../vulnrap/dist/public` from the api-server's dist/, which
# under this layout is /app/artifacts/vulnrap/dist/public.
COPY --from=build --chown=vulnrap:vulnrap \
     /workspace/artifacts/vulnrap/dist/public \
     /app/artifacts/vulnrap/dist/public

USER vulnrap

EXPOSE 8080

# Container-side healthcheck — hits the same /api/healthz the SPA / load
# balancer uses. `node -e` keeps us from depending on curl / wget being
# present in the slim base.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
