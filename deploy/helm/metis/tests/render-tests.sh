#!/usr/bin/env bash
# =============================================================================
# render-tests.sh — golden / smoke tests for the METIS Helm chart.
#
# Runs `helm template` against a matrix of toggles and asserts on the rendered
# resource shape. Designed to run in CI without a real cluster — pure
# template validation. Each test prints PASS / FAIL and the script exits
# non-zero on the first failure.
#
# Usage: bash deploy/helm/metis/tests/render-tests.sh
# =============================================================================
set -euo pipefail

CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
FAILED_TESTS=()

assert() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "${actual}" == "${expected}" ]]; then
    printf "  ✓ %s\n" "${name}"
    PASS=$((PASS + 1))
  else
    printf "  ✗ %s — expected '%s', got '%s'\n" "${name}" "${expected}" "${actual}"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("${name}")
  fi
}

assert_contains() {
  local name="$1"
  local needle="$2"
  local haystack="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    printf "  ✓ %s\n" "${name}"
    PASS=$((PASS + 1))
  else
    printf "  ✗ %s — '%s' not found\n" "${name}" "${needle}"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("${name}")
  fi
}

assert_not_contains() {
  local name="$1"
  local needle="$2"
  local haystack="$3"
  if [[ "${haystack}" != *"${needle}"* ]]; then
    printf "  ✓ %s\n" "${name}"
    PASS=$((PASS + 1))
  else
    printf "  ✗ %s — '%s' should not be present\n" "${name}" "${needle}"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("${name}")
  fi
}

template() {
  helm template metis "${CHART_DIR}" "$@" 2>&1
}

count_kind() {
  local kind="$1"
  local rendered="$2"
  echo "${rendered}" | grep -cE "^kind: ${kind}\$" || true
}

# ---------------------------------------------------------------------------
echo "Test 1: helm lint clean"
# ---------------------------------------------------------------------------
if helm lint "${CHART_DIR}" >/dev/null 2>&1; then
  echo "  ✓ helm lint passes"
  PASS=$((PASS + 1))
else
  echo "  ✗ helm lint failed"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("helm lint")
fi

# ---------------------------------------------------------------------------
echo "Test 2: default render — sub-issue #366 chart skeleton"
# ---------------------------------------------------------------------------
DEFAULT=$(template)
assert "1× ConfigMap" 1 "$(count_kind ConfigMap "${DEFAULT}")"
# Epic #294 — the metis-sql-lineage sidecar is enabled by default, so the
# default render now has 4 deployments/services (server+ui+embeddings+sql-lineage).
assert "4× Deployment (server+ui+embeddings+sql-lineage)" 4 "$(count_kind Deployment "${DEFAULT}")"
assert "4× Service" 4 "$(count_kind Service "${DEFAULT}")"
assert "1× ServiceAccount" 1 "$(count_kind ServiceAccount "${DEFAULT}")"
assert "0× copilot resources (removed, #150)" 0 "$(echo "${DEFAULT}" | grep -ciE 'copilot' || true)"
assert_contains "sql-lineage deployment present by default" "name: metis-sql-lineage" "${DEFAULT}"
assert_contains "runAsNonRoot enforced" "runAsNonRoot: true" "${DEFAULT}"
assert_contains "readOnlyRootFilesystem enforced" "readOnlyRootFilesystem: true" "${DEFAULT}"
assert_contains "capabilities drop ALL" "drop:" "${DEFAULT}"
assert_contains "seccompProfile RuntimeDefault" "type: RuntimeDefault" "${DEFAULT}"
assert_contains "liveness on /healthz for server" "path: /healthz" "${DEFAULT}"
assert_contains "readiness on /readyz for server" "path: /readyz" "${DEFAULT}"
assert_contains "embeddings startup probe present" "startupProbe:" "${DEFAULT}"
assert_contains "server memory limit 1024Mi" "memory: 1024Mi" "${DEFAULT}"
assert_contains "ui memory limit 512Mi" "memory: 512Mi" "${DEFAULT}"
assert_contains "embeddings memory limit 3Gi (#786)" "memory: 3Gi" "${DEFAULT}"
assert_contains "image registry default ghcr.io" "image: ghcr.io/openzigs/metis-server" "${DEFAULT}"

# ---------------------------------------------------------------------------
echo "Test 3: the removed copilot toggle renders nothing (#150)"
# ---------------------------------------------------------------------------
COPILOT=$(template --set copilot.enabled=true)
assert "4× Deployment even with copilot.enabled=true" 4 "$(count_kind Deployment "${COPILOT}")"
assert "0× copilot resources even with copilot.enabled=true" 0 "$(echo "${COPILOT}" | grep -ciE 'copilot' || true)"

