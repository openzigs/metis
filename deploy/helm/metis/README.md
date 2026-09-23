# METIS Helm chart

> Production Helm chart for [METIS](https://github.com/openzigs/metis) on
> Kubernetes — server, ui, embeddings, and (toggle) copilot, with PVCs,
> Secrets, Ingress, RBAC/IRSA, HPA, PDB, and NetworkPolicy.

**Chart version**: 0.1.0 · **App version**: 0.1.0 · **Kubernetes**: ≥1.27

```bash
# Add repo (when published to GHCR OCI):
helm install metis oci://ghcr.io/openzigs/charts/metis --version 0.1.0 \
  --namespace metis --create-namespace \
  -f my-values.yaml
```

For a local checkout:

```bash
helm install metis ./deploy/helm/metis \
  -f deploy/helm/metis/values-prod.yaml \
  --namespace metis --create-namespace
```

---

## Quick reference

| Sub-issue | Capability |
|----------:|------------|
| #366 | Chart skeleton — Deployments, Services, ConfigMap, ServiceAccount |
| #367 | **PVCs** — `data/uploads` + `data/lancedb` (EBS gp3 RWO default, EFS RWX toggle) |
| #368 | Secrets — External Secrets Operator OR plain `Secret` OR BYO |
| #369 | Ingress — alb \| nginx \| traefik switch with TLS via cert-manager / ACM |
| #370 | RBAC + IRSA — METIS pod SA + `metis-mcp` namespace permissions |
| #371 | HPA + PDB + NetworkPolicy — deny-default with FQDN egress (Cilium) |
| #373 | Multi-arch CI — amd64 + arm64 GHCR push for the four core images |

## Profiles

| File | When to use |
|------|------------|
| `values.yaml` | Defaults; safe for `helm lint` + `helm template` |
| `values-dev.yaml` | kind / k3d / minikube (small resources, no ingress, no NetPol) |
| `values-prod.yaml` | EKS production (ALB ingress, ESO secrets, IRSA, HPA, PDB, NetPol) |

---

## Critical: persistence

Without bound PVCs, **every server pod restart wipes uploads + the entire
LanceDB vector store**. The chart binds three PVCs by default:

| PVC | Mount | Default size | Default SC | Access |
|-----|-------|-------------:|------------|--------|
| `<release>-server-data` | `/app/server/data` | 5Gi | `gp3` | RWO |
| `<release>-server-uploads` | `/app/server/data/uploads` | 10Gi | `gp3` | RWO |
| `<release>-server-lancedb` | `/app/server/data/lancedb` | 5Gi | `gp3` | RWO |

The server's root filesystem is read-only, so it can write only where a volume is
mounted (#60). `<release>-server-data` holds the SQLite database when no
`DATABASE_URL` is supplied — the image's default is
`file:/app/server/data/metis.db` — and repository archive extracts; the server's
home directory (`/home/metis`) is an `emptyDir`. With a Postgres `DATABASE_URL`, set
`persistence.data.enabled=false` (as `values-prod.yaml` does) to keep the data
directory on an `emptyDir` instead of a `ReadWriteOnce` PVC.

**Reclaim policy** is `Retain` by default — the PVC survives `helm uninstall`
via `helm.sh/resource-policy: keep`. To switch to multi-replica RWX:

```bash
helm install metis ./deploy/helm/metis \
  --set persistence.efs.enabled=true \
  --set server.replicaCount=2
```

The chart **fails-closed** when `server.replicaCount > 1` without
`persistence.efs.enabled=true` — LanceDB and the in-process scheduler are
still single-writer. That gate exists to keep an over-eager operator from
silently corrupting the vector store.

To run with no persistence (CI / scratch namespaces only):

```bash
helm install metis ./deploy/helm/metis --set persistence.enabled=false
```

This swaps the PVC mounts to `emptyDir` and prints no warning at the
template level — own the data-loss consequences.

---

## Secrets — three modes

The chart **never** inlines plaintext secrets. Pick one of:

### 1. External Secrets Operator (recommended on EKS)

```yaml
externalSecrets:
  enabled: true
  secretStoreName: aws-secrets-manager
  secretStoreKind: ClusterSecretStore
  refreshInterval: 1h
  remoteRefPrefix: metis/
```

Requires [External Secrets Operator](https://external-secrets.io/) and a
`SecretStore`/`ClusterSecretStore` named `aws-secrets-manager`. The chart
emits an `ExternalSecret` that projects each key under the `metis/*` prefix
into a Secret named `<release>-secrets`.

### 2. Plain `Secret` (air-gapped / GitOps with Sealed Secrets)

```yaml
secrets:
  create: true
  values: {}    # leave empty in prod — kubectl edit afterward
```

Renders an empty `Opaque` Secret with an annotation telling the operator to
`kubectl edit secret metis-secrets -n metis` and fill in values.
Setting `secrets.values.JWT_SECRET=...` is **only** acceptable in dev /
test profiles (see `values-dev.yaml`).

### 3. Bring-your-own Secret

```yaml
secrets:
  create: false
  existingSecret: my-team-managed-secret
```

The chart references the named Secret but renders nothing.

### Required keys

`JWT_SECRET`, `VAULT_MASTER_KEY`, `EMBEDDINGS_TOKEN`, `COPILOT_NATIVE_TOKEN`,
`DATABASE_URL`, `OPENAI_API_KEY` (or equivalent AI provider), `GITHUB_TOKEN`,
`METRICS_TOKEN`. Override the env-var → secret-key mapping under
`secrets.keyMap` if your AWS Secrets Manager naming is different.

---

## Ingress

```yaml
ingress:
  enabled: true
  className: alb        # alb | nginx | traefik
  host: metis.example.com
```

| Controller | TLS source | WebSocket handling |
|------------|------------|-------------------|
| `alb` | ACM cert ARN via `ingress.alb.certificateArn` | ALB target-group stickiness (1h cookie) |
| `nginx` | cert-manager (`ingress.tls.certManager.enabled`) | `proxy_set_header Upgrade` snippet |
| `traefik` | cert-manager | `traefik.ingress.kubernetes.io/router.entrypoints: websecure` |

Routes:

| Path | Backend | Port |
|------|---------|------|
| `/api` | `<release>-server` | 4000 |
| `/socket.io` | `<release>-server` | 4000 (websocket) |
| `/` | `<release>-ui` | 3000 |

For a BYO TLS Secret instead of cert-manager, set
`ingress.tls.secretName: my-tls`.

---

## ServiceAccount + RBAC + IRSA

Two distinct permission scopes:

1. **k8s RBAC** — METIS server pod can create/manage Deployments, Services,
   NetworkPolicies, ServiceAccounts inside `metis-mcp` (or `cluster` scope).
   Required for `runtime: 'k8s-sse'` MCPs (Epic #272).
2. **AWS IRSA** — METIS server (and ESO, when enabled) can call
   `secretsmanager:GetSecretValue` on `metis/*` ARNs.

```yaml
serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::ACCT:role/metis-server
rbac:
  create: true
  scope: namespaced       # namespaced | cluster
  mcpNamespace: metis-mcp
```

Recipe:

```bash
eksctl create iamserviceaccount \
  --name metis-server --namespace metis \
  --cluster prod --attach-policy-arn arn:aws:iam::ACCT:policy/MetisServerPolicy \
  --approve
```

---

## HPA / PDB / NetworkPolicy

- **HPA** — `ui` scales 2→10 on 70% CPU by default. `server` HPA template
  exists but defaults to `enabled: false` because LanceDB + scheduler +
  Socket.IO are still single-writer (see persistence section above).
- **PDB** — `minAvailable: 1` for `ui`, `server` and `embeddings`, but a budget
  is only **rendered when the component's replica floor exceeds it** (#786).
  `minAvailable: 1` over a *single* replica is an undrainable node: `kubectl
  drain` — and therefore every managed-node-group upgrade, Karpenter
  consolidation and spot reclaim — would block forever waiting for a disruption
  the budget can never allow. So the values express the intent and the template
  refuses to emit a budget that could not be satisfied. Default render: 2 PDBs
  (ui, server); `values-prod.yaml` runs 2 embeddings replicas and gets 3. The
  floor is the HPA's `minReplicas` when autoscaling is on, else `replicaCount`.
- **Embeddings HPA** — off by default; CPU is the right signal but each replica
  carries a ~570 MiB resident ONNX session and a cold start. See
  [`docs/EMBEDDINGS_BACKENDS.md`](../../../docs/EMBEDDINGS_BACKENDS.md)
  § "Running the sidecar on Kubernetes / EKS".
- **NetworkPolicy** — deny-default ingress + deny-default egress with
  explicit allow-list:
  - **Ingress**: from `ingress-nginx` namespace + intra-namespace.
  - **Egress**: kube-dns, intra-namespace, port 443 to all (collapsed when
    no FQDN-aware CNI). Set `networkPolicy.cilium.enabled=true` to switch
    to a `CiliumNetworkPolicy` with FQDN-scoped egress for the AI gateway
    + GitHub host allowlist.

Add managed-DB egress (RDS) via:

```yaml
networkPolicy:
  egress:
    databaseCidrs:
      - 10.0.10.0/24
      - 10.0.11.0/24
```

---

## Multi-replica (horizontal scaling)

`server.replicaCount: 2` is the default. Multi-replica is now supported because
every formerly per-pod stateful dependency has a shared, replica-safe backend
(epic #518). For a **correct** N>1 deployment, point the server at the shared
backends via the `scaling` and `uploads` value blocks:

| Value | Server env | Why it's needed for N>1 |
|-------|-----------|--------------------------|
| `scaling.database.url` (or `DATABASE_URL` secret) | `DATABASE_URL` (postgres://…) | Selects the Postgres Prisma adapter (#539). Without it the server uses embedded SQLite on an RWO PVC — single-replica only. |
| `scaling.vectorStore: pgvector` | `VECTOR_STORE` | RAG vectors in a shared `rag_vectors` Postgres table (#543). Embedded LanceDB is **not** N>1 safe (write divergence corrupts the index). |
| `uploads.backend: s3` + `uploads.s3.*` | `UPLOAD_STORAGE_BACKEND`, `UPLOAD_S3_*` | Uploaded blobs in S3 (#546), shared by every replica. An RWO PVC is single-node. |
| `scaling.rateLimitBackend: postgres` | `DISCUSSION_RATE_LIMIT_BACKEND` | Rate-limit cap holds across replicas (#541). |
| `scaling.ssoStateBackend: postgres` | `SSO_STATE_BACKEND` | OIDC/SAML handshake survives a callback landing on a different replica (#542). |
| `scaling.leaderElection: postgres` | `SCHEDULER_LEADER_ELECTION` | In-process cron + interval jobs run on exactly one replica via a Postgres lease (#544). |

The chart's scaling guard (`metis.assertScalingBackends`) replaces the old
single-writer `assertPersistenceTopology` block. When `scaling.enforce: true`
(set in `values-prod.yaml`) it fails `helm template/install` if `replicaCount > 1`
without a Postgres `DATABASE_URL`, `vectorStore: pgvector`, and `uploads.backend: s3`.
The chart default is `enforce: false` so a bare `helm install` renders cleanly;
the rendered `NOTES.txt` still **warns** when N>1 lacks the shared backends.

Use `values-prod.yaml` for a ready-made multi-replica profile, and see
[`docs/EKS_DEPLOYMENT.md`](../../../docs/EKS_DEPLOYMENT.md) §9b–§9f for the
provider-side setup (RDS Postgres + pgvector extension, S3 bucket + IRSA policy).
`persistence.efs.enabled` is no longer required for N>1 — it remains only as an
orthogonal RWX option if you deliberately keep uploads/LanceDB on a filesystem.

---

## Disaster Recovery (Epic #70)

The `disasterRecovery` value block carries cross-region DR knobs. The chart does
**not** provision replication — the Postgres standby is an RDS/Aurora
cross-Region read replica and uploads use S3 Cross-Region Replication, both set
up operator-side (see [`docs/EKS_DEPLOYMENT.md`](../../../docs/EKS_DEPLOYMENT.md)
§10). Because Postgres also hosts the pgvector store (#543), one streaming stream
covers **both** application data and RAG vectors.

| Value | Server env | Purpose |
|-------|-----------|---------|
| `disasterRecovery.region` | — (label/NOTES only) | Active/primary region this release runs in. |
| `disasterRecovery.standbyRegion` | — (label/NOTES only) | Standby/DR region the replica lives in. |
| `disasterRecovery.maxReplicationLagSeconds` | `DR_MAX_REPLICATION_LAG_SECONDS` | Standby-lag budget for `pnpm dr:check`. Empty → server default 600s (10 min). `values-prod.yaml` sets `"300"` (alarm at 5 min, below the 10-min RPO). |

Run `pnpm dr:check` (CronJob or on-call tool) against the standby's
`DATABASE_URL` to verify replication lag; it exits non-zero when lag exceeds the
threshold, the standby is missing, or Postgres is unreachable. RPO/RTO targets
and the promotion runbook live in
[`docs/OPERATIONS.md`](../../../docs/OPERATIONS.md) §10 and
[`docs/DR_RUNBOOK.md`](../../../docs/DR_RUNBOOK.md).

---

## Image convention

Every image defaults to `<image.registry>/<image.repository>/<component-image>:<chart.appVersion>`,
e.g.:

```
ghcr.io/openzigs/metis-server:0.1.0
ghcr.io/openzigs/metis-ui:0.1.0
ghcr.io/openzigs/metis-embeddings-svc:0.1.0
ghcr.io/openzigs/metis-copilot-svc:0.1.0
```

The METIS server image is Alpine/musl; the copilot sidecar is Debian
(DataDog APM compatibility). The chart treats both equivalently — no special
tolerations or affinity needed.

The four core images publish multi-arch (`linux/amd64,linux/arm64`)
manifests on tag — see `.github/workflows/build-images.yml` (sub-issue
#373) — so EKS Graviton nodes pull native arm64 binaries.

---

## Validating the chart locally

```bash
# Lint
helm lint deploy/helm/metis

# Render and inspect
helm template metis deploy/helm/metis -f deploy/helm/metis/values-prod.yaml

# Snapshot tests (requires `helm-unittest` plugin)
helm plugin install https://github.com/helm-unittest/helm-unittest
helm unittest deploy/helm/metis

# Bash-based golden test (no plugin required)
bash deploy/helm/metis/tests/render-tests.sh
```

---

## Embeddings sidecar (issue #786)

The ONNX embeddings pod is the only component in this chart with a *model* to
load, and that makes its failure modes different from everything else here.

| Setting | Default | Why |
|---|---|---|
| `embeddings.resources.requests` | 1536Mi / 1000m | **Not** the ~570 MiB cold floor. ONNX Runtime's BFC arena never returns memory to the OS, so RSS ratchets to the pod's high-water batch and stays there — a request sized from the cold floor makes this the most-evictable pod on the node. Rule: `requests ≥ limits/2` (prod uses `requests == limits`, i.e. Guaranteed QoS). The CPU request is what a contended node throttles you to, and it — not memory — is what decides whether a batch beats `EMBEDDINGS_TIMEOUT_MS`. |
| `embeddings.resources.limits` | 3Gi / 2000m | Floor + the worst-case 64 × 8192-token batch. Lowering it means lowering the `/embed` cap too; they are the same number from two ends. |
| `embeddings.probes.startup` | `/readyz`, 905 s budget | While a startupProbe has not passed, kubelet runs **neither** liveness nor readiness — the only thing stopping liveness from killing a pod that is merely loading its model. |
| `embeddings.probes.liveness` | `/healthz` | **Never point this at `/readyz`.** A model that cannot load is permanent; answering liveness with "is the model warm?" turns a stalled rollout into a CrashLoopBackOff. |
| `embeddings.progressDeadlineSeconds` | 600 | **INVARIANT: this must stay BELOW the startup budget** (`initialDelaySeconds + periodSeconds × failureThreshold`), so a never-warming model is reported as a **failed rollout** (a Running-but-NotReady pod you can read logs from) rather than restarted into a CrashLoopBackOff. It is a per-profile relationship, not a fixed 600/900 pair: `values-dev.yaml` shortens the budget to 305 s and so **must** shorten this to 240 s. If you change either number, change the other. `tests/render-tests.sh` asserts `budget > deadline` for every profile from its own render. |
| `embeddings.rollingUpdate` | `maxUnavailable: 0` | Surge before drain: a cold/broken pod can never take capacity away from a warm one. |
| `embeddings.affinity` | `arch in (amd64, arm64)` | `onnxruntime-node` ships prebuilt glibc bindings for those two only — and **no musl build at all**. |
| `embeddings.env.EMBED_*` | *(empty)* | Empty env keys are **not emitted** into the pod spec, so the image's baked `EMBED_MODEL` / `EMBED_DTYPE` / `HF_HUB_OFFLINE=1` win. Setting one requires an image built with the matching `--build-arg` — the runtime is offline and can only load what it baked. |

Full derivation of every number, the air-gap verification and the
baked-vs-PVC-vs-init-container decision:
[`docs/EMBEDDINGS_BACKENDS.md`](../../../docs/EMBEDDINGS_BACKENDS.md)
§ "Running the sidecar on Kubernetes / EKS".

---

## Footguns

- **Never base the embeddings image on Alpine.** `onnxruntime-node` has no musl
  build; it *installs* fine and then crashes at `require()` inside the pod. This
  is an image property — no node label or affinity rule in this chart can defend
  against it. `server/tests/embeddings-image-arch.test.ts` is what defends it.
- **NEVER mount `/var/run/docker.sock` or any kubelet CRI socket** in any
  METIS pod. On Kubernetes, the only safe MCP runtime is `runtime: 'k8s-sse'`
  — already enforced in code; this chart does not provide a knob to break
  that invariant.
- The chart does NOT ship an in-cluster Postgres StatefulSet. Use managed
  RDS — see [`docs/EKS_DEPLOYMENT.md`](../../../docs/EKS_DEPLOYMENT.md).
- The chart does NOT install ESO, AWS Load Balancer Controller, EBS CSI,
  EFS CSI, or cert-manager — those are cluster prerequisites the operator
  installs once. The EKS deployment guide walks through every recipe.

---

## Values reference

See `values.yaml` — every field has an inline comment.
