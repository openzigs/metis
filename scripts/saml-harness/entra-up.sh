#!/usr/bin/env bash
# =============================================================================
# entra-up.sh — start the Entra-profile mock SAML IdP detached and seed METIS
# (Issue #1559). `make entra-up` runs this; `make entra-down` stops it.
#
# Runs scripts/entra-idp.mjs (the same runner as `pnpm saml:entra`, which stays
# in the foreground) in the background, keeps its pid and log in
# scripts/saml-harness/.entra/ (gitignored), waits until it reports ready, and
# prints its banner: the METIS login URL and the preset users.
#
# Prereqs: node, openssl, and a RUNNING METIS server (AUTH_MODE=mock) at
# METIS_API_URL (default http://localhost:4000), unless SKIP_SEED=1.
#
# Usage:
#   bash scripts/saml-harness/entra-up.sh [--signing=assertion] [--no-seed]
#   ENTRA_SIGNING=assertion make entra-up    # start on Entra's default signing
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# ENTRA_STATE_DIR moves the pid and log (scripts/lib/entra-harness-shell.test.mjs).
STATE_DIR="${ENTRA_STATE_DIR:-${REPO_ROOT}/scripts/saml-harness/.entra}"
PID_FILE="${STATE_DIR}/idp.pid"
LOG_FILE="${STATE_DIR}/idp.log"
READY_LINE="Mock Entra ID is up."

die() { printf '  FAIL %s\n' "$*" >&2; exit 1; }
# Is pid $1 still the mock? A pid alone may have been recycled (#1562).
is_mock() { [[ "$1" =~ ^[0-9]+$ ]] && ps -p "$1" -o command= 2>/dev/null | grep -qF "entra-idp.mjs"; }

for bin in node openssl; do
  command -v "${bin}" >/dev/null 2>&1 || die "required tool '${bin}' not found on PATH"
done

if [[ -f "${PID_FILE}" ]] && is_mock "$(cat "${PID_FILE}")"; then
  die "the mock Entra IdP is already running (pid $(cat "${PID_FILE}")); run make entra-down first"
fi

mkdir -p "${STATE_DIR}"
nohup node "${REPO_ROOT}/scripts/entra-idp.mjs" "$@" >"${LOG_FILE}" 2>&1 &
pid=$!
echo "${pid}" >"${PID_FILE}"

for _ in $(seq 1 60); do
  # -s: the backgrounded redirect may not have created the log yet.
  if grep -qsF "${READY_LINE}" "${LOG_FILE}"; then
    cat "${LOG_FILE}"
    printf '  Log: %s\n' "${LOG_FILE}"
    exit 0
  fi
  if ! kill -0 "${pid}" 2>/dev/null; then
    rm -f "${PID_FILE}"
    cat "${LOG_FILE}" >&2
    die "the mock Entra IdP exited before it was ready"
  fi
  sleep 0.5
done

kill "${pid}" 2>/dev/null || true
rm -f "${PID_FILE}"
cat "${LOG_FILE}" >&2
die "the mock Entra IdP was not ready within 30 seconds"
