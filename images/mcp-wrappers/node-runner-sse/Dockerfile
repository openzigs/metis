# syntax=docker/dockerfile:1.7
# Epic #272 / Sub-issue #286 — node wrapper, SSE-exposing variant.
#
# Self-contained for PR validation; do not depend on a previously-published
# ghcr.io/metis-mcps/node-runner:latest image.
FROM node:22-alpine3.23

RUN npm install -g npm@latest \
 && npm install -g --omit=dev --ignore-scripts mcp-proxy@2.10.0 \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

USER 1000:1000
WORKDIR /home/node
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

ENTRYPOINT ["mcp-proxy", "--port", "8080", "node"]
