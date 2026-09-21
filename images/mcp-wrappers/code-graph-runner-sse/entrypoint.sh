#!/bin/sh
# Epic #298 / Issue #307 — code-graph-runner-sse entrypoint.
#
# Bridges the Node MCP server's stdio transport to HTTP+SSE on :8080 via the
# `mcp-proxy` adapter (consistent with the pattern used by uvx-runner-sse,
# node-runner-sse, etc. — see PR #295).
#
# Required env: DATABASE_URL — Postgres connection injected as a K8s Secret.
# Optional env: PORT (default 8080), MCP_LOG_LEVEL (default 'info').
#
# This script intentionally avoids `set -e` because mcp-proxy's healthz path
# returns non-zero during startup; `set -u` is enabled to catch unset vars.
set -u

case "${1:-}" in
  -h|--help)
    exec mcp-proxy --help
    ;;
esac

if [ -z "${DATABASE_URL:-}" ]; then
  echo "code-graph-runner-sse: DATABASE_URL is required" >&2
  exit 64
fi

PORT="${PORT:-8080}"
exec mcp-proxy \
  --port "${PORT}" \
  node /srv/dist/server.js
