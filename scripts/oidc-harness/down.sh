#!/usr/bin/env bash
# =============================================================================
# down.sh — tear down the local OIDC test harness (Issue #521, Epic #517).
#
# Stops + removes the Keycloak container. Keycloak (start-dev) uses an in-memory
# H2 database, so the realm is re-imported fresh on every `make oidc-up` — there
# is no persistent state or keypair to purge.
#
# Usage:
#   bash scripts/oidc-harness/down.sh        # or: make oidc-down
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.oidc.yml"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[0;32mOK %s\033[0m\n' "$*"; }

command -v docker >/dev/null 2>&1 || { printf 'docker not found on PATH\n' >&2; exit 1; }

log "Stopping Keycloak"
docker compose -f "${COMPOSE_FILE}" down >/dev/null 2>&1 || true
ok "Keycloak stopped"

log "OIDC harness is DOWN."