# ---------------------------------------------------------------------------
echo "Test 4: PVC story — sub-issue #367 (CRITICAL)"
# ---------------------------------------------------------------------------
PVC_RENDER=$(template)
# #60 — uploads + lancedb + the server's data directory (SQLite + repo extracts).
assert "3× PVC by default" 3 "$(count_kind PersistentVolumeClaim "${PVC_RENDER}")"
assert_contains "uploads PVC mounted at /app/server/data/uploads" "mountPath: /app/server/data/uploads" "${PVC_RENDER}"
assert_contains "lancedb PVC mounted at /app/server/data/lancedb" "mountPath: /app/server/data/lancedb" "${PVC_RENDER}"
assert_contains "uploads default 10Gi" 'storage: "10Gi"' "${PVC_RENDER}"
assert_contains "lancedb default 5Gi" 'storage: "5Gi"' "${PVC_RENDER}"
assert_contains "uploads default RWO" "ReadWriteOnce" "${PVC_RENDER}"
assert_contains "uploads default SC gp3" 'storageClassName: "gp3"' "${PVC_RENDER}"
assert_contains "Retain reclaim via helm.sh/resource-policy keep" '"helm.sh/resource-policy": "keep"' "${PVC_RENDER}"

EFS_RENDER=$(template --set persistence.efs.enabled=true)
assert_contains "EFS toggle switches to RWX" "ReadWriteMany" "${EFS_RENDER}"
assert_contains "EFS toggle switches SC to efs-sc" 'storageClassName: "efs-sc"' "${EFS_RENDER}"
assert_not_contains "EFS toggle drops RWO" "ReadWriteOnce" "${EFS_RENDER}"

NO_PERSIST=$(template --set persistence.enabled=false)
assert "0× PVC when disabled" 0 "$(count_kind PersistentVolumeClaim "${NO_PERSIST}")"
assert_contains "emptyDir fallback when disabled" "emptyDir: {}" "${NO_PERSIST}"

# ---------------------------------------------------------------------------
echo "Test 4b: Multi-replica scaling guard — issue #540 / epic #518"
# ---------------------------------------------------------------------------
# Default chart is multi-replica (server.replicaCount: 2) and renders cleanly
# (enforce: false → NOTES warns, render does not fail).
assert_contains "default server replicas: 2" "replicas: 2" "$(template)"

# With scaling.enforce=true, N>1 WITHOUT the shared backends must fail-closed.
if template --set scaling.enforce=true >/dev/null 2>&1; then
  echo "  ✗ enforce=true + replicas=2 w/o shared backends should fail but did not"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("scaling guard fail-closed")
else
  echo "  ✓ enforce=true + replicas=2 without shared backends fails-closed"
  PASS=$((PASS + 1))
fi

# Single replica with enforce=true renders fine (no shared backends required).
if template --set scaling.enforce=true --set server.replicaCount=1 >/dev/null 2>&1; then
  echo "  ✓ enforce=true + replicas=1 renders cleanly"
  PASS=$((PASS + 1))
else
  echo "  ✗ enforce=true + replicas=1 should render"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("single-replica enforce")
fi

# N>1 WITH all shared backends set renders cleanly even under enforce=true.
SCALED=$(template --set scaling.enforce=true \
  --set scaling.database.url=postgres://u:p@db:5432/metis \
  --set scaling.vectorStore=pgvector \
  --set scaling.rateLimitBackend=postgres \
  --set scaling.ssoStateBackend=postgres \
  --set scaling.leaderElection=postgres \
  --set uploads.backend=s3 --set uploads.s3.bucket=b --set uploads.s3.region=us-east-1)
if [[ -n "${SCALED}" ]] && ! echo "${SCALED}" | grep -qi "execution error"; then
  echo "  ✓ replicas=2 with all shared backends renders cleanly"
  PASS=$((PASS + 1))
else
  echo "  ✗ replicas=2 with all shared backends should render"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("scaled render")
fi
assert_contains "server env wires VECTOR_STORE=pgvector" "name: VECTOR_STORE" "${SCALED}"
assert_contains "server env VECTOR_STORE value pgvector" 'value: "pgvector"' "${SCALED}"
assert_contains "server env wires UPLOAD_STORAGE_BACKEND" "name: UPLOAD_STORAGE_BACKEND" "${SCALED}"
assert_contains "server env UPLOAD_S3_BUCKET" "name: UPLOAD_S3_BUCKET" "${SCALED}"
assert_contains "server env DISCUSSION_RATE_LIMIT_BACKEND" "name: DISCUSSION_RATE_LIMIT_BACKEND" "${SCALED}"
assert_contains "server env SSO_STATE_BACKEND" "name: SSO_STATE_BACKEND" "${SCALED}"
assert_contains "server env SCHEDULER_LEADER_ELECTION" "name: SCHEDULER_LEADER_ELECTION" "${SCALED}"
assert_contains "server uses RollingUpdate when N>1" "type: RollingUpdate" "${SCALED}"
# Scaling env must NOT leak into the ui deployment (server-only).
UI_BLOCK=$(echo "${SCALED}" | awk '/name: metis-ui$/,/name: metis-embeddings$/')
assert_not_contains "ui deployment has no VECTOR_STORE" "name: VECTOR_STORE" "${UI_BLOCK}"

