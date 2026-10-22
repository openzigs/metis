# METIS Helm chart

> Production Helm chart for [METIS](https://github.com/openzigs/metis) on
> Kubernetes — server, ui, embeddings and sql-lineage, with PVCs,
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
`file:/app/server/data/metis.db` — repository archive extracts, and repository
clones (`REPO_CLONE_DIR=/app/server/data/repo-clones`, #1322); the server's
home directory (`/home/metis`) is an `emptyDir`. With a Postgres `DATABASE_URL`, set
`persistence.data.enabled=false` (as `values-prod.yaml` does) to keep the data
directory on an `emptyDir` instead of a `ReadWriteOnce` PVC.

Each PVC has its own toggle — `persistence.data.enabled`,
`persistence.uploads.enabled`, `persistence.lancedb.enabled` — and a disabled one is
an `emptyDir` (#75). With uploads on S3 (`uploads.backend=s3`) and vectors in
pgvector (`scaling.vectorStore=pgvector`) nothing durable is written to the uploads
or LanceDB directories, so `values-prod.yaml` disables all three: a `ReadWriteOnce`
claim mounted by two server replicas cannot attach on a second node
(Multi-Attach).

**Reclaim policy** is `Retain` by default — the PVC survives `helm uninstall`
via `helm.sh/resource-policy: keep`. To switch to multi-replica RWX:

```bash
helm install metis ./deploy/helm/metis \
  --set persistence.efs.enabled=true \
  --set server.replicaCount=2
```

With `scaling.enforce=true` (as `values-prod.yaml` sets) the chart
**fails-closed** when more than one server pod can run — `server.replicaCount > 1`,
or `autoscaling.server.enabled` with `maxReplicas > 1` (#75) — and it lacks the shared backends
(Postgres `DATABASE_URL`, `scaling.vectorStore=pgvector`, `uploads.backend=s3`)
or still mounts any server PVC as `ReadWriteOnce` (#75) — disable it, or make
it RWX with `persistence.efs.enabled=true`.

The opt-in backup CronJob (`backup.enabled=true`) mounts the server's PVCs
read-only — the data directory (the SQLite database) and the uploads and
LanceDB volumes inside it, each only when its PVC exists — and its default
command archives the whole data directory except `repo-extracts` (#75) and
`repo-clones` (#1322), both rebuilt on demand. It
copies a live database: see the consistency note on `backup.command` in
`values.yaml`.

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

`JWT_SECRET`, `VAULT_MASTER_KEY`, `EMBEDDINGS_TOKEN`, `SQL_LINEAGE_TOKEN`,
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
| `nginx` | cert-manager (`ingress.tls.certManager.enabled`) or `ingress.tls.secretName` | Native: ingress-nginx forwards `Upgrade` itself, and the chart only sets 3600 s read/send timeouts. There is no snippet: ingress-nginx v1.9+ rejects snippet annotations by default, and the old one failed `helm install` (#1312). |
| `traefik` | cert-manager | `traefik.ingress.kubernetes.io/router.entrypoints: websecure` |

Routes:

| Path | Backend | Port |
|------|---------|------|
| `/api/auth/oidc`, `/api/auth/saml` | `<release>-server` | 4000 (SSO: login redirects, OIDC callback, SAML ACS + metadata) |
| `/socket.io` | `<release>-server` | 4000 (websocket) |
| `/` (including the rest of `/api`) | `<release>-ui` | 3000 |

`/api` goes to the **UI**, not the server (#1312). The UI's route handlers are
the browser's API:

- at login they mint the `Secure; HttpOnly` session cookies;
- every other `/api` call they forward to `ui.env.METIS_API_URL` (default
  `http://<fullname>-server:<server.service.port>/api`) with the token attached.

An `/api → server` rule answered login with 200, set no cookie, and sent the
user back to `/login`.

The SSO endpoints are the exception. The server serves them
(`server/src/routes/sso.ts`), and the UI has no route for them: its `/api`
catch-all answers `/api/auth/*` with 404. The Ingress therefore sends
`/api/auth/oidc` and `/api/auth/saml` to the server, listed ahead of `/` (ALB
evaluates rules in order). Register the IdP URLs on the **public origin**:

- the OIDC redirect URI is `https://<host>/api/auth/oidc/callback`;
- the SAML ACS URL is `https://<host>/api/auth/saml/acs`, and its metadata is
  at `https://<host>/api/auth/saml/metadata`.

The cookies the server sets at the end of an SSO login may not use the names
the UI's session check reads; that is tracked separately. Check an SSO
round-trip end to end before relying on it.

Request bodies: ingress-nginx refuses bodies over 1m by default, so the chart
sets `nginx.ingress.kubernetes.io/proxy-body-size` from
`ingress.nginx.proxyBodySize` (default `50m`, the server's repository-archive
cap). For the ALB and traefik, check your controller's own limit.

**Known limit: long idle requests through the UI proxy.** The UI's `/api`
proxy uses Node's `fetch`, which gives up when no response headers arrive
within undici's default 300 s `headersTimeout`. Only Spec Kit commands get a
longer timeout (`METIS_SPEC_KIT_PROXY_TIMEOUT_MS`). Any other call that sends
no headers for 5 minutes fails at the proxy even if the server finishes, and
raising the Ingress timeouts does not help.

This has two consequences for operators:

- **Health from outside is `/api/health`**, which the UI proxies to the server.
  Through the ingress, `/healthz` and `/readyz` reach the UI, which redirects to
  `/login`. Check them with `kubectl exec` instead (see
  [Health checks](#health-checks)).
- **TLS is required for login.** The session cookies are `Secure`, so a browser
  (or `curl -c`) on plain `http://` never sends them back.

For a BYO TLS Secret instead of cert-manager, set
`ingress.tls.secretName: my-tls`.

### Server env the chart does not set for you

The chart cannot guess these values, and the server will not work behind an
ingress without them (#1312):

| `server.env` key | Why |
|---|---|
| `AUTH_MODE` (`ldap`, `oidc` or `saml`) | If unset, it resolves to `mock`, and under `NODE_ENV=production` the server **refuses to start** (CrashLoopBackOff: "Mock authentication is not permitted in production"). LDAP also needs `AUTH_LDAP_URL`, `AUTH_LDAP_BASE_DN`, `AUTH_LDAP_BIND_DN`, `AUTH_LDAP_USER_SEARCH_BASE` and `AUTH_LDAP_SEARCH_FILTER` (the default filter is Active Directory's `sAMAccountName`), plus the bind password through `secrets.keyMap.AUTH_LDAP_BIND_PASSWORD`. See [`docs/auth/README.md`](../../../docs/auth/README.md). Bootstrapping the first admin is #1376. |
| `CORS_ORIGIN` | Set it to `https://<ingress.host>`. The server checks a socket's `Origin` (#1349) and CORS against this value. The default is `http://localhost:3000`, so every browser socket is rejected with `ORIGIN_REJECTED`. |
| `MCP_RUNTIME: k8s-sse` | The only safe MCP runtime on Kubernetes. If unset, `/readyz` reports the Docker runtime as failed (there is no Docker socket, by design). The readiness probe for `k8s-sse` itself is wrong today (#1380). |

`server.env` values pass through Helm's `tpl`, so a literal `{{` must be
escaped. For example, the LDAP filter `(uid={{username}})` is written
`'(uid={{ "{{" }}username{{ "}}" }})'`.

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

- **HPA** — `ui` scales 2→10 on 70% CPU by default. The `server` HPA is
  **on** by default (2→6) since the multi-replica work. On the single-replica
  SQLite/LanceDB profile, turn it off (`autoscaling.server.enabled=false`) along
  with `server.replicaCount: 1`. The HPA needs metrics-server.
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
- **NetworkPolicy** (#1374) — every pod of the release is deny-default for
  ingress and egress, except DNS. Four policies, selecting pods on the labels
  the pod template carries (`app.kubernetes.io/name`, `instance`, `component`):

  | Pod | May be reached from | May reach |
  |-----|---------------------|-----------|
  | `ui` | ingress controller namespace | server |
  | `server` | ingress controller namespace, `ui`; Prometheus with `serviceMonitor.enabled` | sidecars, the MCP namespace (`rbac.mcpNamespace`), Kubernetes API (`egress.kubeApiServer`, 6443), HTTPS (`egress.https`, `0.0.0.0/0:443`), `egress.databaseCidrs` (5432), `egress.extra` |
  | `embeddings`, `sql-lineage` | `server` | nothing (both are air-gapped) |
  | backup CronJob | nothing | nothing (it tars the mounted volumes) |

  Only the server leaves the cluster. External HTTPS is an `ipBlock`; narrow
  `networkPolicy.egress.https.cidrs` to restrict it. With
  `networkPolicy.cilium.enabled=true` the HTTPS and Kubernetes API ipBlocks are
  dropped and a `CiliumNetworkPolicy` on the server allows HTTPS to an FQDN
  allow-list (`aiGateways`, `githubHosts`, `extraFqdns`) and the
  `kube-apiserver` entity; the four vanilla policies still render.
- **Enforcement** needs a CNI that implements NetworkPolicy: Calico, Cilium, or
  the EKS VPC CNI with network policy enabled. kindnet on a Docker Desktop kind
  cluster did not enforce an egress deny in #1312, so a kind install does not
  test these policies. The render tests (`tests/render-tests.sh`, Test 14)
  assert that every pod is selected and what each may reach.

Add managed-DB egress (RDS), an identity provider or a mail relay via:

```yaml
networkPolicy:
  egress:
    databaseCidrs:
      - 10.0.10.0/24
      - 10.0.11.0/24
    extra:
      - cidrs: ["10.20.0.15/32"]     # LDAPS
        ports: [636]
      - cidrs: ["10.20.0.40/32"]     # OIDC IdP on a non-443 port
        ports: [8443]
      - cidrs: ["10.20.0.25/32"]     # SMTP submission
        ports: [587]
```

A NodeLocal DNSCache (`169.254.20.10`) is not a `kube-dns` pod: add a policy of
your own allowing UDP/TCP 53 to it for every pod of the release.

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
(set in `values-prod.yaml`) it fails `helm template/install` if more than one server
pod can run (`replicaCount > 1`, or an enabled server HPA with `maxReplicas > 1`)
without a Postgres `DATABASE_URL`, `vectorStore: pgvector`, and `uploads.backend: s3`.
The chart default is `enforce: false` so a bare `helm install` renders cleanly;
the rendered `NOTES.txt` still **warns** when N>1 lacks the shared backends.

Use `values-prod.yaml` for a ready-made multi-replica profile, and see
[`docs/EKS_DEPLOYMENT.md`](../../../docs/EKS_DEPLOYMENT.md) §9b–§9f for the
provider-side setup (RDS Postgres + pgvector extension, S3 bucket + IRSA policy).
`persistence.efs.enabled` is no longer required for N>1 — it remains only as an
orthogonal RWX option if you deliberately keep uploads/LanceDB on a filesystem.

**Per-pod state that is not shared (#766).** An analysis agent's live progress
(the "Re-running · N steps so far" line on the Agent output tab during a
Regenerate or Continue) is held in memory by the pod running the agent and is
not written to any shared backend. Without session affinity on the ingress, the
page's 2.5 s polls alternate pods, and only one of them reports the entry. The
page keeps an agent it has seen running shown as running until its stored
result changes, the run stops, or 60 s pass without a sighting, so the card does
not flip back to its old result; the step count it shows is then the last one a
poll returned, and it moves only when a poll reaches the pod doing the work. No
results, statuses or costs depend on this state.

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
```

The images are glibc (Debian) based; the chart needs no special tolerations
or affinity for them. (The GitHub Copilot sidecar image, `metis-copilot-svc`,
was removed with Copilot support in #150.)

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

## Health checks

The server image ships no `curl`, so check from inside the cluster with `node`:

```bash
kubectl -n metis exec deploy/metis-server -- node -e \
  "fetch('http://localhost:4000/readyz').then(r=>r.text()).then(console.log)"
```

From outside, through the ingress, use `curl -fsS https://<host>/api/health`.

---

## Backup and restore (single-replica, PVC profile)

`backup.enabled=true` renders a CronJob that tars the server's data directory
(SQLite database, uploads, LanceDB) to the `<release>-backup` PVC. With RWO
volumes, pin it to the server's node with the `backup.affinity` example in
`values.yaml`. To run a backup now:

```bash
kubectl -n metis create job metis-backup-manual --from=cronjob/metis-backup
kubectl -n metis wait --for=condition=complete job/metis-backup-manual --timeout=300s
kubectl -n metis logs job/metis-backup-manual   # [backup] wrote /backup/metis-backup-<ts>.tar.gz
```

The restore below was drilled on kind in #1312: a project deleted after the
backup came back, with its generated BRD.

1. Run `kubectl -n metis scale deploy/metis-server --replicas=0` and wait for
   the pod to terminate, so the restore does not race a live SQLite writer.
2. Run a one-off pod that mounts the same four claims at the server's paths and
   unpacks the newest tarball. It unpacks to scratch space first and checks the
   result, so a bad tarball leaves the live volumes untouched. Only then does
   it wipe the volumes and copy the files in. Copying, rather than running
   `tar -x` onto the volumes, is needed because the pod runs as UID 1001 under
   PSA `restricted`: the volume roots belong to the provisioner, so a `tar -x`
   straight onto them fails (exit 2, "Cannot change mode") even though every
   file lands. The scratch space is the pod's `emptyDir`, so the node needs free
   disk for one unpacked backup.

   The claims are `ReadWriteOnce`, so the pod can only start where the volumes
   can attach. On kind that is the node holding the local volumes. On EKS an EBS
   volume attaches only in its own **Availability Zone**: if no schedulable node
   is in that AZ, the pod stays `Pending` with a volume node-affinity conflict.
   Keep a node in the AZ (or let the autoscaler add one) before you start.

   ```yaml
   apiVersion: v1
   kind: Pod
   metadata: { name: metis-restore, namespace: metis }
   spec:
     restartPolicy: Never
     securityContext:
       runAsNonRoot: true
       runAsUser: 1001
       runAsGroup: 1001
       fsGroup: 1001
       seccompProfile: { type: RuntimeDefault }
     containers:
       - name: restore
         image: ghcr.io/openzigs/metis-server:<tag>
         securityContext:
           allowPrivilegeEscalation: false
           readOnlyRootFilesystem: true
           capabilities: { drop: [ALL] }
         command:
           - /bin/sh
           - -c
           - |
             set -eu
             latest="$(ls -1t /backup/metis-backup-*.tar.gz | head -n1)"
             echo "[restore] from $latest"
             # 1. Unpack to scratch and verify BEFORE touching the live volumes:
             #    a corrupt or empty tarball must leave the current data alone.
             mkdir -p /tmp/stage && tar -xzf "$latest" -C /tmp/stage
             test -s /tmp/stage/metis.db || { echo "[restore] no metis.db in $latest; aborting, nothing changed" >&2; exit 1; }
             # 2. Only now wipe the data volume and the two volumes mounted inside it
             #    (the mount points themselves stay), then copy the verified tree in.
             cd /app/server/data
             find . -mindepth 1 -maxdepth 1 ! -name uploads ! -name lancedb -exec rm -rf {} +
             find ./uploads ./lancedb -mindepth 1 -maxdepth 1 -exec rm -rf {} +
             cp -R /tmp/stage/. /app/server/data/
             echo "[restore] done"
         volumeMounts:
           - { name: tmp, mountPath: /tmp }
           - { name: data, mountPath: /app/server/data }
           - { name: uploads, mountPath: /app/server/data/uploads }
           - { name: lancedb, mountPath: /app/server/data/lancedb }
           - { name: backup, mountPath: /backup, readOnly: true }
     volumes:
       - { name: tmp, emptyDir: {} }
       - { name: data, persistentVolumeClaim: { claimName: metis-server-data } }
       - { name: uploads, persistentVolumeClaim: { claimName: metis-server-uploads } }
       - { name: lancedb, persistentVolumeClaim: { claimName: metis-server-lancedb } }
       - { name: backup, persistentVolumeClaim: { claimName: metis-backup } }
   ```

3. When the pod is `Succeeded`, delete it and run
   `kubectl -n metis scale deploy/metis-server --replicas=1`.

The restored database can decrypt its connector secrets only with the **same**
`VAULT_MASTER_KEY`, which the backup deliberately does not contain. On Postgres
(`values-prod.yaml`) the database is not on these volumes: restore it from the
managed service's snapshots. For cross-region failover, see
[`docs/DR_RUNBOOK.md`](../../../docs/DR_RUNBOOK.md).

---

## Footguns

- **Upgrading a scaled install with Helm 4** fails once an HPA has changed the
  replica count, with `conflict with "kube-controller-manager" with subresource
  "scale" … .spec.replicas`. The cause is that the chart still renders
  `replicas` under an HPA (#1378). Until that is fixed, pass `--force-conflicts`.

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
