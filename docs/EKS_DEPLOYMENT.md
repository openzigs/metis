# EKS deployment — green-field guide

> **Audience**: Operators provisioning METIS on a new AWS account.
> **Outcome**: A working `helm install metis ./deploy/helm/metis -f values-prod.yaml` against a healthy EKS cluster, with persistent storage, External Secrets, ALB ingress, and IRSA wired end-to-end.

This guide assumes a clean AWS account. Skip steps you have already completed (e.g. existing VPC, existing cluster). The end state mirrors the [`docs/K8S_PROD_CHECKLIST.md`](./K8S_PROD_CHECKLIST.md) audit.

---

## 0. Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| `aws` CLI | ≥ 2.15 | account / region context |
| `eksctl` | ≥ 0.180 | cluster + IRSA bootstrap |
| `kubectl` | ≥ 1.27 | cluster API |
| `helm` | ≥ 3.13 | chart install |
| Postgres-managed instance | RDS Postgres 16 (recommended) | the chart does **not** ship an in-cluster Postgres StatefulSet |

> **Footgun**: The chart explicitly does **not** ship Postgres. Use AWS RDS (or any other managed Postgres) and pass the `DATABASE_URL` via External Secrets. In-cluster Postgres on EBS/EFS is a footgun for backup/restore and connection-pool sizing — leave it to a managed service.