# EFS still works as an orthogonal RWX toggle.
EFS_RENDER2=$(template --set persistence.efs.enabled=true)
assert_contains "EFS toggle still switches to RWX" "ReadWriteMany" "${EFS_RENDER2}"

# ---------------------------------------------------------------------------
echo "Test 5: Secrets — sub-issue #368 (three modes)"
# ---------------------------------------------------------------------------
ESO=$(template --set externalSecrets.enabled=true)
assert "1× ExternalSecret when ESO enabled" 1 "$(count_kind ExternalSecret "${ESO}")"
assert "0× plain Secret when ESO enabled" 0 "$(count_kind Secret "${ESO}")"
assert_contains "ExternalSecret references aws-secrets-manager" "name: aws-secrets-manager" "${ESO}"
assert_contains "ExternalSecret remoteRef prefix metis/" "key: metis/JWT_SECRET" "${ESO}"

PLAIN=$(template --set secrets.create=true)
assert "1× plain Secret when create=true" 1 "$(count_kind Secret "${PLAIN}")"
assert_contains "empty placeholder annotation" "metis.io/empty-placeholder" "${PLAIN}"

PLAIN_VALUES=$(template --set secrets.create=true --set secrets.values.JWT_SECRET=devkey)
assert_contains "stringData populated when values provided" "JWT_SECRET: \"devkey\"" "${PLAIN_VALUES}"

BYO=$(template --set secrets.create=false --set secrets.existingSecret=my-secret)
assert "0× Secret in BYO mode" 0 "$(count_kind Secret "${BYO}")"
assert "0× ExternalSecret in BYO mode" 0 "$(count_kind ExternalSecret "${BYO}")"
assert_contains "deployments reference existing secret" "name: my-secret" "${BYO}"

# ---------------------------------------------------------------------------
echo "Test 6: Ingress — sub-issue #369 (three controllers)"
# ---------------------------------------------------------------------------
NO_INGRESS=$(template)
assert "0× Ingress by default" 0 "$(count_kind Ingress "${NO_INGRESS}")"

ALB=$(template --set ingress.enabled=true)
assert "1× Ingress (alb)" 1 "$(count_kind Ingress "${ALB}")"
assert_contains "alb scheme annotation" "alb.ingress.kubernetes.io/scheme" "${ALB}"
assert_contains "alb stickiness for websocket" "stickiness.enabled=true" "${ALB}"
assert_contains "/api route to server" "name: metis-server" "${ALB}"
assert_contains "/socket.io route" "path: /socket.io" "${ALB}"
assert_contains "/ route to ui" "name: metis-ui" "${ALB}"

NGINX=$(template --set ingress.enabled=true --set ingress.className=nginx --set ingress.tls.certManager.enabled=true)
assert_contains "nginx class set" "ingressClassName: nginx" "${NGINX}"
assert_contains "cert-manager annotation" "cert-manager.io/cluster-issuer" "${NGINX}"
assert_contains "websocket upgrade snippet" "proxy_set_header Upgrade" "${NGINX}"

TRAEFIK=$(template --set ingress.enabled=true --set ingress.className=traefik --set ingress.tls.certManager.enabled=true)
assert_contains "traefik class set" "ingressClassName: traefik" "${TRAEFIK}"
assert_contains "traefik websecure entrypoint" "router.entrypoints: websecure" "${TRAEFIK}"

# ---------------------------------------------------------------------------
echo "Test 7: RBAC + IRSA — sub-issue #370"
# ---------------------------------------------------------------------------
RBAC=$(template)
assert "1× Role by default (namespaced)" 1 "$(count_kind Role "${RBAC}")"
assert "1× RoleBinding" 1 "$(count_kind RoleBinding "${RBAC}")"
assert "0× ClusterRole when scope=namespaced" 0 "$(count_kind ClusterRole "${RBAC}")"
assert_contains "Role in metis-mcp namespace" "namespace: metis-mcp" "${RBAC}"
assert_contains "RBAC includes deployments" "resources: [deployments]" "${RBAC}"
assert_contains "RBAC includes networkpolicies" "resources: [networkpolicies]" "${RBAC}"

IRSA=$(template --set 'serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::123:role/metis')
assert_contains "IRSA role-arn annotation passed through" "arn:aws:iam::123:role/metis" "${IRSA}"

CLUSTER_RBAC=$(template --set rbac.scope=cluster)
assert "1× ClusterRole when scope=cluster" 1 "$(count_kind ClusterRole "${CLUSTER_RBAC}")"
assert "1× ClusterRoleBinding when scope=cluster" 1 "$(count_kind ClusterRoleBinding "${CLUSTER_RBAC}")"

NO_RBAC=$(template --set rbac.create=false)
assert "0× Role when rbac.create=false" 0 "$(count_kind Role "${NO_RBAC}")"

