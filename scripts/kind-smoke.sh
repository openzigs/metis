#!/usr/bin/env bash
# =============================================================================
# kind-smoke.sh — local Kubernetes install smoke test for the METIS Helm chart.
#
# Issue #545 (Epic #518). Creates a throwaway kind cluster, runs the offline
# chart gate (lint + template + render-tests.sh), then `helm install`s the chart
# with the dev profile and asserts the release's Kubernetes objects are actually
# created in the cluster.
#
# IMPORTANT — pod-Ready is intentionally NOT gated. The METIS images
# (ghcr.io/openzigs/metis-*) are not published into the kind node, so the
# pods cannot pull and will sit in ImagePullBackOff. That is expected: this
# script validates the CHART (admission accepts every rendered object, the
# release installs, the Deployments/Services/PVCs/Secret exist), NOT the running
# application. To exercise a real rollout, build + `kind load docker-image` the
# images first and pass --load-images (slow; off by default, see WHY below).
#
# Mirrors the CI `chart-validate` job (.github/workflows/chart-validate.yml) so a
# developer can reproduce the gate locally with one command:
#
#   bash scripts/kind-smoke.sh            # create cluster, smoke, tear down
#   make k3d-test                         # same, via the Makefile target
#
# Requires: kind, kubectl, helm (v3+). Docker daemon must be running.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="${REPO_ROOT}/deploy/helm/metis"
CLUSTER_NAME="${KIND_CLUSTER_NAME:-metis-smoke}"
NAMESPACE="${METIS_NAMESPACE:-metis}"
RELEASE="${METIS_RELEASE:-metis}"
KEEP_CLUSTER="${KEEP_CLUSTER:-0}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[0;32m✓ %s\033[0m\n' "$*"; }
die() { printf '  \033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

for bin in kind kubectl helm; do
  command -v "${bin}" >/dev/null 2>&1 || die "required tool '${bin}' not found on PATH"
done

cleanup() {
  if [[ "${KEEP_CLUSTER}" == "1" ]]; then
    log "KEEP_CLUSTER=1 — leaving cluster '${CLUSTER_NAME}' running"
    return
  fi
  log "Tearing down kind cluster '${CLUSTER_NAME}'"
  kind delete cluster --name "${CLUSTER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
log "1/5 Offline chart gate (lint + template + render-tests.sh)"
# ---------------------------------------------------------------------------
helm lint "${CHART_DIR}" >/dev/null && ok "helm lint (default)"
helm lint "${CHART_DIR}" -f "${CHART_DIR}/values-dev.yaml" >/dev/null && ok "helm lint (values-dev)"
helm lint "${CHART_DIR}" -f "${CHART_DIR}/values-prod.yaml" >/dev/null && ok "helm lint (values-prod)"
bash "${CHART_DIR}/tests/render-tests.sh" >/dev/null && ok "render-tests.sh (golden suite)"

# ---------------------------------------------------------------------------
log "2/5 Create kind cluster '${CLUSTER_NAME}'"
# ---------------------------------------------------------------------------
if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  ok "cluster already exists — reusing"
else
  kind create cluster --name "${CLUSTER_NAME}" --wait 120s
  ok "cluster created"
fi
kubectl cluster-info --context "kind-${CLUSTER_NAME}" >/dev/null && ok "cluster reachable"

# ---------------------------------------------------------------------------
log "3/5 helm install (dev profile, server-side dry-run admission then real install)"
# ---------------------------------------------------------------------------
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# The chart's namespaced RBAC Role (rbac.scope=namespaced, default) targets the
# MCP namespace (rbac.mcpNamespace, default metis-mcp) so the server can spawn
# k8s-sse MCP workloads. That namespace must pre-exist — the operator creates it
# in production (EKS_DEPLOYMENT §6). Create it here so the real install succeeds.
MCP_NAMESPACE="$(helm show values "${CHART_DIR}" 2>/dev/null | awk '/^[[:space:]]*mcpNamespace:/ {print $2; exit}')"
MCP_NAMESPACE="${MCP_NAMESPACE:-metis-mcp}"
kubectl create namespace "${MCP_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# Server-side dry-run = the API server validates every rendered object against
# real admission/schema without persisting. Catches manifest errors a pure
# `helm template` cannot (e.g. invalid apiVersions for the cluster's k8s level).
helm install "${RELEASE}" "${CHART_DIR}" \
  -n "${NAMESPACE}" \
  -f "${CHART_DIR}/values-dev.yaml" \
  --dry-run=server >/dev/null && ok "server-side dry-run accepted by the API server"

# Real install. --wait is intentionally OFF: pods will not become Ready because
# the images are not loaded into the kind node (see header). We assert object
# creation, not rollout. --timeout still bounds any hook.
helm install "${RELEASE}" "${CHART_DIR}" \
  -n "${NAMESPACE}" \
  -f "${CHART_DIR}/values-dev.yaml" \
  --timeout 120s >/dev/null && ok "helm install succeeded"

helm status "${RELEASE}" -n "${NAMESPACE}" >/dev/null && ok "release status readable"

# ---------------------------------------------------------------------------
log "4/5 Assert the release's Kubernetes objects exist in-cluster"
# ---------------------------------------------------------------------------
assert_exists() {
  local kind="$1" name="$2"
  if kubectl get "${kind}" "${name}" -n "${NAMESPACE}" >/dev/null 2>&1; then
    ok "${kind}/${name} created"
  else
    die "${kind}/${name} NOT found in namespace ${NAMESPACE}"
  fi
}

# Dev profile: server+ui+embeddings+sql-lineage, a plain Secret,
# 2 PVCs (uploads + lancedb), the ServiceAccount, and the ConfigMap.
assert_exists deployment "${RELEASE}-server"
assert_exists deployment "${RELEASE}-ui"
assert_exists deployment "${RELEASE}-embeddings"
assert_exists deployment "${RELEASE}-sql-lineage"
assert_exists service "${RELEASE}-server"
assert_exists service "${RELEASE}-ui"
assert_exists serviceaccount "${RELEASE}-server"
assert_exists serviceaccount "${RELEASE}-workload"
assert_exists configmap "${RELEASE}-config"
assert_exists secret "${RELEASE}-secrets"

DEPLOY_COUNT="$(kubectl get deploy -n "${NAMESPACE}" -l app.kubernetes.io/part-of=metis --no-headers 2>/dev/null | wc -l | tr -d ' ')"
[[ "${DEPLOY_COUNT}" == "4" ]] && ok "4 metis Deployments present (server+ui+embeddings+sql-lineage)" \
  || die "expected 4 metis Deployments, got ${DEPLOY_COUNT}"

# #1375: the internet-facing UI holds no secret. Read back from the API server,
# not the render, so a mutating webhook or a values mistake would show here.
UI_SECRET_REFS="$(kubectl get deploy "${RELEASE}-ui" -n "${NAMESPACE}" \
  -o jsonpath='{range .spec.template.spec.containers[*].env[*]}{.valueFrom.secretKeyRef.key}{"\n"}{end}' | grep -c . || true)"
[[ "${UI_SECRET_REFS}" == "0" ]] && ok "ui Deployment references no secret" \
  || die "ui Deployment references ${UI_SECRET_REFS} secret key(s); expected none (#1375)"

# The dev profile turns NetworkPolicy off. Have the API server admit the default
# profile's policies (#1374) without persisting them. This checks the schema
# only: kind's default CNI does not enforce egress policy, so traffic is not tested.
helm template "${RELEASE}" "${CHART_DIR}" -n "${NAMESPACE}" \
  --set autoscaling.server.enabled=false --set server.replicaCount=1 \
  --show-only templates/networkpolicy.yaml \
  | kubectl apply --dry-run=server -n "${NAMESPACE}" -f - >/dev/null \
  && ok "NetworkPolicies admitted by the API server (server-side dry-run)" \
  || die "the API server rejected the chart's NetworkPolicies"

# Dev profile pins a single server replica (local in-process backends).
SERVER_REPLICAS="$(kubectl get deploy "${RELEASE}-server" -n "${NAMESPACE}" -o jsonpath='{.spec.replicas}')"
[[ "${SERVER_REPLICAS}" == "1" ]] && ok "dev profile: server replicas=1" \
  || die "expected dev server replicas=1, got ${SERVER_REPLICAS}"

# #1378: `helm upgrade` must leave an HPA-scaled Deployment alone. Turn on the
# ui HPA, scale the Deployment the way the HPA would, and upgrade again. With
# replicas in the manifest, Helm 4 (server-side apply) fails on a field-manager
# conflict and Helm 3 resets the count. The bounds are wide enough that the
# HPA, which has no metrics-server here, leaves 3 alone.
HPA_ARGS=(-n "${NAMESPACE}" -f "${CHART_DIR}/values-dev.yaml"
  --set autoscaling.ui.enabled=true --set autoscaling.ui.minReplicas=1 --set autoscaling.ui.maxReplicas=5
  --timeout 120s)
helm upgrade "${RELEASE}" "${CHART_DIR}" "${HPA_ARGS[@]}" >/dev/null && ok "helm upgrade: ui HPA enabled"
kubectl scale deploy "${RELEASE}-ui" -n "${NAMESPACE}" --replicas=3 >/dev/null
helm upgrade "${RELEASE}" "${CHART_DIR}" "${HPA_ARGS[@]}" >/dev/null \
  && ok "helm upgrade of an HPA-scaled Deployment succeeds without --force-conflicts" \
  || die "helm upgrade failed on an HPA-scaled Deployment (#1378)"
UI_REPLICAS="$(kubectl get deploy "${RELEASE}-ui" -n "${NAMESPACE}" -o jsonpath='{.spec.replicas}')"
[[ "${UI_REPLICAS}" == "3" ]] && ok "upgrade kept the HPA's replica count (3)" \
  || die "upgrade reset the ui replica count to ${UI_REPLICAS}; expected 3 (#1378)"

# ---------------------------------------------------------------------------
log "5/5 Assert prod-profile multi-replica posture renders into the cluster (dry-run)"
# ---------------------------------------------------------------------------
# values-prod is multi-replica (#540): server replicas>1 + scaling env present.
# We do this as a server-side dry-run (no real install) so the smoke stays fast
# and does not leave a second release behind. Bucket is set so the enforce guard
# (scaling.enforce=true in values-prod) is satisfied at render time.
PROD_RENDER="$(helm template "${RELEASE}" "${CHART_DIR}" \
  -f "${CHART_DIR}/values-prod.yaml" \
  --set scaling.database.url=postgres://u:p@db:5432/metis \
  --set uploads.s3.bucket=smoke-bucket)"

# NOTE: use here-strings (grep <<<"$VAR"), NOT `echo "$VAR" | grep -q`. Under
# `set -o pipefail`, grep matching a large input closes the pipe early; echo then
# gets SIGPIPE ("write error: Broken pipe") and the pipeline fails spuriously. A
# here-string has no pipe and no SIGPIPE, so the check is deterministic.
# #1378: the prod server count belongs to its HPA (2..6), so the server
# Deployment states no replicas; the HPA carries the floor.
PROD_SERVER="$(awk '/^kind: Deployment$/{d=1} /^---$/{d=0; s=0} d && $0 == "  name: '"${RELEASE}"'-server"{s=1} s' <<<"${PROD_RENDER}")"
[[ -n "${PROD_SERVER}" ]] || die "prod profile rendered no server Deployment"
! grep -qE '^  replicas:' <<<"${PROD_SERVER}" && ok "prod: server Deployment leaves replicas to its HPA" \
  || die "prod server Deployment renders replicas although its HPA is enabled (#1378)"
grep -qE '^  minReplicas: 2$' <<<"${PROD_RENDER}" && ok "prod: server HPA floor 2 (multi-replica)" \
  || die "prod profile did not render an HPA with minReplicas: 2"
grep -q 'name: VECTOR_STORE' <<<"${PROD_RENDER}" && ok "prod: VECTOR_STORE scaling env present" \
  || die "prod profile missing VECTOR_STORE env"
grep -q 'name: SCHEDULER_LEADER_ELECTION' <<<"${PROD_RENDER}" && ok "prod: SCHEDULER_LEADER_ELECTION env present" \
  || die "prod profile missing SCHEDULER_LEADER_ELECTION env"

log "kind smoke PASSED — chart lints, templates, installs, and creates all objects"
