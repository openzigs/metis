#!/usr/bin/env bash
# =============================================================================
# up.sh — bring up the local SAML test harness (Issue #523, Epic #517).
#
# Steps:
#   1. Generate a throwaway RSA signing keypair (once; cached in .keys/,
#      gitignored) and export it base64-encoded as the env vars the mock IdP
#      reads (boxyhq/mock-saml has NO fallback key — it MUST be supplied).
#   2. `docker compose -f docker-compose.saml.yml up -d` the mock IdP and wait
#      for its metadata endpoint to be healthy.
#   3. Run scripts/seed-saml.mjs to configure METIS's SAML provider via the
#      admin API (points it at the mock IdP, keeps #520's secure defaults).
#
# Prereqs: docker (compose v2), openssl, node, and a RUNNING METIS server
# (AUTH_MODE=mock) reachable at METIS_API_URL (default http://localhost:4000).
#
# Usage:
#   bash scripts/saml-harness/up.sh        # or: make saml-up
#
# Env overrides: METIS_API_URL, SAML_IDP_URL, SKIP_SEED=1 (just start the IdP).
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_DIR="${REPO_ROOT}/scripts/saml-harness"
KEYS_DIR="${HARNESS_DIR}/.keys"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.saml.yml"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[0;32mOK %s\033[0m\n' "$*"; }
die() { printf '  \033[0;31mFAIL %s\033[0m\n' "$*" >&2; exit 1; }

for bin in docker openssl node; do
  command -v "${bin}" >/dev/null 2>&1 || die "required tool '${bin}' not found on PATH"
done

# ---------------------------------------------------------------------------
log "1/3 Generate (or reuse) the mock IdP signing keypair"
# ---------------------------------------------------------------------------
mkdir -p "${KEYS_DIR}"
KEY_PEM="${KEYS_DIR}/idp-key.pem"
CERT_PEM="${KEYS_DIR}/idp-cert.pem"
if [[ -f "${KEY_PEM}" && -f "${CERT_PEM}" ]]; then
  ok "reusing existing keypair in scripts/saml-harness/.keys/"
else
  # Self-signed cert valid 1 day — a throwaway LOCAL test identity only.
  openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PEM}" -out "${CERT_PEM}" \
    -sha256 -days 1 -nodes -subj "/CN=metis-mock-saml-idp" >/dev/null 2>&1 \
    || die "openssl keypair generation failed"
  ok "generated throwaway RSA keypair (valid 1 day)"
fi

# mock-saml expects base64-encoded PEM in PUBLIC_KEY / PRIVATE_KEY.
SAML_IDP_PUBLIC_KEY="$(base64 < "${CERT_PEM}" | tr -d '\n')"
SAML_IDP_PRIVATE_KEY="$(base64 < "${KEY_PEM}" | tr -d '\n')"
export SAML_IDP_PUBLIC_KEY SAML_IDP_PRIVATE_KEY

# ---------------------------------------------------------------------------
log "2/3 Start the mock SAML IdP (docker compose)"
# ---------------------------------------------------------------------------
docker compose -f "${COMPOSE_FILE}" up -d >/dev/null || die "docker compose up failed"
ok "mock IdP container started"

IDP_URL="${SAML_IDP_URL:-http://localhost:4500}"
log "waiting for the mock IdP metadata endpoint at ${IDP_URL}/api/saml/metadata"
for i in $(seq 1 30); do
  if curl -fsS "${IDP_URL}/api/saml/metadata" >/dev/null 2>&1; then
    ok "mock IdP is serving signed metadata"
    break
  fi
  [[ "${i}" == "30" ]] && die "mock IdP did not become healthy in time"
  sleep 2
done

# ---------------------------------------------------------------------------
log "3/3 Seed the METIS SAML provider via the admin API"
# ---------------------------------------------------------------------------
if [[ "${SKIP_SEED:-0}" == "1" ]]; then
  ok "SKIP_SEED=1 — mock IdP is up; run 'node scripts/seed-saml.mjs' yourself"
else
  node "${REPO_ROOT}/scripts/seed-saml.mjs" || die "seed-saml.mjs failed (is the METIS server up with AUTH_MODE=mock?)"
fi

log "SAML harness is UP."
printf '  Log in:   %s/auth/saml/login\n' "${METIS_API_URL:-http://localhost:4000}"
printf '  Users:    user1@example.com / user2@example.com (any password)\n'
printf '  Tear down: make saml-down\n'
