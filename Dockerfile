FROM node:25-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.examples.json tsconfig.examples.build.json ./
COPY src ./src
COPY examples ./examples
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:25-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN useradd --create-home --uid 10001 agentic
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

USER agentic
EXPOSE 4318

CMD ["node", "dist/production/cli.js", "serve"]
