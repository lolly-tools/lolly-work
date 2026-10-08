# SPDX-License-Identifier: MPL-2.0
# Build with services/admission as the context; no Work engine/native build.
FROM registry.suse.com/bci/nodejs:24-base@sha256:719aa24270f9d490ac9e78973a2ef8f6328b23eddbfe09613859e07c356d9f65
WORKDIR /app
RUN groupadd --gid 1000 admission && useradd --uid 1000 --gid admission --no-create-home --shell /usr/sbin/nologin admission
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global --prefix /usr/local pnpm@11.26.0 && pnpm install --frozen-lockfile --prod && \
    rpm -e npm24 && zypper --non-interactive clean --all
COPY src ./src
ENV NODE_ENV=production
USER 1000:1000
EXPOSE 8443
CMD ["node", "src/main.mjs"]