# ---------------------------------------------------------------------------
echo "Test 8: HPA + PDB + NetworkPolicy — sub-issue #371"
# ---------------------------------------------------------------------------
SCALING=$(template)
# Multi-replica default (#540): ui + server HPAs are both on by default.
assert "2× HPA (ui + server) by default" 2 "$(count_kind HorizontalPodAutoscaler "${SCALING}")"
assert_contains "ui HPA targets metis-ui" "name: metis-ui" "${SCALING}"
assert_contains "server HPA targets metis-server" "name: metis-server" "${SCALING}"
assert_contains "ui HPA min 2" "minReplicas: 2" "${SCALING}"
assert_contains "ui HPA max 10" "maxReplicas: 10" "${SCALING}"
assert_contains "ui HPA targetCPU 70" "averageUtilization: 70" "${SCALING}"

# #786: a PDB is only rendered when the replica floor EXCEEDS minAvailable.
# Default: ui=2 and server=2 (floor 2 > 1) render; embeddings=1 does NOT — a
# minAvailable:1 PDB over a single pod would block every node drain forever.
assert "PDBs rendered (ui + server; embeddings has 1 replica)" 2 "$(count_kind PodDisruptionBudget "${SCALING}")"
NETPOL=$(template)
assert "1× NetworkPolicy by default" 1 "$(count_kind NetworkPolicy "${NETPOL}")"
assert_contains "deny-default policyTypes" "policyTypes: [Ingress, Egress]" "${NETPOL}"
assert_contains "DNS egress allowed" "k8s-app: kube-dns" "${NETPOL}"
assert_contains "intra-namespace egress" "app.kubernetes.io/part-of: metis" "${NETPOL}"

CILIUM=$(template --set networkPolicy.cilium.enabled=true)
assert "0× vanilla NetworkPolicy when cilium" 0 "$(count_kind NetworkPolicy "${CILIUM}")"
assert "1× CiliumNetworkPolicy" 1 "$(count_kind CiliumNetworkPolicy "${CILIUM}")"
assert_contains "FQDN egress to api.openai.com" "matchName: \"api.openai.com\"" "${CILIUM}"
assert_contains "FQDN egress to api.github.com" "matchName: \"api.github.com\"" "${CILIUM}"

# ---------------------------------------------------------------------------
echo "Test 9: Profile renders — values-dev + values-prod"
# ---------------------------------------------------------------------------
DEV=$(template -f "${CHART_DIR}/values-dev.yaml")
assert_contains "dev: secrets.create=true" "kind: Secret" "${DEV}"
assert "dev: 0 NetworkPolicy" 0 "$(count_kind NetworkPolicy "${DEV}")"
assert "dev: 0 HPA" 0 "$(count_kind HorizontalPodAutoscaler "${DEV}")"

PROD=$(template -f "${CHART_DIR}/values-prod.yaml")
assert "prod: 1 ExternalSecret" 1 "$(count_kind ExternalSecret "${PROD}")"
assert "prod: 1 Ingress" 1 "$(count_kind Ingress "${PROD}")"
assert "prod: 1 NetworkPolicy" 1 "$(count_kind NetworkPolicy "${PROD}")"
assert_contains "prod IRSA annotation present" "eks.amazonaws.com/role-arn" "${PROD}"
# Multi-replica server + shared backends wired (#540).
assert_contains "prod: server replicas 2" "replicas: 2" "${PROD}"
assert "prod: 2 HPA (ui + server)" 2 "$(count_kind HorizontalPodAutoscaler "${PROD}")"
assert_contains "prod: VECTOR_STORE=pgvector wired" 'value: "pgvector"' "${PROD}"
assert_contains "prod: SCHEDULER_LEADER_ELECTION=postgres wired" 'value: "postgres"' "${PROD}"
assert_contains "prod: UPLOAD_STORAGE_BACKEND=s3 wired" "name: UPLOAD_STORAGE_BACKEND" "${PROD}"
assert_contains "prod: server uses RollingUpdate" "type: RollingUpdate" "${PROD}"
# Epic #70 — DR lag budget wired from disasterRecovery.maxReplicationLagSeconds.
assert_contains "prod: DR_MAX_REPLICATION_LAG_SECONDS wired" "name: DR_MAX_REPLICATION_LAG_SECONDS" "${PROD}"
assert_contains "prod: DR lag value 300" 'value: "300"' "${PROD}"
# dev profile pins a single server replica.
assert_contains "dev: server replicas 1" "replicas: 1" "${DEV}"

# ---------------------------------------------------------------------------
echo "Test 10: Disaster Recovery — Epic #70 (#72 DR lag env)"
# ---------------------------------------------------------------------------
# Empty disasterRecovery keys emit no env (server keeps its 600s default).
assert_not_contains "default: no DR_MAX_REPLICATION_LAG_SECONDS env" \
  "DR_MAX_REPLICATION_LAG_SECONDS" "${DEFAULT}"
DR_SET=$(template --set disasterRecovery.maxReplicationLagSeconds=120)
assert_contains "override: DR lag env wired" "name: DR_MAX_REPLICATION_LAG_SECONDS" "${DR_SET}"
assert_contains "override: DR lag value 120" 'value: "120"' "${DR_SET}"

