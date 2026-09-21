#!/usr/bin/env bash
# =============================================================================
# down.sh — tear down the local LDAP test harness (Issue #525, Epic #517).
#
# Stops + removes the OpenLDAP container AND its anonymous data volume, so the
# directory is re-seeded fresh from scripts/ldap-harness/bootstrap.ldif on every
# `make ldap-up` (bitnami/openldap only runs the custom LDIF on a FIRST boot with
# an empty data dir — `down -v` guarantees that).
#
# Usage:
#   bash scripts/ldap-harness/down.sh        # or: make ldap-down
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.ldap.yml"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[0;32mOK %s\033[0m\n' "$*"; }

command -v docker >/dev/null 2>&1 || { printf 'docker not found on PATH\n' >&2; exit 1; }

log "Stopping OpenLDAP (and removing its data volume for a clean re-seed)"
docker compose -f "${COMPOSE_FILE}" down -v >/dev/null 2>&1 || true
ok "OpenLDAP stopped"

log "LDAP harness is DOWN."
