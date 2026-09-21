#!/usr/bin/env bash
# =============================================================================
# chart-validate.sh — offline Helm chart gate for the METIS chart (no cluster).
#
# Issue #545 (Epic #518). Runs the cluster-free half of the validation that the
# CI `chart-validate` job runs (lint + template across the default/dev/prod value
# sets + the render-tests.sh golden suite). This is the fast inner loop a dev can
# run before pushing; `scripts/kind-smoke.sh` adds the real-cluster install on
# top. Mirrors .github/workflows/chart-validate.yml's `chart-lint` job.
#
#   bash scripts/chart-validate.sh        # lint + template + render-tests
#   make chart-validate                   # same, via the Makefile
#
# Requires: helm (v3+). No cluster, no Docker.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="${REPO_ROOT}/deploy/helm/metis"

ok() { printf '  \033[0;32m✓ %s\033[0m\n' "$*"; }
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

command -v helm >/dev/null 2>&1 || { echo "helm not found on PATH" >&2; exit 1; }

log "helm lint — default + values-dev + values-prod"
helm lint "${CHART_DIR}" && ok "lint (default)"
helm lint "${CHART_DIR}" -f "${CHART_DIR}/values-dev.yaml" && ok "lint (values-dev)"
helm lint "${CHART_DIR}" -f "${CHART_DIR}/values-prod.yaml" && ok "lint (values-prod)"

log "helm template — default + values-dev + values-prod (must render without error)"
helm template metis "${CHART_DIR}" >/dev/null && ok "template (default)"
helm template metis "${CHART_DIR}" -f "${CHART_DIR}/values-dev.yaml" >/dev/null && ok "template (values-dev)"
# values-prod has scaling.enforce=true; supply the shared-backend inputs so the
# assertScalingBackends guard is satisfied and the prod profile renders.
helm template metis "${CHART_DIR}" -f "${CHART_DIR}/values-prod.yaml" \
  --set scaling.database.url=postgres://u:p@db:5432/metis \
  --set uploads.s3.bucket=ci-validate-bucket >/dev/null && ok "template (values-prod)"

log "render-tests.sh — golden / smoke assertions"
bash "${CHART_DIR}/tests/render-tests.sh"

log "chart-validate PASSED"
