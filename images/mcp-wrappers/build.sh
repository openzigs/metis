#!/usr/bin/env bash
# Epic #271 — Build all MCP wrapper images.
#
# Usage:
#   ./images/mcp-wrappers/build.sh                 # build & tag with VERSION
#   REGISTRY=ghcr.io/metis-mcps ./build.sh         # override registry prefix
#   ./build.sh push                                # build then push each tag
#
# Each Dockerfile lives in a subfolder named after the runner. We tag every
# image as `<REGISTRY>/<runner>:<VERSION>` and `<REGISTRY>/<runner>:latest`.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
VERSION_FILE="${SCRIPT_DIR}/VERSION"
if [[ ! -f "${VERSION_FILE}" ]]; then
  echo "VERSION file missing at ${VERSION_FILE}" >&2
  exit 1
fi
VERSION="$(tr -d '[:space:]' < "${VERSION_FILE}")"
REGISTRY="${REGISTRY:-ghcr.io/metis-mcps}"

WRAPPERS=(
  uvx-runner
  jbang-runner
  node-runner
  npx-runner
  uvx-runner-sse
  jbang-runner-sse
  node-runner-sse
  npx-runner-sse
  code-graph-runner-sse
)

PUSH=0
if [[ "${1:-}" == "push" ]]; then PUSH=1; fi

for wrapper in "${WRAPPERS[@]}"; do
  dir="${SCRIPT_DIR}/${wrapper}"
  if [[ ! -f "${dir}/Dockerfile" ]]; then
    echo "[skip] ${wrapper}: no Dockerfile at ${dir}" >&2
    continue
  fi
  versioned_tag="${REGISTRY}/${wrapper}:${VERSION}"
  latest_tag="${REGISTRY}/${wrapper}:latest"
  echo "==> Building ${wrapper} -> ${versioned_tag}"
  # SSE variants FROM the just-built local base image; --pull would force a
  # registry fetch for that base and 403 on unpublished local-dev builds.
  pull_flag=(--pull)
  if [[ "${wrapper}" == *-sse && "${wrapper}" != "code-graph-runner-sse" ]]; then
    pull_flag=()
  fi
  docker build \
    "${pull_flag[@]}" \
    --tag "${versioned_tag}" \
    --tag "${latest_tag}" \
    "${dir}"
  if [[ "${PUSH}" -eq 1 ]]; then
    echo "==> Pushing ${versioned_tag}"
    docker push "${versioned_tag}"
    docker push "${latest_tag}"
  fi
done

echo "Done."
