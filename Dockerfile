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
RUN npm run build && npm test && PROMPTGEN_FIXTURE_SCALE=1 node dist/scripts/generate-fixtures.js

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/fixtures/private ./fixtures/private
COPY --from=build /app/fixtures/gold ./fixtures/gold
COPY config ./config
COPY eval ./eval
COPY infra ./infra
RUN mkdir -p /app/data /app/runs && chown -R node:node /app
USER node
CMD ["node", "dist/src/cli.js", "serve", "--fixtures"]
