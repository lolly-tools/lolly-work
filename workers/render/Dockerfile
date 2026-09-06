# syntax=docker/dockerfile:1
# Chromium render worker — isolated browser tier for hooked/HTML-heavy tools.
# Node 24 (runs the .ts directly) + Playwright Chromium and its OS deps.
#
# Build context is THIS directory (workers/render):
#   docker build -t <registry>/lolly-render-worker:0.1.0 workers/render
# Base pinned by digest (multi-arch index: linux/amd64 + linux/arm64) so the
# signed+attested release image is reproducible and the tag can't shift under a
# rebuild. Dependabot's docker updater (/.github/dependabot.yml, dir
# /workers/render) keeps the pin moving as node:24-bookworm-slim is rebuilt.
FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e
WORKDIR /app

ENV NODE_ENV=production
# Keep the browser inside the image (not a user cache) so the runtime is self-contained.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
# playwright-core only (no @playwright/test); install Chromium + its apt deps.
RUN npm install --omit=dev --no-audit --no-fund \
 && npx --yes playwright-core install --with-deps chromium \
 && npm cache clean --force

COPY src ./src

EXPOSE 8791
# Run unprivileged. The Playwright launch uses --no-sandbox (see server.ts): the
# worker is already isolated at the pod level, and Chromium's own sandbox needs
# privileges we deliberately don't grant. Prefer a gVisor/Kata runtimeClass in
# production (documented in the Helm values) for defence in depth.
USER node
CMD ["node", "src/server.ts"]
