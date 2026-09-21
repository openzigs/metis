# syntax=docker/dockerfile:1.7
# Epic #271 — node wrapper for self-contained Node MCP servers.
#
# Used by registering an MCP with:
#   runtime: 'docker-stdio'
#   command: 'ghcr.io/metis-mcps/node-runner:1.0'
#   args:    ['/srv/mcp-server.js']  # path inside the image / mount
#
# Prefer `npx-runner` if you want to fetch from npm at start time.
FROM node:22-alpine3.23

RUN npm install -g npm@latest \
 && npm cache clean --force

# Don't run npm install as part of the entrypoint — this image is intentionally
# minimal. Mount or copy your script in and run it through node directly.
USER 1000:1000
WORKDIR /home/node

ENTRYPOINT ["node"]
