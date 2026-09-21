# syntax=docker/dockerfile:1.7
# Epic #272 / Sub-issue #286 — uvx wrapper, SSE-exposing variant.
#
# Bridges a Python (uvx) MCP server's stdio transport to HTTP+SSE on :8080
# via the official `mcp-proxy` adapter. This image is self-contained so PR
# validation does not require ghcr.io/metis-mcps/uvx-runner:latest to exist.
FROM node:22-alpine3.23

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_PROGRESS=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apk add --no-cache ca-certificates curl python3 \
 && curl -LsSf https://astral.sh/uv/install.sh | sh \
 && mv /root/.local/bin/uv /usr/local/bin/uv \
 && mv /root/.local/bin/uvx /usr/local/bin/uvx \
 && npm install -g npm@latest \
 && npm install -g --omit=dev --ignore-scripts mcp-proxy@2.10.0 \
 && npm cache clean --force \
 && apk del curl \
 && rm -rf /root/.local /root/.npm /tmp/* /var/cache/apk/*

USER 1000:1000
WORKDIR /home/node
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["mcp-proxy", "--port", "8080"]
