#!/usr/bin/env bash
# =============================================================================
# up.sh — bring up the local LDAP test harness (Issue #525, Epic #517).
#
# Steps:
#   1. `docker compose -f docker-compose.ldap.yml up -d` OpenLDAP, seeded
#      deterministically from scripts/ldap-harness/bootstrap.ldif, and wait until
#      a real LDAP bind+search against ldap://localhost:4400 succeeds.
#   2. Run scripts/seed-ldap.mjs, which performs the same bind → search → user
#      bind → group→role checks METIS's LDAP provider does, then PRINTS the exact
#      AUTH_LDAP_* env block to export.
#
# Unlike the SAML/OIDC harnesses, LDAP is ENV-DRIVEN: there is no METIS admin-API
# step in the default flow. After this runs, export the printed AUTH_LDAP_* block
# (or use the `--configure-metis` pass-through, see below) and start METIS with
# AUTH_MODE=ldap.
#
# Prereqs: docker (compose v2) and node. A running METIS server is NOT required
# (this only validates the directory). It IS required if you pass CONFIGURE=1.
#
# Usage:
#   bash scripts/ldap-harness/up.sh        # or: make ldap-up
#
# Env overrides: LDAP_URL, LDAP_BASE_DN, SKIP_SEED=1, CONFIGURE=1.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.ldap.yml"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[0;32mOK %s\033[0m\n' "$*"; }
die() { printf '  \033[0;31mFAIL %s\033[0m\n' "$*" >&2; exit 1; }

for bin in docker node; do
  command -v "${bin}" >/dev/null 2>&1 || die "required tool '${bin}' not found on PATH"
done

# ---------------------------------------------------------------------------
log "1/2 Start OpenLDAP (docker compose, LDIF seed)"
# ---------------------------------------------------------------------------
docker compose -f "${COMPOSE_FILE}" up -d >/dev/null || die "docker compose up failed"
ok "OpenLDAP container started"

LDAP_URL="${LDAP_URL:-ldap://localhost:4400}"
BIND_DN="${LDAP_BIND_DN:-cn=admin,dc=metis,dc=local}"
BIND_PW="${LDAP_BIND_PASSWORD:-adminpassword}"
BASE_DN="${LDAP_BASE_DN:-dc=metis,dc=local}"
HOST_PORT="${LDAP_URL##*:}"

log "waiting for OpenLDAP to accept a bind+search on ${LDAP_URL}"
# Probe with the container's own ldapsearch (the host may not have ldap-utils).
# First-boot + LDIF import can take a little while; allow ~1 min.
for i in $(seq 1 30); do
  if docker compose -f "${COMPOSE_FILE}" exec -T ldap-idp \
      ldapsearch -x -H "ldap://localhost:1389" -D "${BIND_DN}" -w "${BIND_PW}" \
      -b "${BASE_DN}" "(uid=alice)" dn >/dev/null 2>&1; then
    ok "OpenLDAP is serving the seeded metis tree"
    break
  fi
  [[ "${i}" == "30" ]] && die "OpenLDAP did not become ready in time"
  sleep 2
done

# ---------------------------------------------------------------------------
log "2/2 Verify the directory (bind + search + group→role) and print env"
# ---------------------------------------------------------------------------
if [[ "${SKIP_SEED:-0}" == "1" ]]; then
  ok "SKIP_SEED=1 — OpenLDAP is up; run 'node scripts/seed-ldap.mjs' yourself"
else
  if [[ "${CONFIGURE:-0}" == "1" ]]; then
    node "${REPO_ROOT}/scripts/seed-ldap.mjs" --configure-metis || die "seed-ldap.mjs failed"
  else
    node "${REPO_ROOT}/scripts/seed-ldap.mjs" || die "seed-ldap.mjs failed"
  fi
fi

log "LDAP harness is UP."
printf '  Test users: alice / alicepass (group metis-admins -> role admin)\n'
printf '              bob   / bobpass   (group metis-developers -> role developer)\n'
printf '  Export the AUTH_LDAP_* block printed above, then start METIS with AUTH_MODE=ldap.\n'
printf '  Tear down:  make ldap-down\n'
