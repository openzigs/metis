#!/usr/bin/env bash
# verify-image-size.sh
#
# Builds the metis-server and metis-ui Docker images and asserts metis-ui
# stays under MAX_IMAGE_MB and metis-server under MAX_SERVER_IMAGE_MB.
#
# Default budgets: 350 MB (ui), 900 MB (server — measured on amd64 in #34;
# the 350 MB below is unreachable for the server, see docs/OPERATIONS.md).
#
# Issue #93 originally targeted ≤250 MB, but the architectural floor with
# the user's hard constraints (keep `lancedb`, keep `pdf-parse`) is higher
# than that — `@lancedb/vectordb-linux-arm64-gnu` alone is an 87 MB native
# binary and `@napi-rs/canvas` (required by pdf-parse@2) adds another 24 MB
# of native code. Combined with the alpine base (~75 MB) and the minimum
# Prisma + Express + RAG runtime, the practical minimum lands around
# 320 MB. See docs/OPERATIONS.md > "Container Image Sizes" for the full
# accounting and the proposed follow-up work to close the remaining gap
# (sidecaring lancedb, replacing pdf-parse@2 with v1, etc.).
#
# Usage:
#   scripts/verify-image-size.sh                # build + verify with defaults
#   scripts/verify-image-size.sh --no-build     # verify already-tagged images
#
# Environment variables:
#   MAX_IMAGE_MB         Limit for metis-ui in megabytes (default 350)
#   MAX_SERVER_IMAGE_MB  Limit for metis-server in megabytes (default 900)
#   SERVER_TAG    Image ref to inspect for the server (default metis-server:test)
#   UI_TAG        Image ref to inspect for the UI     (default metis-ui:test)
#
# Exit codes:
#   0  both images present and within their budgets
#   1  an image exceeds the limit OR is missing
#   2  invalid invocation / docker not available

set -euo pipefail

MAX_IMAGE_MB=${MAX_IMAGE_MB:-350}
MAX_SERVER_IMAGE_MB=${MAX_SERVER_IMAGE_MB:-900}
SERVER_TAG=${SERVER_TAG:-metis-server:test}
UI_TAG=${UI_TAG:-metis-ui:test}
# Issue #145 — the embeddings sidecar is intentionally exempt from the
# image-size budget. We still measure and report it for visibility.
EMBEDDINGS_TAG=${EMBEDDINGS_TAG:-metis-embeddings:test}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERR: docker is not installed or not in PATH" >&2
  exit 2
fi

if [[ "${1:-}" != "--no-build" ]]; then
  echo "==> Building $SERVER_TAG"
  docker build -f Dockerfile.server     -t "$SERVER_TAG"     .
  echo "==> Building $UI_TAG"
  docker build -f Dockerfile.ui         -t "$UI_TAG"         .
  echo "==> Building $EMBEDDINGS_TAG (sidecar — exempt from budget)"
  docker build -f Dockerfile.embeddings -t "$EMBEDDINGS_TAG" .
fi

# Image size in bytes via docker inspect. We grab the first line only and
# strip any whitespace; multi-platform manifests can otherwise emit a
# newline-separated list that awk chokes on.
size_mb() {
  local tag=$1
  local bytes
  bytes=$(docker image inspect "$tag" --format '{{.Size}}' 2>/dev/null \
            | head -n 1 \
            | tr -d '[:space:]' \
            || true)
  if [[ -z "${bytes}" || "${bytes}" == "0" ]]; then
    echo "ERR: image not found or zero size: $tag" >&2
    return 1
  fi
  # MB (decimal, matching `docker images` display).
  awk -v b="$bytes" 'BEGIN { printf "%.1f", b/1000/1000 }'
}

server_mb=$(size_mb "$SERVER_TAG") || exit 1
ui_mb=$(size_mb "$UI_TAG")         || exit 1
# Embeddings sidecar — informational only.
embeddings_mb=$(size_mb "$EMBEDDINGS_TAG" 2>/dev/null || echo "n/a")

printf '\n%-30s %12s\n' "IMAGE" "SIZE (MB)"
printf '%-30s %12s\n'   "$SERVER_TAG" "$server_mb"
printf '%-30s %12s\n'   "$UI_TAG"     "$ui_mb"
printf '%-30s %12s   (sidecar — exempt)\n' "$EMBEDDINGS_TAG" "$embeddings_mb"
echo

over() {
  awk -v a="$1" -v b="$2" 'BEGIN { exit (a+0 > b+0) ? 0 : 1 }'
}

fail=0
if over "$server_mb" "$MAX_SERVER_IMAGE_MB"; then
  echo "FAIL: $SERVER_TAG = ${server_mb} MB exceeds ${MAX_SERVER_IMAGE_MB} MB" >&2
  fail=1
fi
if over "$ui_mb" "$MAX_IMAGE_MB"; then
  echo "FAIL: $UI_TAG = ${ui_mb} MB exceeds ${MAX_IMAGE_MB} MB" >&2
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  echo "" >&2
  echo "Image size budget exceeded. See docs/OPERATIONS.md > 'Container Image Sizes'." >&2
  exit 1
fi

echo "OK: $SERVER_TAG ≤ ${MAX_SERVER_IMAGE_MB} MB, $UI_TAG ≤ ${MAX_IMAGE_MB} MB"