# ---------------------------------------------------------------------------
echo "Test 11: Embeddings sidecar EKS hardening — issue #786"
# ---------------------------------------------------------------------------
# Isolate the embeddings Deployment so an assertion cannot be satisfied by some
# other component's spec (every one of these strings exists elsewhere too).
EMB=$(echo "${DEFAULT}" | awk '/^  name: metis-embeddings$/,/^---$/')

# -- Probes. The whole failure story depends on WHICH path each probe hits.
assert_contains "embeddings readiness on /readyz" "path: /readyz" "${EMB}"
assert_contains "embeddings liveness on /healthz" "path: /healthz" "${EMB}"
# startupProbe must gate on WARMTH (/readyz), not on the port being open:
# it is the only thing that suppresses liveness during a slow ONNX load.
STARTUP_PATH=$(awk '/path:/ {print $2; exit}' <<<"$(grep -A3 'startupProbe:' <<<"${EMB}" || true)")
assert "embeddings startupProbe gates on /readyz (not /healthz)" "/readyz" "${STARTUP_PATH}"
# ... and liveness must NOT: a model that cannot load is permanent, and answering
# liveness with "is the model warm?" turns a stalled rollout into a crash-loop.
LIVENESS_PATH=$(awk '/path:/ {print $2; exit}' <<<"$(grep -A3 'livenessProbe:' <<<"${EMB}" || true)")
assert "embeddings livenessProbe is /healthz (NEVER /readyz)" "/healthz" "${LIVENESS_PATH}"
# -- Rollout safety: fail the rollout, never drain a warm pod for a cold one.
assert_contains "embeddings surges before draining (maxUnavailable 0)" "maxUnavailable: 0" "${EMB}"
assert_contains "embeddings maxSurge 1" "maxSurge: 1" "${EMB}"

# ---------------------------------------------------------------------------
# THE PROBE-BUDGET INVARIANT — asserted for EVERY profile, from that profile's
# OWN rendered values.
#
#   startup budget  = initialDelaySeconds + periodSeconds × failureThreshold
#                     (when kubelet gives up and RESTARTS the container)
#   progress deadline = progressDeadlineSeconds
#                     (when the Deployment reports ProgressDeadlineExceeded)
#
# The deadline MUST fire first:  budget > deadline.
#
# If it does not, a model that can never load (weights not baked, a typo'd
# EMBED_MODEL) is killed by kubelet before the rollout is ever declared failed —
# i.e. a CrashLoopBackOff that buries the one log line explaining it. That is
# precisely the outcome `readiness.ts` declines to exit(1) in order to avoid, and
# no amount of care in the process can survive kubelet restarting it.
#
# This is deliberately computed PER PROFILE and compared against each profile's
# own rendered deadline — never against a hard-coded constant. The earlier
# version of this test derived the budget from the DEFAULT render only and
# compared it to a literal `600`, which is exactly why values-dev.yaml shipped
# with the inequality INVERTED (a 305 s budget under a 600 s deadline): the
# assertion passed while the profile it was supposed to protect was broken.
#
# NB: the deadline clock starts at rollout, which is EARLIER than the container's
# probe clock (it also covers scheduling and the image pull), so real-world slack
# is larger than the arithmetic here. Requiring it on the probe clock alone is
# the conservative form.
#
# NB2: read values with here-strings, not `echo | grep` — a non-matching grep in
# a pipeline aborts the whole script under `set -o pipefail`.
# ---------------------------------------------------------------------------
assert_probe_budget_invariant() {
  local profile="$1"
  local rendered="$2"

  # Isolate the embeddings DEPLOYMENT document. Splitting on the YAML document
  # separator matters: `metis-embeddings` also names a Service and (at >1
  # replica) a PDB, and the server Deployment merely *mentions* the string via
  # EMBEDDINGS_URL. Only the real Deployment carries progressDeadlineSeconds.
  local doc
  doc=$(awk 'BEGIN { RS = "\n---\n" } /kind: Deployment/ && /\n  name: metis-embeddings\n/ { print }' <<<"${rendered}")
  if [[ -z "${doc}" ]]; then
    printf "  ✗ %s: no embeddings Deployment rendered — cannot check the probe invariant\n" "${profile}"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("${profile}: embeddings Deployment missing")
    return
  fi

  local startup_block period thresh delay deadline budget
  startup_block=$(grep -A8 'startupProbe:' <<<"${doc}" || true)
  period=$(awk '/periodSeconds:/ { print $2; exit }' <<<"${startup_block}")
  thresh=$(awk '/failureThreshold:/ { print $2; exit }' <<<"${startup_block}")
  delay=$(awk '/initialDelaySeconds:/ { print $2; exit }' <<<"${startup_block}")
  deadline=$(awk '/^  progressDeadlineSeconds:/ { print $2; exit }' <<<"${doc}")

  if [[ -z "${period}" || -z "${thresh}" || -z "${deadline}" ]]; then
    printf "  ✗ %s: could not read startupProbe timings / progressDeadlineSeconds\n" "${profile}"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("${profile}: probe timings unreadable")
    return
  fi

  budget=$(( ${delay:-0} + period * thresh ))
  if [[ ${budget} -gt ${deadline} ]]; then
    printf "  ✓ %s: startup budget %ss (%s + %s×%s) outlasts progressDeadlineSeconds %ss\n" \
      "${profile}" "${budget}" "${delay:-0}" "${period}" "${thresh}" "${deadline}"
    PASS=$((PASS + 1))
  else
    printf "  ✗ %s: startup budget %ss (%s + %s×%s) must EXCEED progressDeadlineSeconds %ss — kubelet would restart the container %ss before the rollout is declared failed (CrashLoopBackOff instead of a stalled rollout)\n" \
      "${profile}" "${budget}" "${delay:-0}" "${period}" "${thresh}" "${deadline}" "$(( deadline - budget ))"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("${profile}: startup budget vs progressDeadlineSeconds")
  fi
}

