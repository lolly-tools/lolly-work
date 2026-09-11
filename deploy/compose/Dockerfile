# lolly-work server — no build step; Node 24 runs the TS directly. Deps are
# runtime-only (pg, jsdom, @resvg/resvg-js + the vendored workspace packages), so a
# single stage with `pnpm install --frozen-lockfile --prod` IS the whole build.
# Base pinned by digest (multi-arch index: linux/amd64 + linux/arm64) so the
# signed+attested release image is reproducible and the tag can't shift under a
# rebuild. Dependabot's docker updater (/.github/dependabot.yml, dir
# /deploy/compose) keeps the pin moving as node:24-alpine is rebuilt.
FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81
WORKDIR /app

# The pinned Node image predates these Alpine OpenSSL fixes. Keep the reviewed
# package versions explicit until a refreshed base already includes them.
RUN apk add --no-cache libcrypto3=3.5.8-r0 libssl3=3.5.8-r0

# vendor/ must land BEFORE pnpm install --frozen-lockfile: package.json's @lolly/engine and
# @lolly-tools/core are workspace links pointing there, and pnpm install --frozen-lockfile both reads them
# at install and leaves node_modules symlinks into /app/vendor — so vendor/
# stays in the final image, it is not a build-time scratch dir.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Only these two vendored packages are runtime dependencies. The optional full
# Lolly checkout contains unrelated tools, native lockfiles and its own SBOM.
COPY vendor/@lolly ./vendor/@lolly
COPY vendor/@lolly-tools ./vendor/@lolly-tools
RUN npm install --global pnpm@11.26.0
RUN pnpm install --frozen-lockfile --prod
# Runtime and the migration Job use Node/pnpm. Remove the unused npm CLI and
# its separate dependency tree after installing the pinned package manager.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY tsconfig.json ./
COPY sbom.cdx.json THIRD-PARTY-NOTICES.md LICENSE ./
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
# scripts/ — `pnpm run migrate` → scripts/migrate.ts; the Helm chart's migrate
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

# Runtime import map (also exercised by the local container rehearsal):
#   static server/** imports          → COPY server        (/app/server)
#   lazy import('pg')                 → pnpm install --frozen-lockfile             (store/postgres.ts:50, store/migrate.ts:35,49)
#   lazy import('jsdom')              → pnpm install --frozen-lockfile             (render/contract.ts JSDOM_SPECIFIER)
#   lazy import('@resvg/resvg-js')    → pnpm install --frozen-lockfile             (render/pipeline.ts; platform binary is an
#                                                           optionalDependency pnpm resolves for linux-musl)
#   lazy import('@lolly/engine')      → node_modules symlink → COPY vendor (render/contract.ts ENGINE_SPECIFIER)
#   '@lolly-tools/core'               → node_modules symlink → COPY vendor
#   console static files              → COPY console       (api/app.ts consoleDir)
#   docs/*.md + docs.json             → COPY docs          (api/app.ts docsDir)
#   migrations/*.sql                  → COPY migrations    (cwd-relative './migrations')
#   pnpm run migrate                   → COPY scripts + package.json
#   import('playwright-core')         → workers/render only; NOT this image (render-worker tier)
#   instance.json / packs/            → mounted at deploy time (LW_CONFIG, instance pack)

ENV NODE_ENV=production
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8787') + '/healthz', { signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/src/main.ts"]
