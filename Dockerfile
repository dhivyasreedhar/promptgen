FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY config ./config
COPY fixtures/benchmark ./fixtures/benchmark
RUN npm run build && npm test

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config ./config
COPY eval ./eval
COPY infra ./infra
RUN mkdir -p /app/data /app/runs /app/fixtures/private && chown -R node:node /app
USER node
CMD ["sh", "-c", "PROMPTGEN_FIXTURE_SCALE=${PROMPTGEN_FIXTURE_SCALE:-1} node dist/scripts/generate-fixtures.js && node dist/src/cli.js serve --fixtures"]
