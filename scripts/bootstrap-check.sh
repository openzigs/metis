#!/usr/bin/env bash
# Issue #365 (Epic #359) — non-mutating diagnostic for the local-dev MCP stack.
#
# Prints a pass/fail matrix of every prerequisite the bootstrap flow assumes.
# This script never writes anything: no docker network create, no .env write,
# no image pull. Use `pnpm bootstrap` to fix the failures it surfaces.
#
# Usage:
#   pnpm bootstrap:check          # human-readable pass/fail matrix
#   pnpm bootstrap:check --json   # machine-readable JSON for CI smoke tests
#
# Exit codes:
#   0  every check passed
#   N  N checks failed (capped at 125 for shell exit-code sanity)
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
NETWORK_NAME="${MCP_DOCKER_NETWORK:-metis-mcp}"
WRAPPER_REGISTRY="${REGISTRY:-ghcr.io/metis-mcps}"
WRAPPER_DIR="${REPO_ROOT}/images/mcp-wrappers"
EMBEDDINGS_HEALTHZ="${EMBEDDINGS_HEALTHZ:-http://localhost:5050/healthz}"
EXPECTED_PORTS=(3000 4000 5050 5432)

JSON_OUTPUT=0
for arg in "$@"; do
  case "${arg}" in
    --json) JSON_OUTPUT=1 ;;
    -h|--help)
      sed -n '2,15p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "[bootstrap:check] unknown argument: ${arg}" >&2
      exit 1
      ;;
  esac
done

# ---- result accumulators ----------------------------------------------------
results_name=()
results_status=()  # "pass" | "fail"
results_hint=()    # remediation string (only populated on fail)

record() {
  local name="$1" status="$2" hint="${3:-}"
  results_name+=("${name}")
  results_status+=("${status}")
  results_hint+=("${hint}")
}

# ---- the checks -------------------------------------------------------------
check_docker_binary() {
  if command -v docker >/dev/null 2>&1; then
    record "docker binary present" pass
  else
    record "docker binary present" fail "install Docker Desktop / Rancher Desktop / Colima"
  fi
}

check_docker_daemon() {
  if ! command -v docker >/dev/null 2>&1; then
    record "docker daemon reachable" fail "docker not installed (see previous row)"
    return
  fi
  if docker info >/dev/null 2>&1; then
    record "docker daemon reachable" pass
  else
    record "docker daemon reachable" fail "start the Docker daemon (Docker Desktop) and retry"
  fi
}

check_metis_mcp_network() {
  if ! command -v docker >/dev/null 2>&1; then
    record "metis-mcp network present" fail "docker not installed"
    return
  fi
  if docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
    record "metis-mcp network present" pass
  else
    record "metis-mcp network present" fail \
      "run 'docker compose up' (auto-creates) or 'docker network create ${NETWORK_NAME}'"
  fi
}

WRAPPERS=(
  uvx-runner uvx-runner-sse
  jbang-runner jbang-runner-sse
  node-runner node-runner-sse
  npx-runner npx-runner-sse
  code-graph-runner-sse
)

