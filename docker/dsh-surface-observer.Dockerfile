# syntax=docker/dockerfile:1

ARG NODE_MAJOR=22
FROM node:${NODE_MAJOR}-bookworm-slim AS build

RUN corepack enable \
  && attempt=1 \
  && until corepack prepare pnpm@11.3.0 --activate; do \
    if [ "$attempt" -ge 3 ]; then exit 1; fi; \
    sleep "$((attempt * 2))"; \
    attempt="$((attempt + 1))"; \
  done

WORKDIR /build
COPY package.json pnpm-lock.yaml tsconfig.json .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY src ./src
COPY test ./test
RUN pnpm run build

FROM node:${NODE_MAJOR}-bookworm-slim AS runtime

# Chromium exercises the browser/client plane. node-pty allocates a real PTY
# for the terminal plane. They are observer-only drivers, not Radar runtime
# dependencies and never enter the published npm package.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates chromium git python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --ignore-scripts pnpm@11.7.0 \
  && mkdir -p /surface-driver \
  && npm install --prefix /surface-driver --no-audit --no-fund playwright-core@1.62.0 node-pty@1.1.0 \
  && npm cache clean --force \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin observer

WORKDIR /radar
COPY --from=build /build/dist/src ./dist/src
COPY package.json ./package.json

ENV UPSTREAM_RADAR_SURFACE_DRIVER_ROOT=/surface-driver
ENV UPSTREAM_RADAR_CHROMIUM_EXECUTABLE=/usr/bin/chromium

ENTRYPOINT ["node", "/radar/dist/src/cli.js", "probe", "dsh-surface"]
