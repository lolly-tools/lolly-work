# syntax=docker/dockerfile:1
# Chromium render worker — isolated browser tier for hooked/HTML-heavy tools.
# Node 24 (runs the .ts directly) + Playwright Chromium and its OS deps.
#
# Build context is THIS directory (workers/render):
#   docker build -t <registry>/lolly-render-worker:0.1.0 workers/render
FROM node:24-bookworm-slim
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
