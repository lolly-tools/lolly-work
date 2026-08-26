# lolly-work server — no build step; Node 24 runs the TS directly. Deps are
# runtime-only (pg, jsdom, @resvg/resvg-js + the vendored file: packages), so a
# single stage with `npm ci --omit=dev` IS the whole build.
# Base pinned by digest (multi-arch index: linux/amd64 + linux/arm64) so the
# signed+attested release image is reproducible and the tag can't shift under a
# rebuild. Dependabot's docker updater (/.github/dependabot.yml, dir
# /deploy/compose) keeps the pin moving as node:24-alpine is rebuilt.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
WORKDIR /app

# vendor/ must land BEFORE npm ci: package.json's @lolly/engine and
# @lolly-tools/core are file: deps pointing there, and npm ci both reads them
# at install and leaves node_modules symlinks into /app/vendor — so vendor/
# stays in the final image, it is not a build-time scratch dir.
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY server ./server
# console/ — server/src/api/app.ts serves the admin console from
# `new URL('../../../console/', import.meta.url)` → /app/console.
COPY console ./console
# docs/ — the operator documentation the console's Docs view renders, read from
# `new URL('../../../docs/', import.meta.url)` → /app/docs (GET /api/v1/docs).
# Markdown + docs.json only; without it that view degrades to a 404.
COPY docs ./docs
# migrations/ — the runner defaults to ./migrations (cwd = /app): boot-time
# auto-migrate in server/src/main.ts and the explicit runner both read it.
COPY migrations ./migrations
# scripts/ — `npm run migrate` → scripts/migrate.ts; the Helm chart's migrate
# Job invokes it (HA path, LW_AUTO_MIGRATE=false).
COPY scripts ./scripts
# Mount point for the instance's tool pack (instance.json `pack`, default
# ./packs/demo). compose/Helm bind it read-only; empty here by design —
# EXCEPT the demo pack (252 KB), always aboard so an evaluation install with no
# pack mounted can point `instance.pack` at /app/packs/demo and boot straight
# into real tools instead of a degraded empty catalog (deploy/helm/
# values-eval.yaml does exactly this). A mounted real pack is unaffected.
RUN mkdir -p packs
COPY packs/demo ./packs/demo

# Dry-run verification (docker unavailable in the authoring env): every runtime
# import the server can hit, and where it resolves in this image —
#   static server/** imports          → COPY server        (/app/server)
#   lazy import('pg')                 → npm ci             (store/postgres.ts:50, store/migrate.ts:35,49)
#   lazy import('jsdom')              → npm ci             (render/contract.ts JSDOM_SPECIFIER)
#   lazy import('@resvg/resvg-js')    → npm ci             (render/pipeline.ts; platform binary is an
#                                                           optionalDependency npm resolves for linux-musl)
#   lazy import('@lolly/engine')      → node_modules symlink → COPY vendor (render/contract.ts ENGINE_SPECIFIER)
#   '@lolly-tools/core'               → node_modules symlink → COPY vendor
#   console static files              → COPY console       (api/app.ts consoleDir)
#   docs/*.md + docs.json             → COPY docs          (api/app.ts docsDir)
#   migrations/*.sql                  → COPY migrations    (cwd-relative './migrations')
#   npm run migrate                   → COPY scripts + package.json
#   import('playwright-core')         → workers/render only; NOT this image (render-worker tier)
#   instance.json / packs/            → mounted at deploy time (LW_CONFIG, instance pack)

ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "server/src/main.ts"]
