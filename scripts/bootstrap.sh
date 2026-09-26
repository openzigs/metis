#!/usr/bin/env bash
# Issue #362 (Epic #359) — first-run bootstrap for a fresh METIS clone.
#
# Idempotent. Running this twice is a no-op. Specifically:
#   * `.env` is created from `.env.example` ONLY if it does not exist.
#     Existing `.env` files are NEVER overwritten and secrets are NEVER
#     rotated by this script.
#   * The `metis-mcp` Docker bridge network is created only if missing.
#   * Wrapper images are pulled from `ghcr.io/metis-mcps/<runner>:<VERSION>`,
#     falling back to `images/mcp-wrappers/build.sh` on pull failure.
#   * `--up` runs `docker compose up -d` and tails server logs until
#     `/readyz` returns 200 (or 120s timeout).
#
# Usage:
#   pnpm bootstrap          # prereqs only (network, secrets, wrapper images)
#   pnpm bootstrap:up       # also bring the stack up and wait for /readyz
#
# Exit codes:
#   0  success
#   1  generic failure
#   2  prerequisite missing (docker, openssl, pnpm)
#   3  Docker daemon not reachable
#   4  /readyz did not become healthy within timeout
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
WRAPPER_DIR="${REPO_ROOT}/images/mcp-wrappers"
NETWORK_NAME="${MCP_DOCKER_NETWORK:-metis-mcp}"
WRAPPER_REGISTRY="${REGISTRY:-ghcr.io/metis-mcps}"
READYZ_URL="${READYZ_URL:-http://localhost:4000/readyz}"
READYZ_TIMEOUT_SECS="${READYZ_TIMEOUT_SECS:-120}"

# When set to 1, the script never invokes docker / pnpm / openssl directly.
# Used by the unit tests to exercise the planning logic without side effects.
DRY_RUN="${BOOTSTRAP_DRY_RUN:-0}"

UP=0
for arg in "$@"; do
  case "${arg}" in
    --up) UP=1 ;;
    -h|--help)
      sed -n '2,22p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "[bootstrap] unknown argument: ${arg}" >&2
      exit 1
      ;;
  esac
done

log()  { printf '[bootstrap] %s\n' "$*"; }
warn() { printf '[bootstrap] WARN: %s\n' "$*" >&2; }
die()  { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "(dry-run) $*"
    return 0
  fi
  "$@"
}

# -----------------------------------------------------------------------------
# 1. Preflight — the four binaries we cannot bootstrap without.
# -----------------------------------------------------------------------------
preflight() {
  local missing=()
  for bin in docker openssl pnpm; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      missing+=("${bin}")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    die "missing required binaries: ${missing[*]}. Install them and retry." 2
  fi

  if [[ "${DRY_RUN}" != "1" ]]; then
    if ! docker info >/dev/null 2>&1; then
      die "Docker daemon is not reachable. Start Docker Desktop / dockerd and retry." 3
    fi
  fi
  log "preflight OK (docker, openssl, pnpm present; daemon reachable)"
}

# -----------------------------------------------------------------------------
# 2. .env — copy from .env.example and populate the four required secrets.
#    Idempotent: an existing .env is left untouched.
# -----------------------------------------------------------------------------
ensure_env() {
  local env_file="${REPO_ROOT}/.env"
  local example_file="${REPO_ROOT}/.env.example"

  if [[ -f "${env_file}" ]]; then
    log ".env already present — skipping (no secrets rotated)"
    return 0
  fi

  if [[ ! -f "${example_file}" ]]; then
    die ".env.example missing at ${example_file}"
  fi

  log "creating .env from .env.example"
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "(dry-run) would copy ${example_file} → ${env_file} and rotate secrets"
    return 0
  fi
  cp "${example_file}" "${env_file}"
  chmod 600 "${env_file}"

  # Generate hex-encoded random secrets — base64 has '=' / '+' / '/' which
  # interact poorly with shell quoting in some downstream tools.
  local jwt_secret vault_master_key embeddings_token
  jwt_secret="$(openssl rand -hex 32)"
  vault_master_key="$(openssl rand -hex 32)"
  embeddings_token="$(openssl rand -hex 32)"

  # Replace the three secret slots. Use awk so we don't depend on GNU sed.
  local tmp
  tmp="$(mktemp)"
  awk \
    -v jwt="${jwt_secret}" \
    -v vault="${vault_master_key}" \
    -v emb="${embeddings_token}" \
    'BEGIN {FS=OFS="="}
     /^JWT_SECRET=/           {print "JWT_SECRET=" jwt; next}
     /^VAULT_MASTER_KEY=/     {print "VAULT_MASTER_KEY=" vault; next}
     /^EMBEDDINGS_TOKEN=/     {print "EMBEDDINGS_TOKEN=" emb; next}
     {print}' \
    "${env_file}" > "${tmp}"
  mv "${tmp}" "${env_file}"
  chmod 600 "${env_file}"
  log "wrote .env with freshly generated JWT_SECRET, VAULT_MASTER_KEY, EMBEDDINGS_TOKEN"
}

# -----------------------------------------------------------------------------
# 3. metis-mcp Docker network. Compose auto-creates it on `up`, but bootstrap
#    is allowed to run `up` later via --up so we ensure it exists eagerly.
# -----------------------------------------------------------------------------
ensure_network() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "(dry-run) would ensure docker network ${NETWORK_NAME} exists"
    return 0
  fi
  if docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
    log "docker network ${NETWORK_NAME} already exists"
    return 0
  fi
  log "creating docker network ${NETWORK_NAME}"
  docker network create "${NETWORK_NAME}" >/dev/null
}

