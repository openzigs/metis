#!/usr/bin/env bash
# =============================================================================
# up.sh — bring up the local OIDC test harness (Issue #521, Epic #517).
#
# Steps:
#   1. `docker compose -f docker-compose.oidc.yml up -d` Keycloak with the
#      metis realm imported from scripts/oidc-harness/realm-metis.json, and wait
#      for the realm's OIDC discovery doc to answer.
#   2. Run scripts/seed-oidc.mjs to configure METIS's OIDC provider via the admin
#      API (points it at Keycloak's discovery URL, client id/secret, scopes, and
#      the group→role mappings).
#
# Prereqs: docker (compose v2), curl, node, and a RUNNING METIS server
# (AUTH_MODE=mock) reachable at METIS_API_URL (default http://localhost:4000).
#
# Usage:
#   bash scripts/oidc-harness/up.sh        # or: make oidc-up
#
# Env overrides: METIS_API_URL, OIDC_IDP_URL, OIDC_REALM, SKIP_SEED=1.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.oidc.yml"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[0;32mOK %s\033[0m\n' "$*"; }
die() { printf '  \033[0;31mFAIL %s\033[0m\n' "$*" >&2; exit 1; }

for bin in docker curl node; do
  command -v "${bin}" >/dev/null 2>&1 || die "required tool '${bin}' not found on PATH"
done

# ---------------------------------------------------------------------------
log "1/2 Start Keycloak (docker compose, realm import)"
# ---------------------------------------------------------------------------
docker compose -f "${COMPOSE_FILE}" up -d >/dev/null || die "docker compose up failed"
ok "Keycloak container started"

IDP_URL="${OIDC_IDP_URL:-http://localhost:4600}"
REALM="${OIDC_REALM:-metis}"
DISCOVERY="${IDP_URL}/realms/${REALM}/.well-known/openid-configuration"
log "waiting for the realm discovery doc at ${DISCOVERY}"
# Keycloak first-boot + realm import can take a while; allow ~2 min.
for i in $(seq 1 60); do
  if curl -fsS "${DISCOVERY}" >/dev/null 2>&1; then
    ok "Keycloak is serving the metis realm discovery doc"
    break
  fi
  [[ "${i}" == "60" ]] && die "Keycloak realm did not become ready in time"
  sleep 2
done

# ---------------------------------------------------------------------------
log "2/2 Seed the METIS OIDC provider via the admin API"
# ---------------------------------------------------------------------------
if [[ "${SKIP_SEED:-0}" == "1" ]]; then
  ok "SKIP_SEED=1 — Keycloak is up; run 'node scripts/seed-oidc.mjs' yourself"
else
  node "${REPO_ROOT}/scripts/seed-oidc.mjs" || die "seed-oidc.mjs failed (is the METIS server up with AUTH_MODE=mock?)"
fi

log "OIDC harness is UP."
printf '  Log in:    %s/api/auth/oidc/login\n' "${METIS_API_URL:-http://localhost:4000}"
printf '  Test user: tester / testpass (group metis-admins -> role admin)\n'
printf '  KC admin:  %s/admin  (admin / admin)\n' "${IDP_URL}"
printf '  Tear down: make oidc-down\n'
