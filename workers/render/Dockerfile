# syntax=docker/dockerfile:1
# Chromium render worker — isolated browser tier for hooked/HTML-heavy tools.
# Node 24 (runs the .ts directly) + the locked Playwright Chromium distribution.
#
# Build context is THIS directory (workers/render):
#   docker build -t <registry>/lolly-render-worker:0.1.0 workers/render
# Base pinned by digest (multi-arch index: linux/amd64 + linux/arm64) so the
# signed+attested release image is reproducible and the tag can't shift under a
# rebuild. Dependabot's docker updater (/.github/dependabot.yml, dir
# /workers/render) keeps the base pin moving. The worker lock pins the browser
# revision; exercise real render/raster requests when either dependency changes.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app

ENV NODE_ENV=production
# The glibc browser distribution includes the software WebGPU implementation.
# Do not override its executable with the former Alpine wrapper.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/lolly-browsers
# Chromium's crash database and cache also need writable ephemeral storage when
# the pod uses readOnlyRootFilesystem. Its user-data directory already uses /tmp.
ENV XDG_CONFIG_HOME=/tmp/chromium-config
ENV XDG_CACHE_HOME=/tmp/chromium-cache
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-noto-core fonts-noto-color-emoji ghostscript inkscape util-linux \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# playwright-core only (no @playwright/test); install its matching browser.
RUN npm install --global pnpm@11.26.0
RUN pnpm install --frozen-lockfile --prod \
 && pnpm exec playwright-core install --with-deps chromium \
 && chmod -R a+rX /opt/lolly-browsers \
 && rm -rf /var/lib/apt/lists/* \
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