DEV_RENDER=$(template -f "${CHART_DIR}/values-dev.yaml")
PROD_RENDER=$(template -f "${CHART_DIR}/values-prod.yaml")
assert_probe_budget_invariant "default profile" "${DEFAULT}"
assert_probe_budget_invariant "values-dev.yaml" "${DEV_RENDER}"
assert_probe_budget_invariant "values-prod.yaml" "${PROD_RENDER}"

# A budget floor on top of the invariant: whatever the deadline is, the default
# profile must tolerate a first-ever image pull onto a cold node plus the ONNX
# graph build on a CPU throttled to its request.
DEFAULT_STARTUP=$(grep -A8 'startupProbe:' <<<"${EMB}" || true)
DEFAULT_BUDGET=$(( $(awk '/initialDelaySeconds:/ { print $2; exit }' <<<"${DEFAULT_STARTUP}") \
  + $(awk '/periodSeconds:/ { print $2; exit }' <<<"${DEFAULT_STARTUP}") \
  * $(awk '/failureThreshold:/ { print $2; exit }' <<<"${DEFAULT_STARTUP}") ))
if [[ ${DEFAULT_BUDGET} -ge 600 ]]; then
  echo "  ✓ default embeddings startup budget ${DEFAULT_BUDGET}s (>= 600s)"
  PASS=$((PASS + 1))
else
  echo "  ✗ default embeddings startup budget ${DEFAULT_BUDGET}s is under 600s"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("embeddings startup budget")
fi

# -- Arch guard: onnxruntime-node ships glibc x64/arm64 prebuilts and nothing else.
assert_contains "embeddings pinned to arches onnxruntime-node ships" "kubernetes.io/arch" "${EMB}"
assert_contains "embeddings allows amd64" "- amd64" "${EMB}"
assert_contains "embeddings allows arm64 (Graviton)" "- arm64" "${EMB}"
assert_contains "embeddings pinned to linux" "kubernetes.io/os" "${EMB}"
# The arch constraint is the SIDECAR's, not the whole chart's.
UI_ONLY=$(echo "${DEFAULT}" | awk '/^  name: metis-ui$/,/^---$/')
assert_not_contains "arch affinity does not leak into the ui deployment" "kubernetes.io/arch" "${UI_ONLY}"

# -- Model env: empty keys must NOT be emitted, or they blank the image's baked
# defaults (HF_HUB_OFFLINE=1 + EMBED_MODEL/EMBED_DTYPE) and the pod cannot boot.
assert_not_contains "empty EMBED_MODEL is not emitted" "name: EMBED_MODEL" "${EMB}"
assert_not_contains "empty EMBED_DTYPE is not emitted" "name: EMBED_DTYPE" "${EMB}"
assert_not_contains "empty HF_HUB_OFFLINE is not emitted" "name: HF_HUB_OFFLINE" "${EMB}"
# ...but setting one DOES reach the pod.
EMB_SET=$(template --set embeddings.env.EMBED_DTYPE=fp32 | awk '/^  name: metis-embeddings$/,/^---$/')
assert_contains "an explicitly-set EMBED_DTYPE IS emitted" "name: EMBED_DTYPE" "${EMB_SET}"
assert_contains "EMBED_DTYPE value passed through" 'value: "fp32"' "${EMB_SET}"

# ---------------------------------------------------------------------------
# THE ARENA-RATCHET INVARIANT — requests must reflect the WARM working set.
#
# ONNX Runtime's BFC arena does not return memory to the OS: once a real batch
# has inflated it, RSS stays near that high-water mark for the pod's whole life.
# So `requests` sized from the ~570 MiB COLD resident floor makes the sidecar the
# most-evictable pod on the node (kubelet ranks Burstable pods by usage above
# request) while the scheduler packs the node as if it were small.
#
# Rule enforced here: memory requests ≥ limits/2 on every profile. requests ==
# limits (Guaranteed QoS, evicted last, never CPU-throttled to the request) is
# additionally required of prod.
# ---------------------------------------------------------------------------
emb_deployment() {
  awk 'BEGIN { RS = "\n---\n" } /kind: Deployment/ && /\n  name: metis-embeddings\n/ { print }' <<<"$1"
}