check_wrapper_images() {
  if ! command -v docker >/dev/null 2>&1; then
    record "wrapper images cached" fail "docker not installed"
    return
  fi
  if [[ ! -f "${WRAPPER_DIR}/VERSION" ]]; then
    record "wrapper images cached" fail "${WRAPPER_DIR}/VERSION missing"
    return
  fi
  local version
  version="$(tr -d '[:space:]' < "${WRAPPER_DIR}/VERSION")"
  local total=${#WRAPPERS[@]}
  local cached=0
  for w in "${WRAPPERS[@]}"; do
    if docker image inspect "${WRAPPER_REGISTRY}/${w}:${version}" >/dev/null 2>&1; then
      cached=$((cached + 1))
    fi
  done
  if (( cached == total )); then
    record "wrapper images cached: ${cached}/${total}" pass
  else
    record "wrapper images cached: ${cached}/${total}" fail \
      "run 'pnpm bootstrap' to pull from ${WRAPPER_REGISTRY}"
  fi
}

check_env_present() {
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    record ".env present" pass
  else
    record ".env present" fail "run 'pnpm bootstrap' to create it from .env.example"
  fi
}

# A port is OK if either (a) nothing is listening, or (b) something IS
# listening but it's a docker-managed metis container (we can't easily prove
# the latter without root, so we accept the listener silently — `docker ps`
# is consulted to add a hint when both ports look busy).
check_port_free() {
  local port="$1"
  # `lsof` is a near-universal mac/linux probe. `nc` would also work.
  if ! command -v lsof >/dev/null 2>&1; then
    record "port ${port} probe-able" fail "lsof not installed; cannot probe ports"
    return
  fi
  if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    # Port is bound. Best-effort: does docker have a metis container on it?
    if docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
        | grep -E "metis-.*:${port}->" >/dev/null; then
      record "port ${port} owned by metis" pass
    else
      record "port ${port} free" fail \
        "another process is listening on :${port} — stop it or set a different port"
    fi
  else
    record "port ${port} free" pass
  fi
}

check_embeddings_healthz() {
  if ! command -v curl >/dev/null 2>&1; then
    record "embeddings /healthz reachable" fail "curl not installed"
    return
  fi
  if curl -fsS --max-time 3 "${EMBEDDINGS_HEALTHZ}" >/dev/null 2>&1; then
    record "embeddings /healthz reachable" pass
  else
    record "embeddings /healthz reachable" fail \
      "embeddings sidecar not running — 'pnpm bootstrap:up' or 'docker compose up'"
  fi
}

check_graphify() {
  if command -v graphify >/dev/null 2>&1; then
    record "graphify CLI present" pass
  elif command -v uv >/dev/null 2>&1; then
    record "graphify CLI present" fail \
      "run 'pnpm bootstrap' (auto-installs via uv tool install graphifyy)"
  else
    record "graphify CLI present" fail \
      "install uv first (curl -LsSf https://astral.sh/uv/install.sh | sh), then run 'pnpm bootstrap'"
  fi
}

# ---- run all checks ---------------------------------------------------------
check_docker_binary
check_docker_daemon
check_metis_mcp_network
check_wrapper_images
check_env_present
for p in "${EXPECTED_PORTS[@]}"; do
  check_port_free "${p}"
done
check_embeddings_healthz
check_graphify

# ---- compute summary --------------------------------------------------------
total=${#results_name[@]}
fail_count=0
for s in "${results_status[@]}"; do
  [[ "${s}" == "fail" ]] && fail_count=$((fail_count + 1))
done
pass_count=$((total - fail_count))

# ---- emit output ------------------------------------------------------------
if (( JSON_OUTPUT == 1 )); then
  printf '{\n  "summary": {"total": %d, "passed": %d, "failed": %d},\n  "checks": [\n' \
    "${total}" "${pass_count}" "${fail_count}"
  for ((i = 0; i < total; i++)); do
    sep=","
    [[ $i -eq $((total - 1)) ]] && sep=""
    # JSON-escape: replace " with \"
    name="${results_name[$i]//\"/\\\"}"
    hint="${results_hint[$i]//\"/\\\"}"
    printf '    {"name": "%s", "status": "%s", "hint": "%s"}%s\n' \
      "${name}" "${results_status[$i]}" "${hint}" "${sep}"
  done
  printf '  ]\n}\n'
else
  printf 'metis bootstrap:check\n'
  printf -- '─────────────────────────────────\n'
  for ((i = 0; i < total; i++)); do
    if [[ "${results_status[$i]}" == "pass" ]]; then
      printf '✔ %s\n' "${results_name[$i]}"
    else
      printf '✘ %s\n' "${results_name[$i]}"
      printf '   → fix: %s\n' "${results_hint[$i]}"
    fi
  done
  printf -- '─────────────────────────────────\n'
  printf '%d failed, %d passed\n' "${fail_count}" "${pass_count}"
fi

# Cap exit code so e.g. 200 failures don't wrap in shell semantics.
if (( fail_count > 125 )); then
  exit 125
fi
exit "${fail_count}"