> **Adapter selection by `DATABASE_URL` (#539, epic #518)**: the server selects its
> Prisma driver adapter from the `DATABASE_URL` scheme at startup —
> `postgres://`/`postgresql://` → the Postgres adapter (`@prisma/adapter-pg`),
> `file:`/`sqlite:` → embedded SQLite. **For any multi-replica (N>1) deployment you
> MUST supply a `postgres://` `DATABASE_URL`**; an unset or `file:` URL falls back to
> per-pod embedded SQLite on an RWO PVC, which cannot be shared across replicas (this
> was the keystone scaling blocker fixed in #539). An unrecognized scheme fails loud at
> startup rather than silently degrading to SQLite. Run migrations against Postgres with
> `pnpm --filter @metis/server db:migrate:postgres` (a Postgres `DATABASE_URL` routes the
> Prisma CLI to `prisma/postgres/` automatically via `server/prisma.config.ts`).

> **Provisioning a fresh Postgres — use `migrate deploy`, not `db push` (#556, epic #518)**:
> for a production database, apply the ordered migration history so the schema is
> reproducible and auditable:
>
> ```bash
> DATABASE_URL=postgres://… pnpm --filter @metis/server prisma migrate deploy
> ```
>
> This applies the full `prisma/postgres/migrations` chain — the curated cumulative
> `00000000000000_init` baseline followed by every incremental migration — to an empty
> database. (`db push` syncs schema *state* with no migration history and is only for
> throwaway/dev databases.) The `00000000000000_init` baseline is a **cumulative snapshot**
> of the entire current schema: the schema-parity workflow appends each new
> table/column/index to it. Because every later incremental migration also carries the DDL
> it introduced, the incremental migrations' **structural DDL is idempotent**
> (`CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and `pg_constraint`
> existence-guarded `ADD CONSTRAINT`) so the chain applies from scratch with zero DDL
> collisions and is a clean no-op on re-run. Two CI jobs guard this: `postgres-adapter`
> proves the runtime adapter connects to a real Postgres, and `postgres-migrate-deploy`
> runs `prisma migrate deploy` from an empty `postgres:16-alpine` on every change.
> A static guard in `server/tests/schema-parity.test.ts` (issue #556) fails the build if a
> *new* incremental Postgres migration ships non-idempotent structural DDL — when adding a
> model, author the postgres incremental with the same idempotent guards (see the
> dual-schema migration workflow).

---

## 1. VPC + subnet tagging

Required so the AWS Load Balancer Controller can discover subnets.

```bash
aws ec2 create-tags --resources subnet-public-1 subnet-public-2 \
  --tags Key=kubernetes.io/role/elb,Value=1
aws ec2 create-tags --resources subnet-private-1 subnet-private-2 \
  --tags Key=kubernetes.io/role/internal-elb,Value=1
```

---

## 2. EKS cluster

```bash
eksctl create cluster \
  --name metis-prod \
  --region us-east-1 \
  --version 1.30 \
  --vpc-private-subnets subnet-private-1,subnet-private-2 \
  --vpc-public-subnets subnet-public-1,subnet-public-2 \
  --with-oidc \
  --managed --node-type m6i.large --nodes 3
```

### Karpenter vs managed node groups

|  | Managed node groups | Karpenter |
|--|--------------------|-----------|
| Setup time | minutes | 30+ min, requires controller install |
| Bin-packing | OK | Excellent — fits arm64 Graviton spot at lowest cost |
| Recommendation | **Use** for first install | Add later when bill > $500/month |

The chart does not depend on either — Karpenter's value is at the node-pool layer.

---

## 3. Bootstrap controllers

### 3a. AWS Load Balancer Controller

```bash
eksctl utils associate-iam-oidc-provider --cluster metis-prod --approve

eksctl create iamserviceaccount \
  --cluster metis-prod \
  --namespace kube-system \
  --name aws-load-balancer-controller \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonEKSLoadBalancerControllerRole \
  --override-existing-serviceaccounts --approve

helm repo add eks https://aws.github.io/eks-charts
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=metis-prod \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller
```

### 3b. EBS CSI driver (default)

```bash
eksctl create addon --name aws-ebs-csi-driver --cluster metis-prod \
  --service-account-role-arn arn:aws:iam::ACCT:role/AmazonEKS_EBS_CSI_DriverRole \
  --force
```

Create the `gp3` StorageClass (EBS CSI does not provide one by default):

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
  fsType: ext4
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
```

### 3c. EFS CSI driver (optional — only for RWX)

Skip unless you are setting `persistence.efs.enabled=true` in `values-prod.yaml`.

```bash
eksctl create iamserviceaccount \
  --cluster metis-prod --namespace kube-system \
  --name efs-csi-controller-sa \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEFSCSIDriverPolicy \
  --override-existing-serviceaccounts --approve

helm repo add aws-efs-csi-driver https://kubernetes-sigs.github.io/aws-efs-csi-driver/
helm install aws-efs-csi-driver aws-efs-csi-driver/aws-efs-csi-driver \
  -n kube-system \
  --set controller.serviceAccount.create=false \
  --set controller.serviceAccount.name=efs-csi-controller-sa
```

### 3d. External Secrets Operator

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets-system --create-namespace
```

ESO needs IRSA to read AWS Secrets Manager:

```bash
eksctl create iamserviceaccount \
  --cluster metis-prod --namespace external-secrets-system \
  --name external-secrets \
  --attach-policy-arn arn:aws:iam::aws:policy/SecretsManagerReadWrite \
  --override-existing-serviceaccounts --approve
```

Then create a `ClusterSecretStore`:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets-system
```

### 3e. ExternalDNS (optional but recommended)

```bash
eksctl create iamserviceaccount \
  --cluster metis-prod --namespace kube-system \
  --name external-dns \
  --attach-policy-arn arn:aws:iam::ACCT:policy/AllowExternalDNSUpdates \
  --override-existing-serviceaccounts --approve

helm repo add external-dns https://kubernetes-sigs.github.io/external-dns
helm install external-dns external-dns/external-dns -n kube-system \
  --set provider=aws --set serviceAccount.create=false \
  --set serviceAccount.name=external-dns
```

---

## 4. Secrets in AWS Secrets Manager

Create one secret per required env var, prefixed `metis/`:

```bash
for k in JWT_SECRET VAULT_MASTER_KEY EMBEDDINGS_TOKEN COPILOT_NATIVE_TOKEN \
         DATABASE_URL OPENAI_API_KEY GITHUB_TOKEN METRICS_TOKEN; do
  aws secretsmanager create-secret --name "metis/${k}" \
    --secret-string "REPLACE_ME"
done
```

Generate the cryptographic ones with `openssl rand -base64 48` (`JWT_SECRET`)
and `openssl rand -base64 32` (`VAULT_MASTER_KEY`).

---

## 5. METIS server IRSA

The server pod needs IRSA to call `secretsmanager:GetSecretValue` on `metis/*`:

```bash
cat > /tmp/metis-server-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      "Resource": "arn:aws:secretsmanager:us-east-1:ACCT:secret:metis/*" }
  ]
}
EOF
aws iam create-policy --policy-name MetisServerPolicy \
  --policy-document file:///tmp/metis-server-policy.json

eksctl create iamserviceaccount \
  --cluster metis-prod --namespace metis \
  --name metis-server \
  --attach-policy-arn arn:aws:iam::ACCT:policy/MetisServerPolicy \
  --override-existing-serviceaccounts --approve
```

> The chart will create the ServiceAccount itself if you set `serviceAccount.create=true` (the default). Pass `--override-existing-serviceaccounts` so `eksctl` annotates the SA the chart will reconcile, OR set `serviceAccount.create=false` and let `eksctl` own it.

### Per-MCP IRSA prefix

Separately, the per-MCP runtime (`runtime: 'k8s-sse'`, Epic #272) uses an
IRSA prefix configured via the `MCP_K8S_IRSA_ROLE_ARN_PREFIX` env. Each MCP
gets a role like `<prefix>-<server-id>`. See
[`docs/OPERATIONS.md` §7.3](./OPERATIONS.md#73-kubernetes-native-mcp-runtime-epic-272--k8s-sse)
for the full pattern. METIS only annotates per-MCP SAs; this guide sets up
the **server's own** IRSA only.

---

## 6. Namespaces

```bash
kubectl create namespace metis
kubectl label namespace metis \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted

kubectl create namespace metis-mcp
kubectl label namespace metis-mcp \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted
```

The METIS chart's RBAC template grants `metis-server` permissions to manage
resources inside `metis-mcp` (default) — see sub-issue #370.

---

## 7. Install METIS

> **One canonical chart.** As of #540 there is a single Helm chart at
> `deploy/helm/metis/` (the former duplicate `charts/metis/` was removed). The
> `values-prod.yaml` profile is multi-replica (`server.replicaCount: 2`) and wires
> the shared backends from §9 (Postgres / pgvector / S3 / leader election). Set the
> uploads S3 bucket (and confirm its region) when you install.

```bash
helm install metis ./deploy/helm/metis \
  -n metis \
  -f deploy/helm/metis/values-prod.yaml \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::ACCT:role/eksctl-metis-prod-addon-iamserviceaccount-metis-Role1-XXX" \
  --set ingress.host=metis.example.com \
  --set ingress.alb.certificateArn=arn:aws:acm:us-east-1:ACCT:certificate/UUID \
  --set uploads.s3.bucket=my-metis-uploads \
  --set uploads.s3.region=us-east-1
```

Watch pods come up:

```bash
kubectl get pods -n metis -w
kubectl logs -n metis deploy/metis-server --tail=200 -f
```

---

## 7b. Local chart validation (kind / k3d) + CI

Before promoting any chart change you can validate it **without an EKS cluster**.
Two layers, both reproducible locally and in CI (issue #545, epic #518):

**1. Offline gate (no cluster, no Docker)** — `helm lint` + `helm template` across
the default / `values-dev` / `values-prod` sets plus the 109-assertion golden
render suite (`deploy/helm/metis/tests/render-tests.sh`):

```bash
make chart-validate          # → scripts/chart-validate.sh
```

**2. kind install smoke (throwaway cluster)** — creates a kind cluster, runs the
offline gate, `helm install`s the chart with `values-dev`, and asserts the
release's Kubernetes objects (Deployments, Services, ServiceAccount, ConfigMap,
Secret, PVCs) are actually created. It also dry-run-renders `values-prod` to
confirm the multi-replica posture (`server` Deployment `replicas: 2`, scaling env
present):

```bash
make k3d-test                # alias for `make kind-smoke` → scripts/kind-smoke.sh
KEEP_CLUSTER=1 make kind-smoke   # keep the cluster afterwards to poke around
```

> **Pod-Ready is intentionally NOT asserted.** The METIS images
> (`ghcr.io/openzigs/metis-*`) are not published into the kind node, so the
> pods sit in `ImagePullBackOff` — expected. The smoke validates the **chart**
> (admission accepts every rendered object; the release installs; all objects
> exist), not the running application. To exercise a real rollout locally, build
> the images and `kind load docker-image metis-server:test …` into the cluster
> before installing; the script documents this in its header. We deliberately do
> not load images in CI to keep the job fast and non-flaky.
>
> The dev profile's namespaced RBAC Role targets the MCP namespace
> (`rbac.mcpNamespace`, default `metis-mcp`, see §6), so the smoke script creates
> that namespace before installing — the same prerequisite a real install needs.

**CI**: `.github/workflows/chart-validate.yml` runs both layers as the `chart-lint`
and `kind-smoke` jobs. It is **path-filtered** to `deploy/helm/**`, the helper
scripts, the `Makefile`, and the workflow file — so it is a **gating check on
chart PRs** and is simply absent on PRs that do not touch the chart (it does not
add cluster spin-up time to every build). The jobs use the self-hosted runner's
pre-installed `helm`/`kind`/`kubectl`/`docker` and a per-run unique cluster name,
and bind no new host port (so they cannot hit the shared-`:5432` Postgres-job
flake). `make k3d-test` reproduces the `kind-smoke` job exactly.

---

## 8. Verify ingress + DNS

```bash
kubectl get ingress -n metis
# Expect HOSTS = metis.example.com and ADDRESS = <alb-fqdn>.elb.amazonaws.com

# If using ExternalDNS, the A / ALIAS record gets created automatically.
# Otherwise add a Route 53 alias to the ALB.

curl -k https://metis.example.com/healthz
# Expect: {"status":"ok"}
```

---

## 9. Verify persistence

```bash
# Upload a file via the UI, then bounce the pod:
kubectl rollout restart deploy/metis-server -n metis

# After it comes back, the upload is still there.
kubectl exec -n metis deploy/metis-server -- ls /app/server/data/uploads
```

---

## 9b. Shared rate-limit store (multi-replica) — `DISCUSSION_RATE_LIMIT_BACKEND`

The discussion AI-invocation cap and the @mention-spam guard are per-`(thread,
user)` sliding-window limiters (issues #485 / #489). Their **default** backend is
in-memory and **per-process**: each replica counts independently, so under N>1
replicas the effective cap becomes **N×** the configured value. That is fine for
local/dev (a single process) but **wrong for any multi-replica deployment**.

Select a shared backend with `DISCUSSION_RATE_LIMIT_BACKEND` so the cap holds
**cluster-wide** (issue #541, epic #518):

| Env | Backend | When to use |
|---|---|---|
| local / dev | `memory` (default) | Single process. No external dependency. |
| **production (default)** | **`postgres`** | **The recommended production setting.** Reuses the **shared Postgres you already run for N>1 replicas** (#539's `DATABASE_URL`-scheme-selected adapter) — no extra service to provision, secure, or pay for. An atomic `INSERT … ON CONFLICT` counter row holds the cap across every replica. Handles far more than the AI-invocation volume this cap sees. |
| high-scale (optional) | `valkey` | Only if you exceed the Postgres envelope **or already run a cache/pub-sub**. Uses **Valkey** (Linux-Foundation BSD fork of Redis — e.g. **ElastiCache / MemoryDB for Valkey**, ~20–33% cheaper than Redis OSS), **not** Redis Ltd's relicensed Redis (RSALv2/SSPL; Redis 8 → AGPLv3). METIS ships no redis-wire client, so this backend requires you to install one and register it. |

**Recommended production config (with the shared Postgres from §0):**

```yaml
env:
  DATABASE_URL: postgresql://…           # shared Postgres (required for N>1)
  DISCUSSION_RATE_LIMIT_BACKEND: postgres
  # Optional cap tuning (defaults shown):
  # DISCUSSION_AI_RATE_LIMIT_MAX: "10"
  # DISCUSSION_AI_RATE_LIMIT_WINDOW_MS: "60000"
```

Notes:
- The `postgres` backend self-creates a small **UNLOGGED** counter table on first
  use (idempotent, advisory-lock-guarded) — **no migration to run** and it is
  intentionally not part of the Prisma schema. UNLOGGED means it is not crash-safe
  or replicated, which is exactly right for ephemeral counters (a crash just
  resets a few windows).
- It uses a **fixed (tumbling) window**, so up to `2·max` hits can occur across a
  window boundary — the standard, cheap distributed-counter trade-off, acceptable
  for a cost-guard cap. Reach for `valkey` only when you genuinely outgrow this.
- Unknown / unset values fail safe to `memory` (the limiter is never silently
  disabled — it just degrades to per-process), so a typo cannot remove the cap;
  but `postgres`/`valkey` selected without a working backend **fail loud** at use
  rather than silently degrading.

**When to upgrade to Valkey:** stick with `postgres` unless (a) the limiter's
upsert traffic becomes a measurable share of your Postgres load, or (b) you are
already deploying a Valkey/ElastiCache cluster for other reasons (caching,
pub/sub). For METIS's AI-invocation cap volume, Postgres is the right default and
Valkey is rarely necessary.

---

## 9c. Shared SSO transaction-state store (multi-replica) — `SSO_STATE_BACKEND`

SSO login is a two-leg flow: `GET /auth/oidc/login` mints per-login state (the
PKCE `code_verifier`, the OIDC `nonce`, and the CSRF `state`) and stashes it; the
matching `GET /auth/oidc/callback` reads it back by `state` to finish the PKCE +
nonce verification. The **default** backend keeps that state **in-process**
(issue #542, epic #518): under N>1 replicas behind the ALB, the initiate leg can
hit replica A while the callback hits replica B — which has no entry for that
`state`, so the lookup misses and **SSO logins fail intermittently**. Fine for
local/dev (one process); **wrong for any multi-replica deployment.**

Select a shared backend with `SSO_STATE_BACKEND` so the handshake survives load
balancing across pods:

| Env | Backend | When to use |
|---|---|---|
| local / dev | `memory` (default) | Single process. No external dependency. Same consume-once + TTL semantics as the production backend. |
| **production / multi-replica** | **`postgres`** | **Required for N>1 replicas.** Reuses the **shared Postgres you already run** (#539's `DATABASE_URL`-scheme-selected adapter) — no extra service. State is consumed atomically via `DELETE … RETURNING` so a `state` is single-use **cluster-wide** (replay-safe) and the callback succeeds on whichever pod it lands on. |

**Recommended production config (with the shared Postgres from §0):**

```yaml
env:
  DATABASE_URL: postgresql://…   # shared Postgres (required for N>1)
  SSO_STATE_BACKEND: postgres
```

Notes:
- The `postgres` backend self-creates a small **UNLOGGED** table
  (`sso_transaction_state`) on first use (idempotent, advisory-lock-guarded) —
  **no migration to run**, and it is intentionally not part of the Prisma schema.
  UNLOGGED is correct for ephemeral, seconds-lived login state (a crash just fails
  the handful of logins mid-flight at that instant; the user retries).
- Each entry carries a short TTL (10 min) and is **consumed once** — the callback
  atomically reads-and-deletes it, so unknown / already-consumed / expired `state`
  is rejected with `401 OIDC_STATE_MISMATCH`. The PKCE `code_verifier` / OIDC
  `nonce` verification is unchanged; only *where* the state is stored moved.
- Unknown / unset values fail safe to `memory`; `postgres` selected without a
  working backend **fails loud** at use rather than silently degrading to
  per-process (which would re-introduce the cross-replica login bug).
- Set this **and** `DATABASE_URL` to your shared Postgres whenever you scale the
  `metis-server` Deployment past one replica — alongside
  `DISCUSSION_RATE_LIMIT_BACKEND: postgres` (§9b), they share the same Postgres.

---

## 9d. Multi-replica RAG vector store (pgvector) — `VECTOR_STORE`

The RAG dense vector store **defaults to embedded LanceDB**: a per-pod local
directory under `LANCEDB_PATH`. LanceDB is a **single-writer** embedded store —
under N>1 replicas behind the ALB, two pods writing the same data dir (even on an
EFS RWX volume) **corrupt the index** (issue #543, epic #518). Fine for local/dev
(one process); **wrong for any multi-replica deployment.**

Select the shared `pgvector` backend with `VECTOR_STORE` so every replica reads
and writes the same vectors through the shared Postgres:

| Env | Backend | When to use |
|---|---|---|
| local / dev | (unset → embedded LanceDB) | Single process. No external dependency. |
| tests / offline | `local` (or `AI_OFFLINE=1`) | Dependency-free JSON store. |
| **production / multi-replica** | **`pgvector`** | **Required for N>1 replicas.** Reuses the **shared Postgres you already run** (#539's `DATABASE_URL`-scheme-selected adapter) — no extra service. Vectors live in one `rag_vectors` table; Postgres serializes concurrent writers, so the LanceDB corruption mode is gone. |

**Recommended production config (with the shared Postgres from §0):**

```yaml
env:
  DATABASE_URL: postgresql://…   # shared Postgres (required for N>1)
  VECTOR_STORE: pgvector
```

Notes:
- **The Postgres must have the `pgvector` extension available.** Amazon RDS /
  Aurora PostgreSQL ship it (enable per-database with `CREATE EXTENSION vector` —
  the store does this idempotently on first use behind an advisory lock, so no
  manual DDL is needed as long as the connecting role has `CREATE` on the
  database). For a self-hosted Postgres, use an image that bundles pgvector (e.g.
  `pgvector/pgvector:pg16`) or install the extension package. **No Prisma
  migration to run** — the `rag_vectors` table + `vector(N)` column + HNSW index
  self-provision (the column dimension is derived from the configured embedder, a
  runtime value a static migration cannot express, so the table is intentionally
  not part of the Prisma schema).
- **Backfill is a re-embed, not a data copy.** Existing LanceDB vectors are
  regenerable from the source documents. After setting `VECTOR_STORE=pgvector`,
  reindex each project (Admin → Embedding backends) to populate pgvector.
- The index is **HNSW** (`vector_cosine_ops`), tuned for read-heavy RAG. Default
  HNSW build params are used; tune `m` / `ef_construction` only if recall/latency
  measurements demand it.
- Unknown / unset values fall back to the LanceDB default; `pgvector` selected
  without the registered factory **fails loud** at startup rather than silently
  degrading to per-pod LanceDB (which would re-introduce the corruption).
- **When to reconsider an external vector DB (Qdrant/Pinecone):** pgvector is the
  right call while the corpus fits its envelope (METIS scale comfortably does).
  Revisit a dedicated vector DB only if you measure (a) per-project corpora into
  the tens of millions of vectors, (b) HNSW index memory pressuring the Postgres
  instance, or (c) query p99 latency regressing past your RAG SLO under load.
  That is a documented future trigger, not a day-one need.

---

## 9e. Distributed scheduler / leader election (multi-replica) — `SCHEDULER_LEADER_ELECTION`

METIS runs an **in-process scheduler cron** plus several `setInterval` background
jobs (SLA deadline checker, FinOps forecast recompute / budget-alert engine /
monthly chargeback, refresh-token revocation pruner). These are **cluster
singletons**: with N>1 replicas, each would otherwise fire on **every** pod —
firing a due cron N times, wasting compute and racing side effects (issue #544,
epic #518). There is no harm to data correctness (the jobs are idempotent), but
the duplicate work is exactly what blocks scaling the scheduler past one replica.

Enable Postgres-backed **leader election** so those jobs run on **exactly one**
replica at a time:

| Env | Mode | When to use |
|---|---|---|
| local / dev | (unset → always-leader) | Single process owns everything. No external dependency, behaviour unchanged. |
| **production / multi-replica** | **`postgres`** | **Required for N>1 replicas.** Reuses the **shared Postgres you already run** (#539's `DATABASE_URL`-scheme-selected adapter) — no extra service (no Redis/Zookeeper). |

**Recommended production config (with the shared Postgres from §0):**

```yaml
env:
  DATABASE_URL: postgresql://…        # shared Postgres (required for N>1)
  SCHEDULER_LEADER_ELECTION: postgres
```

**How it works (lease + crash recovery):**
- One pod acquires a **lease** — a row in a self-managed UNLOGGED
  `cluster_leader_lease` table with an absolute `expires_at`. Only the leader
  runs the singleton scheduler + interval jobs; followers run everything else
  (API, sockets, MCP) normally.
- The leader **renews** the lease every ~10s; the lease **TTL is ~30s**.
- **Crash recovery is the TTL**: if the leader pod dies (OOM, node drain,
  network partition) it stops renewing, the lease expires after the TTL, and a
  surviving replica acquires it and resumes scheduling automatically. A graceful
  shutdown releases the lease immediately so failover is near-instant.
- A lease (not a session-scoped `pg_advisory_lock`) is used deliberately: the
  runtime Prisma client uses a **connection pool**, over which a session-bound
  advisory lock cannot reliably cover the work — the TTL-based lease is
  pool-agnostic and survives crashes cleanly.
- A second per-fire guard (`(jobName, window)` claim) ensures that even a brief
  two-leader overlap during failover can't double-fire a single occurrence.

**Per-pod jobs are NOT gated** (and must not be): Socket.IO ping/pong heartbeats
and per-MCP-server health probes / idle + cold-start reapers are connection- and
process-local — they act on each pod's own state and must keep running on every
replica. Only the cluster-wide scheduled work is leader-gated.

Notes:
- **No Prisma migration to run** — the lease + window tables self-provision
  idempotently behind an advisory lock on first use (same pattern as §9b/§9c),
  as long as the connecting role has `CREATE` on the database.
- Unknown / unset values, or a **SQLite** `DATABASE_URL`, fall back to
  always-leader (single-process) — a fail-safe that never silently disables the
  scheduler.

---

## 9f. Multi-replica uploads store (S3) — `UPLOAD_STORAGE_BACKEND`

Uploaded document blobs (RAG source files) are written to a **local volume**
(`UPLOAD_DIR`, default `data/uploads`), backed in the chart by an **RWO PVC**. An
RWO PVC can be mounted read-write by **at most one node**, so under N>1 replicas
a file the upload request writes on replica A is **invisible** to replica B's
later ingest/read — downloads and re-ingest fail intermittently behind the load
balancer (issue #546, epic #518). This was the last per-pod-locality blocker to
lifting `replicaCount=1`.

Select the shared `s3` backend with `UPLOAD_STORAGE_BACKEND` so any replica reads
what any other replica wrote:

| Environment | `UPLOAD_STORAGE_BACKEND` | Backing store |
|---|---|---|
| local / dev (default) | `local` (or unset) | Local disk under `UPLOAD_DIR`. Per-pod — correct only for a single replica. No new infra. |
| **production / multi-replica** | **`s3`** | **Required for N>1 replicas.** Document blobs are written to an S3 bucket with the same content-hash key layout, so every replica shares one durable, replica-agnostic store. Works against any S3-compatible store (MinIO) via an endpoint override. |

```yaml
# server env (production)
env:
  UPLOAD_STORAGE_BACKEND: s3
  UPLOAD_S3_BUCKET: my-metis-uploads        # required
  UPLOAD_S3_REGION: us-east-1               # required (or AWS_REGION)
  UPLOAD_S3_PREFIX: uploads                 # optional key prefix
  # UPLOAD_S3_ENDPOINT: http://minio:9000   # optional — S3-compatible store (forces path-style)
```

- **Credentials use the AWS SDK default provider chain — never hardcoded.** On
  EKS the recommended path is **IRSA**: annotate the server's service account
  with an IAM role (see §5) whose policy grants `s3:GetObject`, `s3:PutObject`,
  `s3:DeleteObject`, and `s3:ListBucket` (the last for project deletion) scoped
  to the bucket (and the `UPLOAD_S3_PREFIX/*` keyspace). An EC2/ECS instance role
  or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env (local MinIO) also work — no
  secret lives in code or the chart.
- **Reads stream server-side** (the server pulls the object and serves the bytes
  it already validates/ingests) rather than handing out presigned URLs. This
  keeps the existing access-control + audit path intact (presigned URLs would
  bypass METIS authz) and the ingest pipeline already needs the bytes in memory;
  the marginal cost is one extra S3 GET per ingest/read, which is negligible next
  to embedding.
- Keys are **content-hash addressed** (`<projectId>/<sha>/<sha>/<sha256>`) and
  never contain a client filename, so there is no path-traversal surface and
  identical uploads dedupe. The persisted `Document.storagePath` is prefix-free,
  so it is portable across the `local` and `s3` backends.
- **No bucket data migration is performed.** Existing local-PVC blobs are not
  copied to S3 by this change; switch to `s3` on a fresh deployment or re-ingest
  source documents after the cutover.
- Unknown / unset values fall back to `local` (fail-safe). Selecting `s3` without
  `UPLOAD_S3_BUCKET`/`UPLOAD_S3_REGION` fails loud at startup rather than silently
  degrading to per-pod local (which would re-introduce the cross-replica bug).
- **Helm wiring (#540, delivered):** the chart exposes `uploads.backend`
  (→ `UPLOAD_STORAGE_BACKEND`) and `uploads.s3.bucket/region/prefix/endpoint`
  (→ `UPLOAD_S3_*`) on the server, wired to the IRSA service-account annotation
  + ESO. The old `assertPersistenceTopology` single-writer block is replaced by
  `assertScalingBackends`, which (under `scaling.enforce`) requires `uploads.backend=s3`
  for `server.replicaCount > 1` instead of forbidding it.

---

## 9g. Cross-region Disaster Recovery — Postgres standby + S3 CRR (Epic #70)

DR is a **cross-Region** concern layered on top of the multi-replica backends
above. Because Postgres holds both the application data (#539) and the pgvector
store (#543), one Postgres streaming-replication stream to a standby-Region
replica covers **everything durable except uploaded blobs**, which are covered
by S3 Cross-Region Replication. The Helm chart carries only the tuning knobs
(`disasterRecovery.*` → `DR_MAX_REPLICATION_LAG_SECONDS`); the replication itself
is AWS infra you provision here. RPO/RTO targets and the promotion procedure live
in [`OPERATIONS.md`](./OPERATIONS.md) §10 and [`DR_RUNBOOK.md`](./DR_RUNBOOK.md).

### 9g.1 Postgres streaming replication (#72)

On **RDS/Aurora**, replication is managed — create a **cross-Region read
replica** and AWS runs the WAL stream for you:

```bash
# RDS cross-Region read replica in the standby region (us-west-2)
aws rds create-db-instance-read-replica \
  --db-instance-identifier metis-standby \
  --source-db-instance-identifier arn:aws:rds:us-east-1:ACCOUNT:db:metis-primary \
  --region us-west-2 \
  --kms-key-id <standby-region-kms-key>          # cross-Region needs a key in the target region
# Ensure the pgvector extension exists on the standby too (it replicates with the
# schema, but the extension binary must be available in the replica's parameter group).
```

For **self-managed Postgres 16**, the primary must expose a WAL sender and the
standby streams from it. Minimum primary `postgresql.conf`:

```conf
# --- primary ---
wal_level = replica            # ship enough WAL for physical replication
max_wal_senders = 10           # concurrent standbys + pg_basebackup headroom
wal_keep_size = 1024           # MB of WAL retained for a lagging standby (or use a replication slot)
hot_standby = on               # allow read queries on the standby
# Recommended: a physical replication slot so the primary never recycles WAL the standby still needs.
```

```conf
# --- standby (standby.signal present) ---
primary_conninfo = 'host=metis-primary.us-east-1 port=5432 user=replicator password=… sslmode=require'
primary_slot_name = 'metis_standby_slot'
hot_standby = on
```

- Create the replication role on the primary: `CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '…';`
  and allow it in `pg_hba.conf` from the standby CIDR (`host replication replicator <standby-cidr> scram-sha-256`).
- Bootstrap the standby with `pg_basebackup -h <primary> -U replicator -D <datadir> -R --slot=metis_standby_slot`.
- **Network/IAM:** the standby region must reach the primary on `:5432` — VPC
  peering or Transit Gateway across regions, security-group ingress from the
  standby subnets, and (RDS) an IAM role permitting cross-Region replica
  creation. Keep the stream over TLS (`sslmode=require`).
- The chart's `disasterRecovery.maxReplicationLagSeconds` (prod: `"300"`) is
  injected as `DR_MAX_REPLICATION_LAG_SECONDS`; run `pnpm dr:check` against the
  **standby** `DATABASE_URL` to confirm the replica is in sync within 15 min of
  bootstrap (epic AC #3).

### 9g.2 S3 Cross-Region Replication for uploads (#546 blobs)

Enable **CRR** on the uploads bucket (§9f) so blobs land in a standby-region
bucket. Requires versioning on both buckets and an IAM role S3 can assume:

```bash
aws s3api put-bucket-versioning --bucket my-metis-uploads \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-versioning --bucket my-metis-uploads-dr --region us-west-2 \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-replication --bucket my-metis-uploads \
  --replication-configuration file://crr-config.json   # Role + Destination(bucket=my-metis-uploads-dr)
```

For a contractual replication SLA, add **S3 Replication Time Control (RTC)**
(15-min objective) to the rule. After failover, point
`UPLOAD_S3_BUCKET`/`UPLOAD_S3_REGION` at the standby bucket (done via the
standby-region Helm values / secret).

### 9g.3 VAULT_MASTER_KEY availability

The DR region must resolve the **same** `VAULT_MASTER_KEY` (via multi-region
Secrets Manager replication or External Secrets pointed at a replicated secret),
or replicated connector credentials are unreadable after promotion. This is a DR
prerequisite — see [`OPERATIONS.md`](./OPERATIONS.md) §10.2.

---

## 10. Footguns

- **NEVER** mount `/var/run/docker.sock` or any kubelet CRI socket in any
  METIS pod. On Kubernetes, the only safe MCP runtime is
  `runtime: 'k8s-sse'` — already enforced in METIS code.
- `server.replicaCount` defaults to **2** (multi-replica). This is correct ONLY
  with the shared backends configured: a Postgres `DATABASE_URL` (#539, §0),
  `VECTOR_STORE=pgvector` (§9d — embedded LanceDB is NOT multi-replica safe; write
  divergence corrupts the index), `UPLOAD_STORAGE_BACKEND=s3` (§9f — otherwise
  uploads land on a per-pod RWO PVC other replicas can't read),
  `DISCUSSION_RATE_LIMIT_BACKEND=postgres` (§9b), `SSO_STATE_BACKEND=postgres`
  (§9c), and `SCHEDULER_LEADER_ELECTION=postgres` (§9e — otherwise the scheduler +
  background jobs fire on every replica). The chart's `metis.assertScalingBackends`
  helper enforces the hard requirements (Postgres `DATABASE_URL` + pgvector + S3)
  when `scaling.enforce=true` (set in `values-prod.yaml`); the chart default is
  `enforce=false` so a bare install renders, with `NOTES.txt` warning if N>1 lacks
  the backends. **If you have NOT set up the shared backends, pin
  `server.replicaCount=1`** (the `values-dev.yaml` profile does this).
- The chart does **not** install ESO, AWS LB Controller, EBS/EFS CSI, or
  cert-manager. Cluster prerequisites are owned by the operator.
- `gp3` StorageClass is **not** provisioned by EKS by default — you must
  apply the manifest in §3b.
- AWS VPC CNI alone does **not** enforce NetworkPolicy. Install Calico
  or switch to Cilium (the chart's `networkPolicy.cilium.enabled=true`
  toggle requires Cilium).

---

## 11. Next steps

- Walk [`docs/K8S_PROD_CHECKLIST.md`](./K8S_PROD_CHECKLIST.md) and tick
  every box before promoting traffic.
- Wire CloudWatch Container Insights (or Datadog Agent / OpenTelemetry
  Collector) for observability.
- Configure Velero or `volume-snapshot-class` based backup of the LanceDB
  PVC. The chart sets `helm.sh/resource-policy: keep` so a `helm uninstall`
  does not drop the PVC; backups are still your responsibility.