# Read one number out of the embeddings container's resources block.
# $1 = embeddings Deployment doc, $2 = limits|requests, $3 = cpu|memory
emb_resource() {
  awk -v want_sect="$2" -v want_key="$3" '
    /^          resources:$/            { in_res = 1; next }
    in_res && /^            [a-z]+:$/   { sect = $1; sub(":", "", sect); next }
    in_res && /^              [a-z]+:/  {
      key = $1; sub(":", "", key)
      val = $2; gsub("\"", "", val)
      if (sect == want_sect && key == want_key) { print val; exit }
      next
    }
    in_res && /^          [a-z]/        { exit }
  ' <<<"$1"
}

# Ki/Mi/Gi (and bare bytes) → MiB. Kubernetes quantities, not SI.
mem_to_mib() {
  local q="$1"
  case "${q}" in
    *Gi) echo $(( ${q%Gi} * 1024 )) ;;
    *Mi) echo "${q%Mi}" ;;
    *Ki) echo $(( ${q%Ki} / 1024 )) ;;
    *)   echo $(( q / 1024 / 1024 )) ;;
  esac
}

assert_request_ratio() {
  local profile="$1" doc="$2" require_guaranteed="$3"
  local req lim req_mib lim_mib req_cpu lim_cpu
  req=$(emb_resource "${doc}" requests memory)
  lim=$(emb_resource "${doc}" limits memory)
  req_cpu=$(emb_resource "${doc}" requests cpu)
  lim_cpu=$(emb_resource "${doc}" limits cpu)
  req_mib=$(mem_to_mib "${req}")
  lim_mib=$(mem_to_mib "${lim}")

  # requests ≥ limits/2 — the arena ratchets, so the cold floor is not the floor.
  if (( req_mib * 2 >= lim_mib )); then
    printf "  ✓ %s: embeddings memory request %s ≥ half its %s limit (arena-ratchet rule)\n" \
      "${profile}" "${req}" "${lim}"
    PASS=$((PASS + 1))
  else
    printf "  ✗ %s: embeddings memory request %s is under half its %s limit — the ONNX arena never shrinks, so this pod becomes the most evictable one on the node\n" \
      "${profile}" "${req}" "${lim}"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("${profile}: embeddings request/limit ratio")
  fi

  if [[ "${require_guaranteed}" == "guaranteed" ]]; then
    if [[ "${req}" == "${lim}" && "${req_cpu}" == "${lim_cpu}" ]]; then
      printf "  ✓ %s: embeddings is Guaranteed QoS (requests == limits: %s / %s)\n" \
        "${profile}" "${req}" "${req_cpu}"
      PASS=$((PASS + 1))
    else
      printf "  ✗ %s: embeddings must be Guaranteed QoS (requests == limits); got req %s/%s vs lim %s/%s\n" \
        "${profile}" "${req}" "${req_cpu}" "${lim}" "${lim_cpu}"
      FAIL=$((FAIL + 1))
      FAILED_TESTS+=("${profile}: embeddings QoS class")
    fi
  fi
}

DEFAULT_EMB_DEP=$(emb_deployment "${DEFAULT}")
DEV_EMB_DEP=$(emb_deployment "${DEV_RENDER}")
PROD_EMB_DEP=$(emb_deployment "${PROD_RENDER}")
assert_request_ratio "default profile" "${DEFAULT_EMB_DEP}" burstable
assert_request_ratio "values-dev.yaml" "${DEV_EMB_DEP}" burstable
assert_request_ratio "values-prod.yaml" "${PROD_EMB_DEP}" guaranteed

# The CPU request is the number that decides whether a batch beats
# EMBEDDINGS_TIMEOUT_MS: under contention CFS throttles toward the REQUEST, and a
# realistic 64-chunk batch is ~46 CPU-seconds (11.5 s measured for one
# 8192-token row; METIS chunks are ~1/16 of that context). At 250m that is ~184 s
# of wall clock against a 120 s client timeout — a timeout, on a pod nowhere near
# its memory limit. Floor the default at 1000m (~46 s wall, ~2.6× headroom).
DEFAULT_CPU_REQ=$(emb_resource "${DEFAULT_EMB_DEP}" requests cpu)
assert "default: embeddings CPU request 1000m (beats EMBEDDINGS_TIMEOUT_MS on a contended node)" \
  "1000m" "${DEFAULT_CPU_REQ}"

# -- PDB / replicas. Single replica + minAvailable:1 = an undrainable node, so the
# chart renders no PDB at all there; prod runs 2 replicas and gets a real one.
assert "prod: 3 PDBs (ui + server + embeddings@2 replicas)" 3 "$(count_kind PodDisruptionBudget "${PROD_RENDER}")"
PROD_EMB=$(echo "${PROD_RENDER}" | awk '/^  name: metis-embeddings$/,/^---$/')
assert_contains "prod: embeddings runs 2 replicas" "replicas: 2" "${PROD_EMB}"
assert_contains "prod: embeddings limit 3Gi" "memory: 3Gi" "${PROD_EMB}"
# An operator who scales embeddings back to 1 must not thereby wedge node drains.
SINGLE=$(template --set embeddings.replicaCount=1 --set pdb.embeddings.minAvailable=1)
assert "single-replica embeddings renders NO embeddings PDB" 2 "$(count_kind PodDisruptionBudget "${SINGLE}")"

