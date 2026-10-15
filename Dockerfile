# Base images are pinned by digest so a build is reproducible and a tag can't be silently repointed.
# Dependabot (see .github/dependabot.yml) proposes updates. Refresh by hand with:
#   docker pull node:24-alpine && docker image inspect node:24-alpine --format '{{index .RepoDigests 0}}'

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# The full test suite on Linux, including the POSIX-signal test that can't run on Windows.
# Not part of the default build: `docker compose run --rm tests`.
FROM build AS test
COPY vitest.config.ts biome.json gateway.config.json ./
COPY test ./test
CMD ["npx", "vitest", "run"]

# The demo upstream is a separate, minimal image so that nothing demo-related ships in the gateway image.
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS demo-upstream
ENV NODE_ENV=production
WORKDIR /app
COPY demo/flaky-upstream.mjs ./demo/flaky-upstream.mjs
USER node
EXPOSE 9001
CMD ["node", "demo/flaky-upstream.mjs"]

# The gateway. Last stage, so a plain `docker build .` produces this one.
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY gateway.config.json ./
USER node
EXPOSE 8080
# Probes the admin listener's open liveness endpoint (loopback inside the container).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:9090/_gateway/live >/dev/null || exit 1
CMD ["node", "dist/index.js", "gateway.config.json"]
