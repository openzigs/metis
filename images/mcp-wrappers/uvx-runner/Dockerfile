# syntax=docker/dockerfile:1.7
# Epic #271 — uvx wrapper for Python MCP servers.
#
# Used by registering an MCP with:
#   runtime: 'docker-stdio'
#   command: 'ghcr.io/metis-mcps/uvx-runner:1.0'
#   args:    ['mcp-atlassian']           # the package uvx will run
#   env:     { … vault refs … }
#
# The container entrypoint is `uvx`, so the first arg is the package spec.
FROM python:3.12-alpine3.23 AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_PROGRESS=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install uv (which provides uvx). Pin the install method via the upstream
# installer; the binary lands in /root/.local/bin which we move into PATH.
RUN apk add --no-cache ca-certificates curl \
 && curl -LsSf https://astral.sh/uv/install.sh | sh \
 && mv /root/.local/bin/uv /usr/local/bin/uv \
 && mv /root/.local/bin/uvx /usr/local/bin/uvx \
 && apk del curl \
 && rm -rf /root/.local /tmp/* /var/cache/apk/*

# Drop privileges. The `app` user owns its own home for uv's cache.
RUN adduser -D -u 1000 -s /sbin/nologin app
USER 1000:1000
WORKDIR /home/app

ENTRYPOINT ["uvx"]