# -- Dev profile must not sit below the sidecar's measured resident floor (~570 MiB).
DEV_EMB=$(echo "${DEV_RENDER}" | awk '/^  name: metis-embeddings$/,/^---$/')
assert_contains "dev: embeddings limit raised to 1792Mi" "memory: 1792Mi" "${DEV_EMB}"
assert_contains "dev: embeddings still probes /readyz" "path: /readyz" "${DEV_EMB}"

# -- The image the pod runs is the BAKED one (#784) — air-gap needs no HF egress.
assert_contains "embeddings uses the baked sidecar image" \
  "image: ghcr.io/openzigs/metis-embeddings-svc" "${EMB}"

# ---------------------------------------------------------------------------
echo "Test 12: the DEFAULT values can start — issue #60"
# ---------------------------------------------------------------------------
# The chart makes the root filesystem read-only, and with no DATABASE_URL the server
# runs on SQLite, whose file must be creatable. The image puts it in
# /app/server/data (Dockerfile.server `ENV DATABASE_URL`), and the server also writes
# its home directory (~/.metis-sessions) and data/repo-{extracts,archives}. So the
# server pod must mount a WRITABLE volume at each. The CI image smoke runs the image
# under exactly these mounts (scripts/lib/smoke-server-image.mjs `helm-default`, the
# list is HELM_DEFAULT_WRITABLE_PATHS); image-build-wiring.test.mjs keeps them equal.
server_deployment() {
  echo "$1" | awk '/^kind: Deployment$/{d=1} /^---$/{d=0; s=0} d && /^  name: metis-server$/{s=1} s'
}
DEF_SERVER=$(server_deployment "${DEFAULT}")
assert_contains "default: server root filesystem is read-only" "readOnlyRootFilesystem: true" "${DEF_SERVER}"
for p in /tmp /home/metis /app/server/data /app/server/data/uploads /app/server/data/lancedb; do
  assert_contains "default: server mounts a writable volume at ${p}" "mountPath: ${p}"$'\n' "${DEF_SERVER}"$'\n'
done
assert_contains "default: data dir is a PVC" "claimName: metis-server-data" "${DEF_SERVER}"
assert_contains "default: data PVC rendered" "name: metis-server-data" "${DEFAULT}"
# The data volume mounts BEFORE the uploads/lancedb volumes nested inside it.
DATA_LINE=$(echo "${DEF_SERVER}" | grep -n "mountPath: /app/server/data$" | cut -d: -f1)
UPLOADS_LINE=$(echo "${DEF_SERVER}" | grep -n "mountPath: /app/server/data/uploads$" | cut -d: -f1)
assert "default: data volume listed before the volumes nested in it" "yes" \
  "$([[ -n "${DATA_LINE}" && -n "${UPLOADS_LINE}" && ${DATA_LINE} -lt ${UPLOADS_LINE} ]] && echo yes || echo no)"
# No plain DATABASE_URL: the image default applies unless the Secret supplies one.
assert_not_contains "default: no inline DATABASE_URL value" "name: DATABASE_URL"$'\n'"              value:" "${DEF_SERVER}"

NO_PERSIST_SERVER=$(server_deployment "${NO_PERSIST}")
assert_contains "persistence off: data dir still writable (emptyDir)" "mountPath: /app/server/data"$'\n' "${NO_PERSIST_SERVER}"$'\n'
assert_not_contains "persistence off: no data PVC" "claimName: metis-server-data" "${NO_PERSIST_SERVER}"

PROD_SERVER=$(server_deployment "${PROD_RENDER}")
assert_contains "prod: data dir still writable" "mountPath: /app/server/data"$'\n' "${PROD_SERVER}"$'\n'
assert_not_contains "prod: no RWO data PVC (Postgres + S3 + pgvector)" "claimName: metis-server-data" "${PROD_SERVER}"
assert_not_contains "prod: data PVC not rendered" "name: metis-server-data" "${PROD_RENDER}"

EFS_DATA=$(template --set persistence.efs.enabled=true | awk '/^  name: metis-server-data$/,/^---$/')
assert_contains "EFS toggle moves the data PVC to efs-sc too" 'storageClassName: "efs-sc"' "${EFS_DATA}"

# ---------------------------------------------------------------------------
echo
if [[ ${FAIL} -eq 0 ]]; then
  printf "All %d assertions passed.\n" "${PASS}"
  exit 0
else
  printf "%d passed, %d failed:\n" "${PASS}" "${FAIL}"
  for t in "${FAILED_TESTS[@]}"; do
    printf "  - %s\n" "${t}"
  done
  exit 1
fi
