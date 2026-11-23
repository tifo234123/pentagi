FROM node:24-alpine

WORKDIR /app

# Keep application source owned by root:root (read-only to the runtime node user).
COPY package.json ./
COPY src ./src

# Dedicated empty working directory for spawned CLI subprocesses.
RUN mkdir -p /work && chown node:node /work

USER node

ENV CLI_BRIDGE_HOST=0.0.0.0 \
    CLI_BRIDGE_PORT=8090 \
    CLI_BRIDGE_WORK_DIR=/work

EXPOSE 8090

HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD wget -qO /dev/null "http://127.0.0.1:${CLI_BRIDGE_PORT:-8090}/healthz" || exit 1

CMD ["node", "src/index.mjs"]
