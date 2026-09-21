#!/usr/bin/env bash
# build-images.sh — build all three METIS Docker images locally with
# the same tags `verify-image-size.sh` expects.
#
# Usage:
#   bash scripts/build-images.sh                    # build core images only
#   bash scripts/build-images.sh --with-wrappers    # also build MCP wrapper set (#271)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

WITH_WRAPPERS=0
for arg in "$@"; do
  case "$arg" in
    --with-wrappers) WITH_WRAPPERS=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "==> Building metis-server:test"
docker build -f Dockerfile.server     -t metis-server:test     .

echo "==> Building metis-ui:test"
docker build -f Dockerfile.ui         -t metis-ui:test         .

echo "==> Building metis-embeddings:test"
docker build -f Dockerfile.embeddings -t metis-embeddings:test .

if [[ "$WITH_WRAPPERS" -eq 1 ]]; then
  echo "==> Building MCP wrapper images (#271)"
  bash images/mcp-wrappers/build.sh
fi

echo "==> Done. Run scripts/verify-image-size.sh --no-build to check the budget."
