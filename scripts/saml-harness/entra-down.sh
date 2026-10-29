#!/usr/bin/env bash
# =============================================================================
# entra-down.sh — stop the mock Entra IdP that entra-up.sh started (#1559).
#
# Signals the pid in scripts/saml-harness/.entra/idp.pid only when that process
# is still scripts/entra-idp.mjs, so a recycled pid is never killed. METIS's
# SAML provider stays configured (as after make saml-down); the next
# make entra-up re-seeds it with the new signing certificate.
#
# Usage: bash scripts/saml-harness/entra-down.sh    # or: make entra-down
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PID_FILE="${REPO_ROOT}/scripts/saml-harness/.entra/idp.pid"

if [[ ! -f "${PID_FILE}" ]]; then
  printf '  OK the mock Entra IdP is not running\n'
  exit 0
fi

pid="$(cat "${PID_FILE}")"
if [[ "${pid}" =~ ^[0-9]+$ ]] && ps -p "${pid}" -o command= 2>/dev/null | grep -qF "entra-idp.mjs"; then
  kill -TERM "${pid}"
  for _ in $(seq 1 20); do
    kill -0 "${pid}" 2>/dev/null || break
    sleep 0.25
  done
  printf '  OK stopped the mock Entra IdP (pid %s)\n' "${pid}"
else
  printf '  OK the mock Entra IdP was not running (stale pid file)\n'
fi
rm -f "${PID_FILE}"
