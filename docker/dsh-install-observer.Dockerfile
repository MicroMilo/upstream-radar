# syntax=docker/dockerfile:1

ARG NODE_MAJOR=22
FROM node:${NODE_MAJOR}-bookworm-slim AS build

RUN corepack enable \
  && corepack prepare pnpm@11.3.0 --activate

WORKDIR /build
COPY package.json pnpm-lock.yaml tsconfig.json .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY src ./src
COPY test ./test
RUN pnpm run build

FROM node:${NODE_MAJOR}-bookworm-slim AS runtime

# DSH rc.7 and rc.8 declare pnpm@11.7.0 in the official source tree.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git strace python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --ignore-scripts pnpm@11.7.0 \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin observer

WORKDIR /radar
COPY --from=build /build/dist/src ./dist/src
COPY package.json ./package.json

USER observer
ENTRYPOINT ["node", "/radar/dist/src/cli.js", "probe", "dsh-install"]
