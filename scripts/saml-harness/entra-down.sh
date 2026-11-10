#!/usr/bin/env bash
# =============================================================================
# entra-down.sh — stop the mock Entra IdP that entra-up.sh started (#1559).
#
# Signals the pid in scripts/saml-harness/.entra/idp.pid only when that process
# is still scripts/entra-idp.mjs, so a recycled pid is never killed. If the mock
# is still running 5 seconds after SIGTERM, says so, keeps the pid file and
# exits 1 (#1562). METIS's SAML provider stays configured (as after
# make saml-down); the next make entra-up re-seeds it with the new signing
# certificate.
#
# Usage: bash scripts/saml-harness/entra-down.sh    # or: make entra-down
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# ENTRA_STATE_DIR moves the pid and log (scripts/lib/entra-harness-shell.test.mjs).
PID_FILE="${ENTRA_STATE_DIR:-${REPO_ROOT}/scripts/saml-harness/.entra}/idp.pid"

# Is pid $1 still the mock? A pid alone may have been recycled. The mock is a
# node process whose script is entra-idp.mjs, not any command line that merely
# mentions it (an editor, a grep, `node -e … entra-idp.mjs`) (#2204).
MOCK_COMMAND_RE='^([^[:space:]]*/)?node[[:space:]]+(/.*/)?entra-idp\.mjs([[:space:]]|$)'
is_mock() {
  local command
  [[ "$1" =~ ^[0-9]+$ ]] && command="$(ps -p "$1" -o command= 2>/dev/null)" &&
    [[ "${command}" =~ ${MOCK_COMMAND_RE} ]]
}

if [[ ! -f "${PID_FILE}" ]]; then
  printf '  OK the mock Entra IdP is not running\n'
  exit 0
fi

pid="$(cat "${PID_FILE}")"
if ! is_mock "${pid}"; then
  printf '  OK the mock Entra IdP was not running (stale pid file)\n'
  rm -f "${PID_FILE}"
  exit 0
fi

kill -TERM "${pid}"
for _ in $(seq 1 20); do
  is_mock "${pid}" || break
  sleep 0.25
done
if is_mock "${pid}"; then
  printf '  FAIL the mock Entra IdP (pid %s) is still running 5 seconds after SIGTERM; stop it with: kill -KILL %s\n' \
    "${pid}" "${pid}" >&2
  exit 1
fi
printf '  OK stopped the mock Entra IdP (pid %s)\n' "${pid}"
rm -f "${PID_FILE}"
