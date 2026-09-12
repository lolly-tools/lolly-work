# syntax=docker/dockerfile:1
# Chromium render worker — isolated browser tier for hooked/HTML-heavy tools.
# Node 24 (runs the .ts directly) + Alpine Chromium, driven by playwright-core.
#
# Build context is THIS directory (workers/render):
#   docker build -t <registry>/lolly-render-worker:0.1.0 workers/render
# Base pinned by digest (multi-arch index: linux/amd64 + linux/arm64) so the
# signed+attested release image is reproducible and the tag can't shift under a
# rebuild. Dependabot's docker updater (/.github/dependabot.yml, dir
# /workers/render) keeps the base pin moving. Update the browser package pin
# alongside the application and exercise real render/raster requests.
FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81
WORKDIR /app

ENV NODE_ENV=production
# The distro browser supports this musl image; Playwright's downloaded browser
# requires glibc. The server already accepts an explicit browser executable.
ENV LOLLY_BROWSER_PATH=/usr/bin/chromium-browser
# Chromium's crash database and cache also need writable ephemeral storage when
# the pod uses readOnlyRootFilesystem. Its user-data directory already uses /tmp.
ENV XDG_CONFIG_HOME=/tmp/chromium-config
ENV XDG_CACHE_HOME=/tmp/chromium-cache
RUN apk add --no-cache libcrypto3=3.5.8-r0 libssl3=3.5.8-r0 \
    chromium=152.0.7977.82-r0 font-noto=2026.06.01-r0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# playwright-core only (no @playwright/test); Chromium is already in the image.
RUN npm install --global pnpm@11.26.0
RUN pnpm install --frozen-lockfile --prod \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY src ./src

EXPOSE 8791
# Run unprivileged. The Playwright launch uses --no-sandbox (see server.ts): the
# worker is already isolated at the pod level, and Chromium's own sandbox needs
# privileges we deliberately don't grant. Prefer a gVisor/Kata runtimeClass in
# production (documented in the Helm values) for defence in depth.
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8791)+'/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/server.ts"]
