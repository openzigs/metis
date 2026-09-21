# syntax=docker/dockerfile:1.7
# Epic #271 — npx wrapper for npm-published MCP servers.
#
# Used by registering an MCP with:
#   runtime: 'docker-stdio'
#   command: 'ghcr.io/metis-mcps/npx-runner:1.0'
#   args:    ['@modelcontextprotocol/server-filesystem', '/data']
#
# `-y` is baked into the entrypoint so first-run downloads don't stall on
# an interactive "ok to proceed?" prompt.
FROM node:22-alpine3.23

RUN npm install -g npm@latest \
 && npm cache clean --force

USER 1000:1000
WORKDIR /home/node

ENTRYPOINT ["npx", "-y"]