# -----------------------------------------------------------------------------
# 4. Wrapper images — pull from GHCR, fall back to local build on failure.
# -----------------------------------------------------------------------------
WRAPPERS=(
  uvx-runner uvx-runner-sse
  jbang-runner jbang-runner-sse
  node-runner node-runner-sse
  npx-runner npx-runner-sse
  code-graph-runner-sse
)

ensure_wrapper_images() {
  local version
  if [[ ! -f "${WRAPPER_DIR}/VERSION" ]]; then
    die "${WRAPPER_DIR}/VERSION missing — cannot determine wrapper image tag"
  fi
  version="$(tr -d '[:space:]' < "${WRAPPER_DIR}/VERSION")"

  local pull_failed=0
  for wrapper in "${WRAPPERS[@]}"; do
    local tag="${WRAPPER_REGISTRY}/${wrapper}:${version}"
    log "pulling ${tag}"
    if [[ "${DRY_RUN}" == "1" ]]; then
      continue
    fi
    if ! docker pull "${tag}" >/dev/null 2>&1; then
      warn "pull failed for ${tag} — will fall back to local build"
      pull_failed=1
    fi
  done

  if (( pull_failed == 1 )); then
    warn "one or more wrapper image pulls failed; running images/mcp-wrappers/build.sh"
    if [[ "${DRY_RUN}" == "1" ]]; then
      return 0
    fi
    if ! REGISTRY="${WRAPPER_REGISTRY}" "${WRAPPER_DIR}/build.sh"; then
      die "wrapper build fallback failed — see images/mcp-wrappers/build.sh output"
    fi
  fi
}

# -----------------------------------------------------------------------------
# 5. graphify — install the codebase knowledge graph CLI (optional, idempotent).
#    Requires uv (https://docs.astral.sh/uv/). If uv is absent, skip silently.
#    Once installed, `graphify hook install` wires a post-commit hook that
#    auto-rebuilds graphify-out/ on every commit touching source files.
# -----------------------------------------------------------------------------
ensure_graphify() {
  if ! command -v uv >/dev/null 2>&1; then
    warn "uv not found — skipping graphify install (install uv: curl -LsSf https://astral.sh/uv/install.sh | sh)"
    return 0
  fi

  if command -v graphify >/dev/null 2>&1; then
    log "graphify already installed at $(command -v graphify)"
  else
    log "installing graphify via uv tool install graphifyy"
    if [[ "${DRY_RUN}" == "1" ]]; then
      log "(dry-run) would run: uv tool install graphifyy"
    else
      uv tool install graphifyy
      # Ensure the uv tools directory is on PATH for this session.
      # uv tool update-shell writes to ~/.bashrc / ~/.zshrc for future sessions.
      if ! command -v graphify >/dev/null 2>&1; then
        export PATH="${PATH}:$(uv tool dir)/bin"
      fi
    fi
  fi

  # Wire git post-commit hook so graphify-out/ stays fresh automatically.
  if [[ "${DRY_RUN}" != "1" ]] && command -v graphify >/dev/null 2>&1; then
    if [[ ! -f "${REPO_ROOT}/.git/hooks/post-commit" ]] || ! grep -q graphify "${REPO_ROOT}/.git/hooks/post-commit" 2>/dev/null; then
      log "installing graphify post-commit hook"
      (cd "${REPO_ROOT}" && graphify hook install) || warn "graphify hook install failed — run it manually"
    else
      log "graphify post-commit hook already present"
    fi
  fi

  # Wire platform-specific skill integrations (both idempotent — no-op if section already present).
  if [[ "${DRY_RUN}" != "1" ]] && command -v graphify >/dev/null 2>&1; then
    # VS Code Copilot Chat: copies skill to ~/.copilot/skills/ and verifies
    # the ## graphify section in .github/copilot-instructions.md.
    log "configuring graphify for VS Code Copilot Chat"
    (cd "${REPO_ROOT}" && graphify vscode install) || warn "graphify vscode install failed — run it manually"

    # Claude Code: writes graphify section to ~/.claude/CLAUDE.md + PreToolUse hook.
    log "configuring graphify for Claude Code"
    graphify claude install || warn "graphify claude install failed — run it manually"
  fi
}

# -----------------------------------------------------------------------------
# 6. Optional: docker compose up + tail until /readyz is healthy.
# -----------------------------------------------------------------------------
compose_up_and_wait() {
  log "running docker compose up -d"
  run docker compose -f "${REPO_ROOT}/docker-compose.yml" up -d

  log "waiting up to ${READYZ_TIMEOUT_SECS}s for ${READYZ_URL}"
  local deadline=$(( $(date +%s) + READYZ_TIMEOUT_SECS ))
  while (( $(date +%s) < deadline )); do
    if [[ "${DRY_RUN}" == "1" ]]; then
      log "(dry-run) would poll ${READYZ_URL}"
      return 0
    fi
    if curl -fsS --max-time 4 "${READYZ_URL}" >/dev/null 2>&1; then
      log "/readyz: ok — stack healthy"
      return 0
    fi
    sleep 3
  done
  die "/readyz did not return 200 within ${READYZ_TIMEOUT_SECS}s. Inspect: docker compose logs server" 4
}

# -----------------------------------------------------------------------------
# main
# -----------------------------------------------------------------------------
main() {
  log "METIS bootstrap — repo=${REPO_ROOT}"
  preflight
  ensure_env
  ensure_network
  ensure_wrapper_images
  ensure_graphify
  if (( UP == 1 )); then
    compose_up_and_wait
  else
    log "bootstrap complete. Next: 'pnpm bootstrap:up' or 'docker compose up'."
  fi
}

main "$@"
