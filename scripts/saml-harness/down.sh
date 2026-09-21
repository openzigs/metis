#!/usr/bin/env bash
# =============================================================================
# down.sh — tear down the local SAML test harness (Issue #523, Epic #517).
#
# Stops + removes the mock IdP container. The generated keypair in
# scripts/saml-harness/.keys/ is LEFT in place so a subsequent `make saml-up`
# reuses the same signing identity (and the already-seeded METIS provider keeps
# trusting it). Pass --purge-keys to also delete the keypair.
#
# Usage:
#   bash scripts/saml-harness/down.sh                # or: make saml-down
#   bash scripts/saml-harness/down.sh --purge-keys
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.saml.yml"
KEYS_DIR="${REPO_ROOT}/scripts/saml-harness/.keys"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[0;32mOK %s\033[0m\n' "$*"; }

command -v docker >/dev/null 2>&1 || { printf 'docker not found on PATH\n' >&2; exit 1; }

log "Stopping the mock SAML IdP"
docker compose -f "${COMPOSE_FILE}" down >/dev/null 2>&1 || true
ok "mock IdP stopped"

if [[ "${1:-}" == "--purge-keys" ]]; then
  rm -rf "${KEYS_DIR}"
  ok "purged scripts/saml-harness/.keys/"
fi

log "SAML harness is DOWN."
