FROM node:24-bookworm-slim
RUN groupadd --gid 10001 radar-agent \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin radar-agent
COPY scripts/dsh-agent-egress-proxy.mjs /proxy/egress.mjs
RUN chmod 0555 /proxy/egress.mjs
USER 10001:10001
ENTRYPOINT ["node", "/proxy/egress.mjs"]
