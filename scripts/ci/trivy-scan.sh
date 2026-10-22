#!/usr/bin/env bash
# #1379 — scan built images with Trivy and gate them (scripts/lib/image-scan-gate.mjs).
#
# Usage: trivy-scan.sh <label>=<image> [<label>=<image> ...]
#   label  the published name without `metis-` (server, ui, embeddings-svc,
#          sql-lineage), which is what a waiver's `images` list refers to.
# Env:
#   TRIVY_BIN        default "$RUNNER_TEMP/trivy/trivy" (scripts/ci/install-trivy.sh)
#   TRIVY_CACHE_DIR  default "$RUNNER_TEMP/trivy-cache"; the workflows restore it with
#                    actions/cache keyed on the date, so the vulnerability DB is
#                    downloaded at most once a day per cache scope.
#   REPORT_DIR       default "trivy-reports": <label>.json, <label>.sarif and
#                    <label>.filtered.sarif (waived results removed) land here.
#   GITHUB_BASE_REF  set on pull requests: the base branch's waiver file is fetched
#                    so a waiver this change DELETED fails while its finding remains.
#
# The DB download is retried; if every attempt fails and a cached DB exists (an
# earlier day's, restored by actions/cache), the scan uses it and says so, rather
# than turning the job red over a registry hiccup. No DB at all fails the step.
set -euo pipefail

TRIVY_BIN="${TRIVY_BIN:-${RUNNER_TEMP:?RUNNER_TEMP must be set}/trivy/trivy}"
TRIVY_CACHE_DIR="${TRIVY_CACHE_DIR:-${RUNNER_TEMP}/trivy-cache}"
REPORT_DIR="${REPORT_DIR:-trivy-reports}"
WAIVERS=".github/image-scan-waivers.json"

if [ "$#" -eq 0 ]; then
  echo "usage: trivy-scan.sh <label>=<image> ..." >&2
  exit 2
fi
mkdir -p "${REPORT_DIR}" "${TRIVY_CACHE_DIR}"

db_ok=0
for attempt in 1 2 3; do
  if "${TRIVY_BIN}" image --download-db-only --cache-dir "${TRIVY_CACHE_DIR}" --quiet; then
    db_ok=1
    break
  fi
  echo "::warning::Trivy DB download failed (attempt ${attempt}/3)"
  sleep $((attempt * 15))
done
if [ "${db_ok}" -ne 1 ]; then
  if [ -f "${TRIVY_CACHE_DIR}/db/trivy.db" ]; then
    echo "::warning title=image scan (#1379)::Trivy DB download failed 3 times; scanning with the cached DB from an earlier run"
  else
    echo "::error title=image scan (#1379)::Trivy DB download failed 3 times and no cached DB exists"
    exit 1
  fi
fi

reports=()
for pair in "$@"; do
  label="${pair%%=*}"
  image="${pair#*=}"
  "${TRIVY_BIN}" image --quiet --skip-db-update --scanners vuln --severity HIGH,CRITICAL \
    --cache-dir "${TRIVY_CACHE_DIR}" --format json \
    --output "${REPORT_DIR}/${label}.json" "${image}"
  "${TRIVY_BIN}" convert --format sarif \
    --output "${REPORT_DIR}/${label}.sarif" "${REPORT_DIR}/${label}.json"
  reports+=(--report "${label}=${REPORT_DIR}/${label}.json")
done

base=()
if [ -n "${GITHUB_BASE_REF:-}" ]; then
  if git fetch --no-tags --depth=1 origin "${GITHUB_BASE_REF}" >/dev/null 2>&1 &&
    git show "FETCH_HEAD:${WAIVERS}" > "${REPORT_DIR}/base-waivers.json" 2>/dev/null; then
    base=(--base-waivers "${REPORT_DIR}/base-waivers.json")
  else
    rm -f "${REPORT_DIR}/base-waivers.json"
    echo "No waiver file on ${GITHUB_BASE_REF}; skipping the deleted-waiver check."
  fi
fi

node scripts/lib/image-scan-gate.mjs --waivers "${WAIVERS}" "${reports[@]}" ${base[@]+"${base[@]}"} \
  --sarif-dir "${REPORT_DIR}"
