FROM node:24-bookworm-slim

# This image is a disposable supervisor, not a Radar scanner dependency or a
# target-code worker. Pin the CLI to the validated local protocol version.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates
RUN npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.146.0 \
    && groupadd --gid 10001 radar-agent \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin radar-agent
COPY scripts/dsh-active-case-tool.mjs /agent/case-tool.mjs
RUN chmod 0555 /agent/case-tool.mjs
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["codex"]
