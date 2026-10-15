FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# The full test suite on Linux, including the POSIX-signal test that can't run on Windows.
# Not part of the default build: `docker compose run --rm tests`.
FROM build AS test
COPY vitest.config.ts ./
COPY test ./test
CMD ["npx", "vitest", "run"]

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY gateway.config.json ./
COPY demo ./demo
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/_gateway/health >/dev/null || exit 1
CMD ["node", "dist/index.js", "gateway.config.json"]
