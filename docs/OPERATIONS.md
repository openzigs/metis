# METIS — Operations Guide

> Production runbook for deploying, monitoring, backing up, and rotating secrets in METIS. Pair this guide with [`USER_GUIDE.md`](./USER_GUIDE.md) (end-user-focused) and [`SECURITY.md`](./SECURITY.md) (threat model + secret management).

---

## 1. Production Deployment

### 1.1 Prerequisites
- Linux host with Docker Engine 24+ and Docker Compose v2.
- Outbound HTTPS to your AI provider gateway (and `api.github.com` if publishing to github.com).
- A Postgres 16 instance (managed or co-located via the bundled service).
- A reverse proxy in front of port 3000 (UI) and 4000 (API) that terminates TLS.

### 1.2 Required environment variables

Copy `.env.example` to `.env.prod` and fill in real values. The minimal production set is:

| Variable | Purpose | Example |
|---|---|---|
| `NODE_ENV` | Switches Winston to JSON, disables dev seams | `production` |
| `DATABASE_URL` | Prisma connection string | `postgresql://metis:…@db:5432/metis` |
| `DATABASE_PROVIDER` | Tells Prisma which schema | `postgresql` |
| `JWT_SECRET` | Signs auth tokens | `openssl rand -base64 48` |
| `VAULT_MASTER_KEY` | Envelope key for the secret vault | `openssl rand -base64 32` |
| `CORS_ORIGIN` | Allow-list of UI origin(s) | `https://metis.example.com` |
| `METRICS_TOKEN` | Bearer token gating `/metrics` | `openssl rand -hex 32` |
| `LOG_LEVEL` | Winston log level | `info` |

The full env catalogue lives in [`.env.example`](../.env.example) — every variable is documented inline with its default and security notes.

### 1.3 Deploy

```bash
docker compose --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Healthchecks:
- `GET /healthz` — fast liveness (DB ping skipped). Used by container orchestrators.
- `GET /readyz` — deep readiness: DB, vault key, MCP, scheduler, AI provider.
- `GET /readyz?deep=true` — also runs the **MCP runtime substrate probe** (#330). Returns a `mcpRuntime` block with four sub-checks (each `ok` / `fail` / `skip`):
  - `dockerSocket` — `docker version` succeeds (only when `MCP_RUNTIME=docker-stdio`)
  - `network` — `docker network inspect metis-mcp` succeeds (docker-stdio only)
  - `images` — all four base wrapper images (`uvx-runner`, `jbang-runner`, `node-runner`, `npx-runner`) cached locally (docker-stdio only)
  - `kubeconfig` — `@kubernetes/client-node` can `loadFromCluster()` or `loadFromDefault()` (only when `MCP_RUNTIME=k8s-sse`)
  
  Sub-checks not relevant to the active runtime are reported as `status: 'skip'`. Results are cached in-memory for 30 s. Substrate failure on `/readyz?deep=true` returns `degraded` (still HTTP 200) — the operator-facing signal is the per-sub-check status in the JSON body, not a 503.

The Docker images run as a non-root `metis` user (UID 1001), have multi-stage builds for slim footprints, and ship with `HEALTHCHECK` directives so Compose / Kubernetes / ECS can drain unhealthy instances automatically.

### 1.4 Verify the rollout

```bash
curl -fsS https://metis.example.com/healthz
curl -fsS https://metis.example.com/readyz
curl -fsSH "Authorization: Bearer $METRICS_TOKEN" https://metis.example.com/metrics | head
```

The third call should return Prometheus-format text. If you see `404`, `METRICS_TOKEN` is unset and the route is intentionally disabled (fail-closed).

---

## 2. Monitoring

### 2.1 Prometheus scrape

Add this scrape job to your Prometheus config:

```yaml
scrape_configs:
  - job_name: metis
    metrics_path: /metrics
    bearer_token: ${METRICS_TOKEN}
    static_configs:
      - targets: ["metis-api:4000"]
```

#### Exposed series
- `metis_http_requests_total{method,route,status}` — RED: rate.
- `metis_http_request_duration_seconds_bucket{method,route,status}` — RED: latency histogram.
- `metis_http_request_errors_total{method,route}` — RED: errors (status ≥ 500).
- `metis_mcp_server_status{server,name}` — gauge: `1` ready, `-1` error, `0` stopped/disabled.
- `metis_socket_events_total{namespace,event}` — server-side Socket.IO emits.
- Default Node.js process metrics (CPU, memory, GC, event-loop lag) via `prom-client`.

### 2.2 Log shipping

Logs are line-delimited JSON in production (`NODE_ENV=production`). Each request line carries both `correlationId` and `traceId` (alias of the same ULID, mirrored as `X-Trace-Id` on the response). Ship stdout/stderr to your aggregator (Vector, Fluent Bit, Datadog Agent…) — Winston's redaction format already strips `Authorization`, `Cookie`, `*_KEY`, `*_SECRET`, `*_TOKEN`, and similar fields before writing.

To join a request log to its downstream service logs, search by `traceId` or pass the inbound `X-Correlation-Id` header to forwarded calls.

### 2.3 Alerting suggestions

| Condition | Severity |
|---|---|
| `rate(metis_http_request_errors_total[5m]) > 0.05` | warn |
| `histogram_quantile(0.95, …duration_seconds_bucket…) > 1.0` for 10m | warn |
| Any `metis_mcp_server_status == -1` for 5m | warn |
| `up{job="metis"} == 0` | page |
| `/readyz` returning 503 for 2m | page |

---

## 3. Backup & Restore

### 3.1 Backups

`scripts/backup.sh` produces timestamped tarballs containing the database dump, uploaded documents, and the LanceDB vector store. SHA-256 sidecars are written alongside.

```bash
# Daily cron — keep the last 30 days
0 2 * * *  cd /opt/metis && BACKUP_DIR=/var/backups/metis ./scripts/backup.sh
```

| Variable | Default | Notes |
|---|---|---|
| `BACKUP_DIR` | `./backups` | Output directory |
| `BACKUP_RETENTION_DAYS` | `30` | Age in days before tarballs are pruned (`0` disables) |

For SQLite, the script uses `sqlite3 .backup` for an online-consistent copy. For Postgres, it uses `pg_dump --format=custom`.

### 3.2 Restore

```bash
# Stop the API server first
docker compose stop server
./scripts/restore.sh /var/backups/metis/metis-backup-20260425T020000Z.tar.gz
docker compose start server
```

The restore script verifies the SHA-256 sidecar (when present), prints the manifest, restores DB + uploads + vector store, then asks you to restart.

> **Test your restore quarterly** against a non-production database. An untested backup is not a backup.

### 3.3 Off-site shipment

The script does not encrypt the tarball. Ship to off-site cold storage via a process that handles encryption in transit and at rest (e.g. `aws s3 cp --sse aws:kms`, `restic`, `borgmatic`).

If you need encrypted-at-rest tarballs, wrap the call:

```bash
./scripts/backup.sh ./backups
gpg --batch --yes --symmetric --cipher-algo AES256 \
  --passphrase-file "$HOME/.metis-backup-passphrase" \
  ./backups/metis-backup-*.tar.gz
shred -u ./backups/metis-backup-*.tar.gz
```

### 3.4 Full-instance portability (A → B)

To move a complete METIS instance to a fresh host — including the relational database, uploaded documents, and LanceDB vector store — use `pnpm export` (wraps `backup.sh`) on the source instance and `pnpm import` (wraps `restore.sh`) on the target. Both commands support `--dry-run` for safe rehearsal. `VAULT_MASTER_KEY` is never included in any export artifact and must be carried out-of-band via your organisation's secret manager or a sealed channel; without it, all encrypted connector secrets are permanently unrecoverable on the target. For the full ordered procedure, store inventory, fix-up checklist, and cross-provider guidance, see [`docs/DATA_PORTABILITY.md`](./DATA_PORTABILITY.md).

---

## 4. Vault Master-Key Rotation

`VAULT_MASTER_KEY` encrypts every connector credential, GitHub token, BYOK API key, and webhook secret stored in METIS. Rotate it on a schedule (recommended quarterly) and after any suspected compromise. It is also the **out-of-band dependency for full-instance portability** — see [`docs/DATA_PORTABILITY.md §7`](./DATA_PORTABILITY.md#7-carrying-vault_master_key-out-of-band) for transport options when moving to a new host.

### 4.1 Rotation procedure (operator runbook)

1. **Pre-flight**: take a fresh backup (`./scripts/backup.sh`). If anything goes wrong, you restore from this point.
2. **Generate a new key**:
   ```bash
   NEW_KEY=$(openssl rand -base64 32)
   ```
3. **Stop the application**:
   ```bash
   docker compose stop server ui
   ```
4. **Re-encrypt secrets** under the new key. The vault module supports a version byte on every ciphertext, so historical rows with the old key remain readable while you migrate. Run a one-shot script that:
   - reads every `Vault.entry` row,
   - decrypts using the existing `VAULT_MASTER_KEY`,
   - re-encrypts with `NEW_KEY`,
   - writes back atomically per row (transaction-per-row, so a mid-rotation failure leaves no partial ciphertexts).

   A reference implementation is tracked in follow-up issue #150 (`pnpm vault:rotate` CLI). For v1.0.0, perform rotation by spinning up a one-off container with both keys exported (`VAULT_MASTER_KEY=<old>` + `VAULT_NEXT_KEY=<new>`) and running the rotation Prisma script.
5. **Swap the active key**:
   ```bash
   sed -i 's|^VAULT_MASTER_KEY=.*|VAULT_MASTER_KEY='"$NEW_KEY"'|' .env.prod
   ```
6. **Restart**:
   ```bash
   docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml up -d
   ```
7. **Verify** `/readyz` reports `vault: ok` and a sample connector still resolves a credential (e.g. trigger a connector refresh from the UI).
8. **Securely destroy the old key** from your secret store / password manager.

### 4.2 JWT secret rotation

`JWT_SECRET` rotation invalidates all live access tokens. To roll without forcing immediate re-login, deploy with both old and new secrets accepted for the refresh window (tracked in follow-up #151). Until that lands, perform JWT rotation during a maintenance window and notify users.

---

## 5. Incident Runbook

### 5.1 `/readyz` returning 503

1. Inspect the JSON body — it lists the failing subsystem.
2. `database: error` → check Postgres connectivity, disk space, and `max_connections`.
3. `vault: error` → `VAULT_MASTER_KEY` is unset or the wrong length (must be 32-byte base64).
4. `mcp: error` → check the per-server status in the admin UI; inspect logs for the failing MCP child process.
5. `ai: degraded` → the configured AI provider gateway is unreachable; new chat sessions will fail until restored.

### 5.2 High 5xx rate

1. Filter logs by `status >= 500` and group by `route`.
2. Check `metis_http_request_errors_total` per route in Prometheus.
3. If one route dominates, pull the corresponding `correlationId` series and trace the failure into the relevant service module.

### 5.3 Suspected secret leak

1. Rotate the leaked credential at the source (GitHub PAT, BYOK API key, webhook secret).
2. Update the `Vault.entry` via the connector edit UI — old ciphertext is overwritten in place.
3. Audit the `AuditLog` table for `connector.update` / `vault.write` events around the leak window.
4. If the leak vector is unknown, also rotate `VAULT_MASTER_KEY` (§4) and `JWT_SECRET`.

### 5.4 Disk pressure

`server/data/uploads` and `server/data/lancedb` grow with usage. Monitor with the host's filesystem alerts. To free space:
- Archive completed projects (UI: project → Archive) — uploads remain on disk but new analyses skip them.
- Drop old `AuditLog` rows >90 days (until the in-app retention archiver lands in v1.1.x).

### 5.5 PR-reviewer queue depth & DLQ replay (Epic #394 P2)

The PR-reviewer runs an **in-memory** async queue (Epic #394 P2 #403,
deliberately deferred BullMQ — see ARCHITECTURE.md §17.X). Queue state
is process-local and lost on restart; observability + recovery rely on
audit rows and GitHub's webhook redelivery.

**Symptoms to watch for:**

- Spike in `pr_review.dlq` audit rows → jobs are exceeding `maxAttempts` (3). Look at the `errorMessage` metadata field for the underlying failure (judge LLM 5xx, Octokit rate-limit, etc.).
- `pr_review.webhook_dedup_failed` `logger.warn` lines (Epic #394 P2 review F2) → the dedup table is unreachable. Duplicate reviews may be posted until the DB recovers; verify Postgres health.
- `pr_review.processor_unconfigured` lines → an enqueued payload reached the worker but the production processor (judge + Octokit) was never wired in this deployment. Check the worker bootstrap in `server/src/server.ts`.

**Replay a DLQ entry manually:**

1. Query `audit_logs` for `action = 'pr_review.dlq'` and copy the `metadata.deliveryId`, `metadata.projectId`, `metadata.repoOwner`, `metadata.repoName`, `metadata.prNumber` fields.
2. Trigger a re-review via the manual UI button (`/projects/:id/pulls/:prNumber` → "Re-run review") OR call the REST endpoint directly:
   ```bash
   curl -X POST \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"owner":"<repoOwner>","repo":"<repoName>"}' \
     https://<host>/api/projects/<projectId>/pr-reviews/<prNumber>/re-review
   ```
   Caller must hold `pr.review.manage`. Returns `202` with the new `jobId`.
3. The replay synthesises a fresh `manual-rerun-…` delivery id so the dedup table will not short-circuit it.

**Drain the queue before deploy:**

The bootstrap registers `prReviewWorker.shutdown()` on `SIGTERM` /
`SIGINT`, which:

- Marks the queue as shutting down so new enqueues are rejected (the webhook returns its dedup row but the enqueue becomes a sentinel `prr-shutdown-rejected` — GitHub will redeliver on the next process).
- Cancels every pending retry timer so they cannot re-fire into a dead pool.
- Awaits in-flight processors so the AgentRun + audit row are written before exit.

The 10-second forced-exit timer in `index.ts` will still cut the
process off if shutdown stalls; check logs for `pr_review.dlq` from
in-flight jobs that were killed mid-flight.

**Dedup table maintenance:**

The worker schedules `purgeOldDeliveries()` every 1 hour (default
`DEFAULT_PURGE_INTERVAL_MS`). The function deletes
`prReviewWebhookDelivery` rows older than 24h. If the table has grown
unexpectedly large (long worker downtime), run it ad hoc from a one-off
shell:

```bash
psql "$DATABASE_URL" -c "DELETE FROM \"prReviewWebhookDelivery\" WHERE \"receivedAt\" < NOW() - INTERVAL '24 hours';"
```

---

## 6. Routine Maintenance

| Cadence | Task |
|---|---|
| Daily | Backup runs (`scripts/backup.sh` via cron) |
| Weekly | Review `pnpm audit --prod` output and patch high/critical CVEs |
| Weekly | Cross-check the [MCP image denylist](./SECURITY.md#35-third-party-mcp-server-hygiene) against new GHSA / NVD advisories; rotate or override every match (denylist + override policy in `SECURITY.md` §3.5). |
| Monthly | Verify a restore works against a scratch host |
| Quarterly | Rotate `VAULT_MASTER_KEY` (§4) |
| Quarterly | Review user roles & RBAC assignments |
| Quarterly | Conduct a **DR drill** (§10) — auto-opened issue from `.github/workflows/dr-drill-schedule.yml` |
| Per release | Re-run `pnpm test:coverage` and confirm gates still pass |
| Per release | Re-run `pnpm verify:image-size` after rebuilding the Docker images |
| After any embedding-model / pooling / dtype change | `pnpm embeddings:migrate status`, then follow the runbook (below) |

### 6.1 Embedding-model migration

Changing `EMBED_MODEL` (or `EMBED_POOLING*` / `EMBED_DTYPE`) changes the **vector
space**. Stored vectors are model-tagged, so nothing is corrupted or mis-scored —
but every project's dense retrieval degrades to **BM25-only** until it is
re-embedded, and on `VECTOR_STORE=pgvector` the shared `vector(N)` column must be
migrated before a vector of the new width can be written at all.

```bash
pnpm embeddings:migrate status          # exits non-zero while work remains
pnpm embeddings:migrate prepare --force # pgvector only — destructive to vectors
pnpm embeddings:migrate reindex --all   # per-project shadow build + atomic cutover
```

The reindex is **resumable**: an interrupted run (pod eviction, OOM kill, rolling
deploy) leaves its shadow table as a checkpoint, and re-running the same command
picks up where it stopped. Rollback is a forward operation — chunk text is the
source of truth, so pointing `EMBED_MODEL` back at the old model and reindexing
restores the previous index exactly.

Full runbook, including the EKS specifics, the pgvector column-width path and what
is kept vs lost on a rollback:
[docs/EMBEDDINGS_BACKENDS.md § Runbook](./EMBEDDINGS_BACKENDS.md#runbook--migrating-a-deployment-to-a-new-embedding-model-787).

---

## 7. Container Image Sizes

The release pipeline ships three images:

| Image | Built from | Current size | Budget |
|---|---|---|---|
| `metis-ui` | `Dockerfile.ui` (Next.js 15 standalone, alpine) | **~197 MB** | ≤ 350 MB ✅ |
| `metis-server` | `Dockerfile.server` (`node:22-trixie-slim`, glibc, prod-only deps, slimmed) | **~__MEASURED__ MB** (amd64, measured #39) | ≤ 1,170 MB — its own budget, see below |
| `metis-embeddings` | `Dockerfile.embeddings` (bookworm-slim, glibc) | **~423 MB** | exempt (sidecar) |

> **Multi-arch (Epic #360 / sub-issue #373)**: All four core images
> (`metis-server`, `metis-ui`, `metis-embeddings-svc`, `metis-copilot-svc`)
> are published as `linux/amd64,linux/arm64` manifests on every release tag
> via `.github/workflows/build-images.yml`. EKS Graviton nodes pull native
> arm64 binaries — no `qemu` emulation overhead. Verify with
> `docker buildx imagetools inspect ghcr.io/openzigs/metis-server:<tag>`.

### How the slim `metis-server` was achieved (issue #145)

Issue #145 reduced `metis-server` from **~1.19 GB → ~329 MB** (a 72 % cut)
by combining three changes:

1. **Embeddings sidecar (`metis-embeddings`)** — `@huggingface/transformers` and
   `onnxruntime-node` (the cross-encoder reranker too) moved into a separate
   `node:20-bookworm-slim` service exposed over token-authenticated HTTP. See
   [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) for the wiring. The sidecar is
   intentionally exempt from the per-image budget — it owns ~340 MB of native
   ONNX runtime + bundled models.
2. **Copilot CLI dropped from the runtime image** — the slim build no longer
   ships `@github/copilot` or `@github/copilot-sdk`. **The `copilot-native`
   AI provider is therefore unsupported in this image.** All other providers
   (`bedrock-gateway`, `openai`, `azure`, `anthropic`, `offline-stub`) work
   normally because the SDK is loaded via dynamic import. To use Copilot,
   either build a bespoke image with `@github/copilot` re-added or switch to
   a HTTP-based provider.
3. **Aggressive `node_modules` prune** — `Dockerfile.server` now does a clean
   `pnpm install --prod --frozen-lockfile` in a dedicated `prod-deps` stage,
   then surgically removes:
   - `typescript` (the `prisma` CLI, `effect`, `fast-check` and the rest of
     `@prisma/config`'s tree were deleted here too until #39 — the boot-time
     migration guard runs that CLI, so the image could not start without it)
   - All `@types/*` packages
   - All `*.map`, `*.d.ts`, and source `*.ts` files
   - `node-sql-parser`'s 45 MB UMD bundle and 23 MB `build/` dir
   - `pdfjs-dist`'s modern `build/`, `web/`, and `image_decoders/` dirs (we
     only use the legacy build via `pdf-parse`)
   - All `@prisma/client/runtime` query engines/compilers for non-Postgres
     databases (cockroachdb, mysql, sqlserver, sqlite)
   - All READMEs/CHANGELOGs/docs/examples/test directories under `node_modules`

### Why the server's budget is 900 MB, not 350 (#34)

The ~329 MB above was never re-measured as the image grew. The first amd64 build
to reach the gate on a GitHub-hosted runner measured **1,301 MB**. Three causes:
the Oracle Instant Client was added to the runtime stage (the comment beside it
said ~35 MB; it unpacks to 164 MB), the tree-sitter grammar packages arrived
with C sources and six platforms' native builds each, and the prune globs had
silently stopped matching — `@github+copilot-linux-*` never matched the
`copilot-linuxmusl-x64` package (158 MB), and Prisma 7 renamed the query
compilers the `query_compiler_bg.*` globs were written for.

#34 took it to **839 MB**, then ~820 MB (CI figures are decimal MB from
`docker image inspect`):

| Removed | Saved |
|---|---|
| Copilot CLI binary (`@github/copilot-linuxmusl-x64`) — the glob fix, plus the Copilot SDK excluded from the reachability prune | ~160 MB |
| tree-sitter C sources and native prebuilds (the server loads only the `.wasm`, via `web-tree-sitter`) | ~125 MB |
| The `prisma` CLI's tree — `@prisma/studio-core`, `@prisma/dev`, `@electric-sql/pglite`, react-dom and 58 more — by the reachability prune (`scripts/lib/prune-pnpm-store.mjs`) | ~80 MB |
| Prisma 7 query compilers for cockroachdb / mysql / sqlserver | ~45 MB |
| Other platforms' `prebuilds/`, better-sqlite3's SQLite sources and object files | ~40 MB |
| Oracle's JDBC jars (`ojdbc*.jar`, `ucp*.jar`) — thick mode loads only the `.so` libraries | ~27 MB |
| npm, npx, yarn and corepack from the runtime stage | ~23 MB |

What is left, measured in the amd64 image (MiB, from `du`):

| Component | Size | Notes |
|---|---|---|
| Oracle Instant Client (basiclite 23.9, `.so` only) | ~138 | Thick mode (pre-12c password verifiers); did not load in this image — loads since #39 |
| Node.js 20 runtime (`/usr/local`) | ~104 | The `node` binary alone is 97 |
| `@lancedb/vectordb-linux-x64-gnu` | ~99 | Single native library; did not load on musl — loads on the glibc base since #39 |
| `@napi-rs/canvas` ×3 (pdf-parse and two `pdfjs-dist` versions each pin their own) | ~88 | Native (musl then; glibc since #39) |
| `tesseract.js-core` | ~44 | OCR WASM, via `officeparser` |
| `@prisma/client` | ~41 | After the prunes |
| mermaid, `@kubernetes/client-node`, playwright-core, cytoscape, pdfjs-dist ×2 | ~92 | |
| Everything else in `node_modules` | ~212 | ~750 store entries |
| Compiled server (`server/dist`) + Prisma schema | ~29 | |

#34 measured **821 MB** (`api` run 35673206512) and set a provisional 900 MB
budget. That image did not start (#39), so neither figure described a working
server.

### Why the server's budget is 1,170 MB (#39)

The 821 MB image exited at import time and could not have run even if it had
got further. The fixes that make it start, measured on amd64 (`du`, MiB; the
`api` job's `docker image inspect` figure is the authoritative one):

| Change | Effect | Why |
|---|---|---|
| Runtime base `node:20-alpine` → `node:22-trixie-slim` (glibc) | +97 | LanceDB — the default vector store — publishes `@lancedb/vectordb-linux-{x64,arm64}-gnu` only. On musl it fails to relocate (`__register_atfork: symbol not found`), which `gcompat` does not provide. The deprecated `vectordb` package the server uses (0.21) has no musl build; its successor `@lancedb/lancedb` does (`linux-{x64,arm64}-musl`), so a return to alpine means migrating the vector store to that SDK first — a code change, not an image change. Oracle's Instant Client is a glibc build too. Trixie rather than bookworm because better-sqlite3 13's prebuilt binary needs glibc ≥ 2.38 (bookworm has 2.36); Node 22 because that is the repository's `engines.node` floor and better-sqlite3 13 requires it |
| The Prisma CLI tree is kept (`prisma`, `@prisma/studio-core`, `@prisma/engines`, `@electric-sql/pglite`, `effect`, react-dom, …) | +150 | `server/src/lib/db/migration-guard.ts` runs `prisma migrate deploy` before the server listens. It used to spawn `pnpm exec prisma`, and the runtime ships no package manager; it now runs the CLI with the server's own `node`. `prisma/build/index.js` requires studio-core and `@prisma/dev` statically, so the tree cannot be trimmed further by reachability |
| `@napi-rs/canvas` ×3: `linux-x64-gnu` replaces `linux-x64-musl` | +9 | |
| `@prisma/debug`, `mysql2`, `fast-check`, `jszip` restored | <2 | Runtime imports of `@prisma/driver-adapter-utils`, the MySQL connector, `effect`, and `archive-extract.ts` respectively |
| Oracle Instant Client on the loader path (`ld.so.conf.d` + `libaio`) | <1 | `initOracleClient` failed with `DPI-1047` without it |

In total the image grew from 860 to 1,111 MiB by `du` (849 → 1,101 MB of
uncompressed layers), and the `api` job measured it at **__MEASURED__ MB**. The
gate holds it to **1,170 MB** (`DEFAULT_MAX_SERVER_IMAGE_MB` in
`scripts/lib/verify-image-size.mjs`, overridable with `MAX_SERVER_IMAGE_MB`) —
that measurement plus ~10% headroom, as a regression guard. `metis-ui` stays on
the general 350 MB.

Every row of the #34 breakdown above now loads: the `api` job starts the image,
waits for `/healthz`, and then loads LanceDB, `mysql2`, `better-sqlite3` and
`oracledb` in thick mode inside the running container
(`scripts/lib/smoke-server-image.mjs`). A size figure for an image that does not
pass that step is not a measurement of this product.

Reducible contributors still in the image, measured in review of #38:

- The Oracle Instant Client (~138 MB) — the strongest candidate for a build
  argument; only the Oracle connector's thick mode (pre-12c password verifiers)
  uses it
- The Prisma CLI tree (~150 MiB), kept only for the boot-time migration guard —
  running `prisma migrate deploy` as a separate init step instead would let the
  image drop it
- Three copies of `@napi-rs/canvas` (~55 MB recoverable by deduplicating to one
  version — needs `pdfjs-dist` aligned across `pdf-parse` and `officeparser`)
- `tesseract.js-core` WASM variants (~35 MB — 12 variants ship, about 2 are used)
- `@azure/msal-browser`, a browser library, in a server image
- better-sqlite3 build leftovers (`build/Release/obj` and `sqlite3.a`, ~13 MB)

Moving LanceDB to `pgvector` or a sidecar (~99 MB) is a feature decision
rather than a prune.

### Enforcing the budget

The `pnpm verify:image-size` script (`scripts/lib/verify-image-size.mjs`; the
older `scripts/verify-image-size.sh` does the same) builds both **gated** images
and asserts `metis-ui` is ≤ `MAX_IMAGE_MB` (default **350**) and `metis-server`
is ≤ `MAX_SERVER_IMAGE_MB` (default **1,170**).
The embeddings sidecar size is reported but not gated. The script exits
non-zero when the budget is exceeded and is wired into CI as part of the
`api` job.

```bash
# Build + verify
pnpm verify:image-size

# Verify already-built images
SERVER_TAG=metis-server:test UI_TAG=metis-ui:test \
  bash scripts/verify-image-size.sh --no-build

# Tighten the budgets (e.g. after the LanceDB sidecar lands)
MAX_IMAGE_MB=250 MAX_SERVER_IMAGE_MB=700 pnpm verify:image-size
```

### CI build cache (#3)

`ci.yml`'s `api` job builds the four images with `docker/build-push-action`
and caches layers in the GitHub Actions cache (`type=gha`, one `scope` per
image, `mode=max` so the multi-stage builders' `pnpm install` layers are cached
too). `build-images.yml` uses the same scopes, but its release-tag build
only reads the cache. A run can restore caches written by its own ref or by
the default branch, so a tag run reads `main`'s cache, but a cache written
from a tag can be restored only by that same tag — it would never be read
again and would only spend the 10 GB repository limit. The earlier caches — the
self-hosted daemon's layer store, and a `type=local` directory under
`/tmp/buildkit-cache` — were properties of that machine and are empty on every
hosted VM. Before building, both workflows delete preinstalled toolchains the
build never uses (.NET, Android SDK, GHC, CodeQL) and the runner's cached
Docker images.

Measured on #38 (hosted `ubuntu-latest`, amd64), from the `api` job's step
timings (`gh api repos/openzigs/metis/actions/jobs/<id>`):

| Cache | Run (job) | server | ui | embeddings | sql-lineage | four builds | whole `api` job |
|---|---|---|---|---|---|---|---|
| Cold — first run, empty cache | 35671126250 (106567592133) | 7m19s | 3m42s | 2m11s | 18s | 13m30s | 28m20s |
| Partly warm — new commit, server source changed | 35673206512 attempt 1 (106574086399) | 3m03s | 2m47s | 1m49s | 6s | 7m45s | 23m22s |
| Warm — re-run of the same commit | 35673206512 attempt 2 (106589624773) | 2m31s | 2m33s | 2m12s | 9s | 7m25s | 18m46s |

The cache roughly halves the image builds (13m30s → 7m25s) and brings the
whole job from 28m20s to under 19 minutes, well inside its 60-minute timeout.
It does not bring a warm build to seconds: every dependency-install layer
restores as `CACHED`, but in the warm run the compile steps after the source
`COPY` (`pnpm --filter @metis/server build`, `next build`) still re-ran, and
restoring and re-exporting the `mode=max` cache costs 15–60 s per image. The
rest of the job is not image building: `Test` took 8–11 minutes in each run.

Freeing disk took 45s–1m49s across these runs; in the warm run it took the
runner from 83 GB to 110 GB free.

### Embeddings sidecar deployment notes

- Set `EMBEDDINGS_TOKEN` to a 32+ byte random value in production. The
  sidecar is **fail-closed** — any request without a matching bearer token
  returns `503` when `EMBEDDINGS_TOKEN` is unset on the sidecar, and `401`
  when it's set but the request omits / mismatches it.
- Both `docker-compose.yml` (dev) and `docker-compose.prod.yml` (prod) wire
  `embeddings` as a healthchecked dependency of `server`. The server reads
  `EMBEDDINGS_MODE=sidecar`, `EMBEDDINGS_URL=http://embeddings:5050`, and
  `EMBEDDINGS_TOKEN` from the environment.
- The sidecar persists downloaded models in a named volume
  (`embeddings_cache:/var/cache/metis-embeddings`) so cold starts after a
  restart don't re-download `Xenova/bge-small-en-v1.5` and
  `Xenova/ms-marco-MiniLM-L-6-v2`.
- Healthcheck endpoint: `GET /healthz` (no auth) returns
  `{ "status": "ok", "service": "metis-embeddings", "tokenConfigured": true|false }`.

---

## 7.1 Optional Sidecars

The slim `metis-server` image ships only the providers and runtimes the
default deployment needs. Anything heavyweight — the embeddings + reranker
ONNX runtime, the GitHub Copilot SDK — runs in a dedicated, optional
sidecar container so the main image stays under the 350 MB budget.

| Sidecar | Image | Purpose | Activate via | Reference |
|---|---|---|---|---|
| `metis-embeddings` | `Dockerfile.embeddings` | RAG embeddings + cross-encoder reranker (`Xenova/bge-small-en-v1.5`, `Xenova/ms-marco-MiniLM-L-6-v2`) | `EMBEDDINGS_MODE=sidecar`, `EMBEDDINGS_URL`, `EMBEDDINGS_TOKEN` | See §7 above + [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) |
| `metis-copilot-svc` | `Dockerfile.copilot-svc` | `@github/copilot-sdk` device auth + sessions, exposed over HTTP/SSE | `COPILOT_NATIVE_MODE=sidecar`, `COPILOT_NATIVE_BASE_URL`, `COPILOT_NATIVE_TOKEN` | [`docs/COPILOT_SIDECAR.md`](./COPILOT_SIDECAR.md) |

Both sidecars are **fail-closed**: missing tokens, unreachable endpoints,
or mismatched bearer credentials are surfaced as 5xx in the AI session
flow rather than silently downgraded. Operators should treat them as
first-class dependencies in their orchestration (Kubernetes
`livenessProbe`/`readinessProbe`, ECS health checks, etc.).

When neither sidecar is required (e.g. a Bedrock-only deployment with a
pre-cached embedding store), both can be omitted from the compose file —
the server detects `EMBEDDINGS_MODE` defaults and falls back to
`bedrock-gateway` / `openai` / `anthropic` providers cleanly. The
`copilot-native` provider is simply unavailable in that configuration; see
[`docs/COPILOT_SIDECAR.md`](./COPILOT_SIDECAR.md) for the bring-up
checklist when you do want it.

### 7.2 Dockerised MCP Runtime (Epic #271)

The METIS server image no longer bakes in `uvx`, `jbang`, `npx`, etc. Instead,
each MCP server can declare a `runtime` of `docker-stdio`, and the lifecycle
manager spawns a wrapper container per MCP via `docker run -i --rm`. To enable
this on a production host:

1. **Bring up the `metis-mcp` bridge network** (default name `metis-mcp`,
   override with `MCP_DOCKER_NETWORK`). As of Epic #359 the network is
   declared in both `docker-compose.yml` and `docker-compose.prod.yml`, so
   `docker compose up` (or `pnpm bootstrap:up`) **auto-creates it**. Run
   the manual command only when you are running the METIS server outside
   compose:
   ```bash
   # Optional — only needed when METIS itself is not run via docker compose.
   docker network create metis-mcp
   ```
   `pnpm bootstrap:check` (Epic #359 / issue #365) reports the presence of
   this network so you can spot a missing one before the first MCP
   registration. Without the network, every `docker-stdio` MCP fails to
   start with `network metis-mcp not found`.

2. **Mount the Docker socket** into the METIS server container so it can spawn
   sibling containers (already wired in `docker-compose.prod.yml`).

3. **Build & publish the wrapper images** (one-time, repeat on upgrade):
   ```bash
   ./images/mcp-wrappers/build.sh push        # → ghcr.io/metis-mcps/{uvx,jbang,node,npx}-runner:<version>
   ```
   Override the registry with `REGISTRY=… ./images/mcp-wrappers/build.sh push`.

4. **Allow the wrapper images** by adding them to `MCP_IMAGE_ALLOWLIST`
   (Settings → Configuration). The provisioner re-validates the image at
   provision time, so an off-allowlist image is rejected with a structured
   error before any container starts.

   **Glob semantics (issue #304):** `*` matches a single path segment and
   does NOT span `/`; `**` matches any number of segments (including `/`).
   Pattern `ghcr.io/metis-mcps/*` matches `ghcr.io/metis-mcps/uvx-runner:1.0`
   but NOT `ghcr.io/metis-mcps/team/lib:1.0`. Use `ghcr.io/metis-mcps/**`
   when nested paths must be allowed. Tags (`:tag`) and digests (`@sha256:…`)
   are stripped before matching.

5. **Tune resource limits** via the runtime config keys: `MCP_DOCKER_MEMORY_LIMIT`
   (default `512m`), `MCP_DOCKER_CPU_LIMIT` (default `1.0`),
   `MCP_DOCKER_START_TIMEOUT_MS` (default `30000`).

Containers are named `metis-mcp-<serverId>-<short-uuid>` so `docker ps` /
`docker logs` lookups are predictable. On lifecycle stop the manager runs
`docker rm -f` as a best-effort cleanup; orphans (e.g. from a hard crash) can
be reaped manually with:
```bash
docker ps -a --filter "name=metis-mcp-" -q | xargs -r docker rm -f
```

### 7.3 Kubernetes-native MCP Runtime (Epic #272 — `k8s-sse`)

When METIS itself runs on Kubernetes, MCPs can be promoted to one-pod-per-MCP
isolation (`runtime: 'k8s-sse'`). The wrapper image must use `mcp-proxy` to
expose the MCP's stdio transport as HTTP+SSE on `:8080` — use any of the
`*-runner-sse` images shipped under `images/mcp-wrappers/` or build your own.

Cluster-side prerequisites — METIS does **not** create these:

1. **Namespace** — the per-MCP resources live in `MCP_K8S_NAMESPACE` (default
   `metis-mcp`). Create it with whatever namespace policy your cluster
   enforces (e.g. PSA `restricted`).
   ```bash
   kubectl create namespace metis-mcp
   ```

2. **CNI plugin with NetworkPolicy enforcement** — the deny-default egress
   policy METIS writes is only meaningful with a CNI that enforces
   `NetworkPolicy`. **Calico** and **Cilium** both work; the AWS VPC CNI
   alone does not. For *hostname* allowlist entries (`host:api.example.com`)
   you need an L7 / FQDN-aware policy engine — **Cilium FQDN Network
   Policies** are the supported path. Without FQDN enforcement, `host:`
   entries collapse to a permissive HTTP/HTTPS egress rule (TCP/80 + 443).

3. **IAM (EKS only)** — pre-provision an IRSA role per MCP using the
   convention `<MCP_K8S_IRSA_ROLE_ARN_PREFIX>-<server-id>` and attach the
   trust relationship to the per-MCP ServiceAccount
   `mcp-<sha256(serverId)[:12]>` in `MCP_K8S_NAMESPACE`. METIS only
   *annotates* the SA with the resolved ARN; it never touches IAM.

4. **METIS pod RBAC** — METIS needs Role rules to manage Deployments,
   Services, NetworkPolicies, ServiceAccounts and (since #317)
   per-MCP **Secrets** in `MCP_K8S_NAMESPACE`. Each MCP's resolved env vars
   are projected into a dedicated `Secret` and the Deployment references
   them via `valueFrom.secretKeyRef` — values are NEVER inlined as
   `containers[].env[].value`, so anyone with `get deployment` on the
   namespace cannot read MCP credentials. Only the metis-server
   ServiceAccount (the one bound to the role below) should hold
   `get/list/create/delete` on `secrets` in `metis-mcp` — do NOT widen
   this to operator humans or to other workload SAs. The Helm chart at
   [`deploy/helm/metis/templates/rbac.yaml`](../deploy/helm/metis/templates/rbac.yaml)
   ships these as a `Role` + `RoleBinding` (default `rbac.scope: namespaced`)
   or `ClusterRole` + `ClusterRoleBinding` (`rbac.scope: cluster`). The
   server's own ServiceAccount (`serviceAccount.create: true`,
   `serviceAccount.annotations` for IRSA) is rendered alongside.

   For non-Helm operators, the equivalent manifest is:
   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: Role
   metadata: { name: metis-mcp-provisioner, namespace: metis-mcp }
   rules:
     - apiGroups: [""]            ; resources: [services, serviceaccounts] ; verbs: [get, create, delete]
     - apiGroups: [""]            ; resources: [secrets]                   ; verbs: [get, create, delete]
     - apiGroups: ["apps"]         ; resources: [deployments]              ; verbs: [get, create, delete, patch]
     - apiGroups: ["networking.k8s.io"] ; resources: [networkpolicies]     ; verbs: [get, create, delete]
   ```

5. **Image allowlist** — register the SSE wrapper images in
   `MCP_IMAGE_ALLOWLIST` exactly as you do for `docker-stdio` (the
   provisioner re-validates at provision time).

6. **Resource defaults** — the per-MCP container is sized via
   `MCP_K8S_MEMORY_LIMIT` / `MCP_K8S_MEMORY_REQUEST` /
   `MCP_K8S_CPU_LIMIT` / `MCP_K8S_CPU_REQUEST`. Each MCP can override
   memory/CPU limits from the admin UI (`k8sMemoryLimit` / `k8sCpuLimit`).

7. **Cold-start (optional)** — toggling **Cold start (scale to zero when
   idle)** in the UI marks the row `coldStart=true`. The
   `K8sColdStartReaper` (sweep interval `MCP_COLD_START_SWEEP_INTERVAL_MS`,
   default 5 min) scales matching idle-for-`MCP_COLD_START_IDLE_MIN` (default
   10 min) Deployments to `replicas=0`. The first tool call after that
   transparently scales it back to `1` and waits up to
   `MCP_K8S_PROVISION_TIMEOUT_MS` for `readyReplicas >= 1`.

8. **Log throttling** — pod stdout/stderr is mirrored into the METIS log via
   a token bucket. Tunables: `MCP_LOG_RATE_PER_SEC` (default 50),
   `MCP_LOG_BURST` (default 200), `MCP_LOG_THROTTLE_WARN_INTERVAL_MS`
   (default 60000). On overflow, METIS emits at most one warn per interval
   with the cumulative drop count. CloudWatch / Container Insights / Fluent
   Bit handle the canonical pod log shipping out-of-band.

Reaping orphan resources after a hard crash:
```bash
kubectl -n metis-mcp delete deploy,svc,networkpolicy,sa,secret -l metis.io/managed-by=mcp-provisioner
```

---

## 7.4 Kubernetes deployment (Helm)

For production EKS or any other Kubernetes target, METIS ships a Helm chart
at [`deploy/helm/metis/`](../deploy/helm/metis/). The chart covers all four
core services plus PVCs, External Secrets Operator integration, ALB / nginx
/ traefik Ingress, ServiceAccount + RBAC + IRSA wiring, HPA, PDB, and a
deny-default NetworkPolicy.

```bash
helm install metis ./deploy/helm/metis \
  -n metis --create-namespace \
  -f deploy/helm/metis/values-prod.yaml
```

**Operator entry points**:

- [`docs/EKS_DEPLOYMENT.md`](./EKS_DEPLOYMENT.md) — green-field guide from
  empty AWS account to working `helm install`.
- [`docs/K8S_PROD_CHECKLIST.md`](./K8S_PROD_CHECKLIST.md) — pre-traffic
  audit covering probes, PDB, NetworkPolicy, RBAC, IRSA, image scanning,
  PVC backup.
- [`deploy/helm/metis/README.md`](../deploy/helm/metis/README.md) — values
  reference, three-mode secrets story, ingress controller switch, footguns.

The chart hard-fails `helm template` if `server.replicaCount > 1` is set
without `persistence.efs.enabled=true` — LanceDB plus the in-process
scheduler are still single-writer; do not unlock multi-replica server
without externalising both.

### 7.5 Prompt Caching (Epic #647)

Prompt caching reduces inference costs by up to 90% for repeated system
prompts and context. METIS uses two complementary mechanisms:

| Path | Mechanism | Configuration |
|------|-----------|---------------|
| **Chat/stream, discussions, spec-kit** (interactive flows) | The server sets `promptCaching.system` + a `callType` tag on these flows (#700). The flags are **honoured only** on the BedrockDirect (`extra_body.prompt_caching`) and native-Anthropic (`cache_control`) providers; on the Copilot-SDK / bedrock-access-gateway path they are an **inert no-op** and caching is done by the gateway itself. | Server flags are automatic; the gateway path additionally needs `ENABLE_PROMPT_CACHING=true` on the bedrock-access-gateway container (#656) |
| **Analysis/docs-gen** (BedrockDirectProvider) | Per-request `extra_body.prompt_caching` sent by the server | Automatic when `BEDROCK_GATEWAY_URL` + `BEDROCK_GATEWAY_API_KEY` are set |
| **Native Anthropic** (AnthropicProvider) | Per-block `cache_control` on the system + last-user breakpoints; TTL via `ANTHROPIC_PROMPT_CACHE_TTL` (#702) | Automatic when `AI_PROVIDER=anthropic` |

**Gateway env vars** (set on the `bedrock-access-gateway` container, not on METIS):

```
ENABLE_PROMPT_CACHING=true
PROMPT_CACHE_TTL=1h          # optional — extends the gateway path from 5min to 1h,
                             # but ONLY on models that support 1h on Bedrock
                             # (Haiku 4.5 / Sonnet 4.5 / Opus 4.5); it is a no-op
                             # on the Sonnet 4.6 default route. Distinct from the
                             # native-Anthropic ANTHROPIC_PROMPT_CACHE_TTL (#702).
                             # See the TTL-availability matrix below.
```

#### Platform-split cache floors, TTL availability & cross-region caveat (Issue #703, epic #696)

This subsection is the **single source of truth** for cache floors, TTL
availability, and the cross-region caveat; the deeper subsections below reference
it. All figures were verified 2026-07 against the AWS and Anthropic docs during
the epic's P0 spike (#697).

**Cache floors are platform-specific.** Below the floor the platform caches
nothing and reports `cached_tokens = 0` with **no error** (a silent miss):

| Model (METIS route) | Bedrock floor | Direct Anthropic floor |
|---|---:|---:|
| Sonnet 4.6 — default / general route | **1,024** | **2,048** |
| Haiku 4.5 — faster / cheaper route | **4,096** | **4,096** |

Sources: [AWS Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html),
[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

The largest legitimate analysis prefix is **~2,225 tokens** (see the sizing
subsection below), so it clears the Sonnet floor on **both** platforms but never
the Haiku 4.5 floor — the Haiku route is **expected to register zero hits by
construction** (a pass, not a regression).

**TTL availability (model × platform × 5m/1h):**

| Model | Bedrock 5m | Bedrock 1h | Anthropic 5m | Anthropic 1h |
|---|:---:|:---:|:---:|:---:|
| Sonnet 4.6 (METIS default) | ✅ | ❌ | ✅ | ✅ |
| Opus 4.6 | ✅ | ❌ | ✅ | ✅ |
| Opus 4.5 | ✅ | ✅ | ✅ | ✅ |
| Sonnet 4.5 | ✅ | ✅ | ✅ | ✅ |
| Haiku 4.5 (METIS cheap route) | ✅ | ✅ | ✅ | ✅ |

Source: AWS Bedrock prompt-caching doc above. **Key asymmetry:** Bedrock has
**no 1-hour TTL for Sonnet 4.6 / Opus 4.6** (5-min only); on Bedrock the 1h TTL
exists only for Opus 4.5 / Sonnet 4.5 / Haiku 4.5. The **direct Anthropic API
offers 1h on all current models** (at the 2× write premium). Two config keys
drive TTL, one per path:

- **`PROMPT_CACHE_TTL`** on the bedrock-access-gateway container — extends the
  gateway path from 5m to 1h, but only on the models that support it there, so it
  is a no-op on the Sonnet 4.6 default route.
- **`ANTHROPIC_PROMPT_CACHE_TTL`** (`5m` default | `1h`, #702) — native-Anthropic
  path **only**; `bedrock-direct-provider.ts` never consults it and the cost path
  double-gates the 2× write multiplier on `provider === "anthropic"`, so
  Bedrock/gateway traffic can never pick up the 1h premium. Full break-even
  guidance is in the "Native-Anthropic 1-hour cache TTL (#702)" subsection below.

**Cross-region cache locality — do NOT pin regions.** METIS routes through
`us.anthropic.*` **cross-region application inference profiles**, chosen
deliberately for throughput/availability over raw hit rate. Those profiles keep
**region-local** caches, and AWS warns of **"increased cache writes"** under high
demand as requests fan out across regions, so **real hit rates run structurally
below the theoretical ceiling**. This is expected, not a defect — do **not**
propose pinning a single region to raise the hit rate. Instead **monitor the
actual hit rate** via `GET /api/admin/cache-telemetry` (#699, detailed below) and
read its `readWriteRatio` as the cross-region fragmentation signal rather than
assuming a hit rate from the floors. Sources:
[AWS Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html),
[5 things I learned about prompt caching in Amazon Bedrock](https://builder.aws.com/content/3ElydDhkvqaHao2TrGxd3Z76BQq/5-things-i-learned-about-prompt-caching-in-amazon-bedrock-the-hard-way).

**Cache reads do not consume rate-limit quota** on either platform — Bedrock
excludes cache hits from your rate limit, and Anthropic cache reads don't count
toward ITPM. Sources: AWS doc above,
[Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits).

**Config keys / decisions added by this epic (single-source index):**

| Key / tag | Path | Default | Issue |
|---|---|---|---|
| `promptCaching.system` + `callType` on chat/discussions/spec-kit (byte-stable chat prompt) | BedrockDirect + native only; inert on SDK/gateway | flags on, inert on gateway | #700 |
| `ANTHROPIC_PROMPT_CACHE_TTL` (`5m`\|`1h`) | native Anthropic only | `5m` | #702 |
| `DOCS_GEN_CLAIM_MODEL` (verdict: **keep Haiku** for claim extraction) | docs-gen claim extraction | unset → Haiku default kept | #701 |
| cache-aware `estimateUsageCostUsd` (0.1× read, 1.25× 5m / 2× 1h write; gateway path understates the write premium) | all cost estimates | — | #698 |
| `GET /api/admin/cache-telemetry` | admin readout | `admin.read` gated | #699 |

**Cross-references:** the end-to-end **verification matrix + harness** is the
"End-to-end cache verification" subsection at the end of §7.5 (#697); the live
`cached_tokens > 0` confirmation through the **deployed** Bedrock gateway is the
only remaining open item of this epic, tracked in **#704** (needs the deployed
gateway + a CloudWatch cross-check — it cannot be asserted locally or in CI).

#### Profile → model → cache-min-token mapping (Issue #387)

Bedrock's prompt-cache **minimum token threshold is model-specific**. Below the
threshold Bedrock silently does **not** cache — there is no error and
`cached_tokens` stays `0`. The leading cacheable system prefix must therefore
clear the floor of the **actual routed model**, which is the foundation model
wrapped by the application inference profile, not the profile name.

The verified mapping for the Metis routes is:

| Metis route | Model (foundation) | `model-router.ts` id | Bedrock floor | Bedrock 1h TTL |
|---|---|---|---|---|
| **General / default** | Claude **Sonnet 4.6** | `us.anthropic.claude-sonnet-4-6` | **1,024** | no |
| **Faster / cheaper** | Claude **Haiku 4.5** | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | **4,096** | yes |
| Legacy (informational) | Claude **Sonnet 4.5** | _no code path_ — operator-optional override only | **4,096** | yes |

> The floor and 1h-TTL columns above are **Bedrock** values (METIS's default
> platform). The **direct Anthropic** Sonnet 4.6 floor is **2,048** (Haiku 4.5 is
> 4,096 on both), and direct Anthropic offers 1h on all current models — see the
> platform-split floor and TTL-availability tables in the #703 subsection above.

`server/src/lib/ai/model-router.ts` is the source of truth and already encodes
Sonnet **4.6** + Haiku **4.5** (`SONNET_MODEL_ID` / `HAIKU_MODEL_ID`). The
**legacy Sonnet 4.5** entry is **informational only**: there is no env var or
code path for it. An operator who must pin the older foundation model can drop
its profile ARN into the optional `BEDROCK_SONNET_PROFILE` override
(see `.env.example`); doing so re-introduces the **4,096-token** floor on that
route.

> **Application inference profiles** wrap a foundation model and add
> cost-allocation tags; configure them via the optional `BEDROCK_SONNET_PROFILE`
> / `BEDROCK_HAIKU_PROFILE` ARNs in `.env.example`. Use placeholder ARNs of the
> form `arn:aws:bedrock:us-east-1:ACCOUNT:application-inference-profile/PROFILE_ID`
> — never commit real ARNs or account IDs. To confirm which foundation model a
> profile wraps, run
> `aws bedrock get-inference-profile --inference-profile-identifier <profile>`.

**Requirements**: the cacheable prefix must be **≥ the routed model's floor** —
on Bedrock, **1,024 tokens** on the Sonnet 4.6 default route and **4,096 tokens**
on the Haiku 4.5 (and legacy Sonnet 4.5) routes; on direct Anthropic the Sonnet
4.6 floor is **2,048** (see the #703 platform-split table above). Cache TTL resets
on each hit. Cache hits are reported via the existing `cacheReadTokens` /
`cacheWriteTokens` fields in METIS finops telemetry.

#### Cacheable-prefix sizing — measured (Issue #398, resolves #387's open finding)

#385 made the analysis/agent system prefix byte-stable and therefore cacheable
in principle, but #387 measured it at only **~660–880 tokens** (compact manifest)
— below the **1,024-token Sonnet 4.6 floor** at the low end and far below the
**4,096-token Haiku 4.5 floor**, so caching registered **~0 hits on Haiku** and
was borderline on Sonnet.

**#398 grew the byte-stable cached lead block — without filler — by folding two
kinds of genuinely-stable content in FRONT of the system cachePoint:**

1. A **standing analysis protocol** (`STANDING_ANALYSIS_PROTOCOL` in
   `server/src/lib/analysis/agent-loop.ts`) — the constant operating contract
   (trust/data-boundary rules, grounding/citation discipline, the JSON output
   contract). It is byte-identical for every request in the pipeline and applies
   to BOTH the agentic (tool-loop) and the single-shot requirement-grounded
   paths. Every line is a real rule, not padding.
2. The **full tool-definition JSON schemas** (`formatToolSchemas`) for the
   enabled tool set — types, descriptions, `required`, `enum`s — instead of the
   compact one-line manifest. These are stable for a given tool set and are the
   real interface contract the model needs.

All volatile per-request data (project name/description, requirement text, RAG /
graph code context, operator notes, ids, timestamps) still rides in the user
message behind the `===METIS-DATA-BOUNDARY===` fences, AFTER the cachePoint, per
#385 — nothing dynamic precedes the prefix.

**Measured prefix sizes** (repo char/≈4 heuristic, `estimateCachedPrefixTokens`;
asserted in `server/src/lib/analysis/agent-loop-caching.test.ts`):

| Path | Stable prefix | Sonnet 1,024 | Haiku 4,096 |
|---|---:|:---:|:---:|
| Agentic code, 4-tool set (clone present) | **~2,225 tok** | ✅ clears | ❌ gap |
| Agentic code, 2-tool set (no clone — worst case) | **~1,800 tok** | ✅ clears | ❌ gap |
| Requirement-grounded, no tools (worst case) | **~1,142 tok** | ✅ clears | ❌ gap |

> **Honest residual gap to the Haiku 4.5 floor (4,096 tokens).** The
> genuinely-stable content clears the **Sonnet 4.6 1,024-token floor on every
> path with margin**, but does **not** reach the **Haiku 4.5 4,096-token floor**
> without artificial filler — the largest legitimate prefix is ~2,225 tokens,
> roughly half the Haiku floor. Per the #398 honesty requirement we do **not**
> pad to hit the number. Caching therefore fires on the **Sonnet default route**
> but still registers **~0 hits on the Haiku route**. Options for the Haiku gap
> (none implemented here):
>
> - **Route Haiku-tier analysis work to Sonnet** when caching savings outweigh
>   the per-token price difference (the cached prefix is ~90% cheaper on reads).
> - **Accept no prompt caching on the Haiku cheap path** — it is already the
>   low-cost route; the absolute miss cost is small.
> - **Revisit the gateway 1h TTL** on Haiku so the few cache writes that *do*
>   land (if a future, larger stable tool set crosses 4,096) survive longer.
> - **Pin the legacy Sonnet 4.5 profile** only if its 4,096 floor is acceptable
>   — note that *raises* the floor, it does not help.
>
> The live `cached_tokens > 0` confirmation under sustained load — on **both**
> the Sonnet route (expected to register) and the Haiku route (expected to stay
> at 0 until the prefix crosses 4,096) — remains a tracked **manual follow-up**;
> it needs the live Bedrock gateway and cannot be asserted in unit tests. See
> the **end-to-end cache verification matrix + harness (#697)** at the end of
> this section; the live gateway legs are tracked in **#704**.

> **Note (updated by #700)**: The chat/stream, discussions, and spec-kit flows
> now **do** set `promptCaching.system` + a `callType` tag, but the Copilot SDK /
> bedrock-access-gateway path has no hook for provider-specific `extra_body`
> fields, so on that path the flags are an **inert no-op** — caching for the
> gateway path is still handled transparently by the gateway itself (#656, #657).
> The flags take effect only when these flows run on the BedrockDirect or
> native-Anthropic provider.

#### Cached-Sonnet vs uncached-Haiku — crossover analysis (Issue #701)

Two flows deliberately route to Haiku **below** its 4,096-token cache floor, so
they take **zero** cache hits by construction: docs-gen **claim extraction**
(`claimModel` in `holistic-synthesizer.ts`) and the model-router **budget
downgrade** (`model-router.ts`). Sonnet 4.6 clears its own **1,024-token** floor
with the same ~2,225-token prefix, so a **cached-Sonnet** variant is *feasible*
where cached-Haiku is not. Is it *cheaper*? That turns on the flow's
**input:output ratio** and **cache-hit rate**, not on the sticker price of the
"cheap" model.

The analysis is pure, unit-tested code in `server/src/lib/ai/cache-crossover.ts`.
It reuses the **single** rate table in `token-tracker.ts` (`MODEL_PRICING`,
`CACHE_READ_MULTIPLIER`, `estimateCostUsd`) — there is no second copy of the
rates. Per-1M-token rates: Sonnet $3 in / $15 out, Haiku $1 in / $5 out; cache
reads bill at **0.1×** input.

**The two cost legs** (per call, `I` = input tokens, `O` = output, `f` =
cache-read fraction of the input):

```
sonnetCached(f) = I·3·(1 − 0.9·f) + O·15      (all figures ÷1e6 USD)
haikuUncached   = I·1            + O·5
```

**Break-even cache-read fraction** (`breakEvenCacheReadFraction`):

```
f* = [ I·(3−1) + O·(15−5) ] / [ I·3·(1−0.1) ]  =  (2 + 10·(O/I)) / 2.7
```

**Winning-ratio ceiling** (`maxWinningOutputInputRatio`): solving `f* ≤ 1` gives

```
(O/I)*  =  (3·0.1 − 1) / (5 − 15)  =  0.07
```

i.e. **a flow whose output exceeds ~7% of its input can NEVER be made cheaper on
Sonnet by caching alone** — Sonnet's 3× output premium ($15 vs $5) outweighs any
input saving, regardless of hit rate. This ceiling is derived from
`MODEL_PRICING`, so it self-updates if the rate table changes.

**Static estimate for claim-extraction batches** (`CLAIM_EXTRACTION_STATIC_ESTIMATE`;
derived without a live run per the #701 reliability constraint):

| Component | Tokens | Source |
|---|---:|---|
| System prompt (`SYSTEM_PROMPT`, claim-extractor.ts) | ~230 | stable, cacheable |
| Source-id list | ~250 | stable-ish, cacheable |
| Section passage | ~1,000 | volatile |
| **Input total** | **~1,500** | |
| Output: ~15–25 atomic claims × ~35 tok | **~700** | JSON `{claim, sourceIds}` |

**Output:input ≈ 700 / 1,500 ≈ 0.47** — nearly **7× the 0.07 ceiling**. Only the
~480-token system+source-id prefix is cacheable (≈0.32 best-case read fraction),
but the verdict is **ratio-bound, not hit-rate-bound**:

> **Verdict: KEEP Haiku for claim extraction.** At the estimated ratio,
> cached-Sonnet costs **~$0.0110/call** vs Haiku's **~$0.0050/call** even at a
> 100% hit rate — Haiku is **~2× cheaper**. There is no interior break-even
> (`breakEvenCacheReadFraction` returns `null`). The same output-heavy logic
> applies to any Haiku-tier analysis reached via the budget downgrade, so that
> threshold is **left unchanged** too.

**Mechanism shipped (no behaviour change by default):** the claim-extraction
model is now selectable via the **`DOCS_GEN_CLAIM_MODEL`** tunable config key
(registered in `key-registry.ts`, read through
`server/src/lib/ai/claim-model-config.ts`). **Unset by default → the per-provider
Haiku default is preserved**, so doc-gen faithfulness cannot regress on the
default path. To flip claim extraction onto cached-Sonnet for a workload that a
future measurement proves cheaper, set it to a Sonnet id:

```
DOCS_GEN_CLAIM_MODEL=us.anthropic.claude-sonnet-4-6   # Bedrock
DOCS_GEN_CLAIM_MODEL=claude-sonnet-4-6                # native Anthropic
```

Precedence: the provider-specific `DOCS_GEN_ANTHROPIC_CLAIM_MODEL` /
`DOCS_GEN_BEDROCK_CLAIM_MODEL` and the shared `DOCS_GEN_GROUNDING_MODEL` still win
over this cross-provider key. **Rollback = unset the key** (env removal or admin
config unset). The local provider ignores it (one served model).

**Instrumentation for later validation:** claim-extraction `chat` calls now carry
their own `callType: "claim-extraction"` (split out of the shared `"grounding"`
bucket in `types.ts`), so their **real** input:output ratio and cache-hit rate
surface distinctly in `GET /api/admin/cache-telemetry` (#699) and the cache-aware
cost field (#698). Budget-downgraded analysis already carries `callType:
"agent-loop"` with `model=haiku`, so it is identifiable in the same telemetry.
These static figures are order-of-magnitude; **production-validated numbers
finalise via #699 / the live run (#704)** and would only revisit the verdict if
measured claim-extraction output collapses below ~7% of input (it will not for
passage decomposition).

#### Cache **reads** vs **creation** — which path reports what (#390)

The two provider paths report different sides of the cache, so the hit-ratio
telemetry differs by path:

| Provider path | File | Reports reads? | Reports creation? |
|---------------|------|:--------------:|:-----------------:|
| OpenAI-compatible gateway | `server/src/lib/ai/providers/bedrock-direct-provider.ts` | ✅ `usage.prompt_tokens_details.cached_tokens` → `cacheReadTokens` | ❌ not surfaced by the OpenAI-compatible `usage` shape |
| Native Anthropic SDK | `server/src/lib/ai/providers/anthropic-provider.ts` | ✅ `cache_read_input_tokens` | ✅ `cache_creation_input_tokens` |

Because the gateway path surfaces **reads only**, the hit ratio computed for
that path is **read-based** (`cacheReadTokens / promptTokens`). Cache-CREATION
(write) cost is invisible there; if write-cost visibility is required, route
through the native Anthropic provider, which reports both halves.

**Cost-estimation impact (#698):** `estimateCostUsd` / `estimateUsageCostUsd`
(`server/src/lib/ai/token-tracker.ts`) price cache reads at **0.1×** and cache
writes at **1.25×** the input rate (5-min TTL). Because the gateway path never
populates `cacheWriteTokens`, gateway-path `estimatedCostUsd` slightly
**understates** the one-time write premium — the write is real but unbilled in
the estimate. Native-Anthropic traffic is priced in full. The reconciler also
accounts for the denominator disagreement in the table above: the gateway's
`prompt_tokens` already **includes** cache reads (so the uncached remainder is
`prompt_tokens − cached_tokens`), while native `input_tokens` **excludes** them.

#### Native-Anthropic 1-hour cache TTL (#702)

The `PROMPT_CACHE_TTL=1h` gateway var above applies to the **bedrock-access-gateway**
only (and only on the models that support it there — not Sonnet 4.6). Issue #702
adds the equivalent knob for the **native Anthropic provider path**
(`server/src/lib/ai/providers/anthropic-provider.ts`), where a 1-hour TTL is
available on **all** current models.

| Setting | Value | Effect |
|---------|-------|--------|
| `ANTHROPIC_PROMPT_CACHE_TTL` | `5m` (default) | Emits a **bare** `cache_control: { type: "ephemeral" }` on both breakpoints — byte-identical to pre-#702 behaviour. Cache writes priced at **1.25×** input. |
| `ANTHROPIC_PROMPT_CACHE_TTL` | `1h` | Emits `cache_control: { type: "ephemeral", ttl: "1h" }` on both the **system** and **last-user-message** breakpoints. Cache writes priced at **2×** input (`CACHE_WRITE_MULTIPLIER_1H`). |

- **Scope: native-Anthropic path ONLY.** Bedrock has **no** 1h TTL for Sonnet 4.6 /
  Opus 4.6 (5-min only), so `bedrock-direct-provider.ts` never consults this key and
  its cache writes stay at the 5-min `1.25×` multiplier. The cost path double-gates
  the 2× write multiplier on the `anthropic` provider key so gateway/Bedrock traffic
  can never pick it up.
- **Break-even.** A 1h cache **write** costs 2× the input rate (vs 1.25× for 5m), and
  each subsequent **read** is 0.1×. So the 1h TTL only pays off for a prefix that is
  re-read enough times before it expires: it needs **≥3 reads** to beat uncached
  (2× write + 0.2× reads vs 3× uncached) versus **2 reads** for the 5-min TTL
  (1.25× + 0.1× vs 2×). Leave it at `5m` unless a bursty flow reuses a stable prefix
  with **>5-minute gaps** between calls (where a 5-min entry would expire between
  reuses but a 1-hour entry survives).
- **Single source of truth.** The TTL is resolved once per request from
  `server/src/lib/ai/prompt-cache-ttl.ts`; both the provider (wire shape) and
  `estimateUsageCostUsd` (write multiplier) read the same seam, so the emitted
  `ttl` and the billed premium can never drift apart.

**Hit-ratio telemetry** (`server/src/lib/ai/cache-hit-telemetry.ts`, #390):
after every `chat()` / `stream()` the gateway provider emits one structured log
line — `cacheReadTokens`, `promptTokens`, the derived read-based hit ratio, and
the **call type** (`agent-loop` · `synthesis` · `grounding` · `chat` ·
`unknown`) and **model** tags — and accumulates per-(call type, model) rolling
totals in a small in-process aggregator. This is in-process and dependency-free:
**no external metrics backend, no dashboard panel, and no alert wiring are
shipped here** — those remain ops follow-ups. A hit ratio that trends to ~0 on a
caching-enabled path signals a regressed/unstable cacheable prefix or a prefix
below the model's min-token floor (Bedrock fails silently with
`cached_tokens = 0`). Emissions carry only the model ID, call type, and token
counts — never the API key, `Authorization` header, or a full inference-profile
ARN.

**Admin readout endpoint** (`GET /api/admin/cache-telemetry`, #699): a
**read-only** snapshot of the in-process aggregator — the readout that #390
deliberately left out. It stays in-process: **no external metrics backend, no
persistence, no alert wiring** (those remain ops follow-ups). It is gated to
admin readers — `requireAuth` + `requirePermission("admin.read")`, the same
guard as the sibling `GET /api/admin/config` and `GET /api/admin/embeddings`
routes. An **unauthenticated** caller gets **401**; an authenticated caller
**without `admin.read`** gets **403**; neither ever sees the snapshot.

Response envelope (`{ success, data }`):

```jsonc
{
  "success": true,
  "data": {
    "generatedAt": "2026-07-05T00:00:00.000Z",
    "buckets": [
      {
        "callType": "synthesis",        // agent-loop · synthesis · grounding · chat · unknown
        "model": "claude-sonnet-4-6",   // already ARN-redacted at record time
        "calls": 2,
        "promptTokens": 800,
        "cacheReadTokens": 400,
        "cacheWriteTokens": 0,          // native-Anthropic creation only; 0 on the gateway (reads-only) path
        "hitRatio": 0.5,               // cacheReadTokens / promptTokens, clamped [0,1]
        "readWriteRatio": null          // cacheReadTokens / cacheWriteTokens; null when there are no writes
      }
    ],
    "totals": { "calls": 2, "promptTokens": 800, "cacheReadTokens": 400, "cacheWriteTokens": 0, "hitRatio": 0.5, "readWriteRatio": null }
  }
}
```

`readWriteRatio` is the **cross-region cache-fragmentation signal** (epic #696):
reads-per-write, meaningful only when a write-reporting path (native Anthropic)
has recorded creation tokens — it is `null` on the reads-only gateway path.
Model IDs are ARN-redacted before they enter the aggregator, so the response can
only contain safe identifiers and integer counts — never a secret or full ARN.

#### End-to-end cache verification — matrix + harness (Issue #697)

Nonzero prompt-cache hits had **never been confirmed live** through the Bedrock
gateway. Two plausible **silent-failure** points exist (both fail with
`cached_tokens = 0` and **no error**):

1. **The `extra_body.prompt_caching` contract.** METIS sends
   `extra_body.prompt_caching = {system, messages}`
   (`bedrock-direct-provider.ts` `buildRequestBody` ~1127, block ~1176–1183).
   This matches **no ecosystem convention** — LiteLLM expects per-block
   `cache_control`; aws-samples/bedrock-access-gateway has caching only as an
   open feature request (issue #49). **Open question (not resolvable from this
   repo — the gateway is deployed separately):** does the gateway translate this
   field into Bedrock `cachePoint` blocks, or silently ignore the unknown field?
   Answering it requires reading the deployed gateway's source/config.
2. **The inference-profile-ARN path.** `BEDROCK_SONNET_PROFILE` /
   `BEDROCK_HAIKU_PROFILE` produce `application-inference-profile` ARNs — the
   exact shape for which LiteLLM once silently dropped `cache_control`
   (BerriAI/litellm #26625).

**Verification harness** — `pnpm --filter @metis/server verify:cache`
(`server/scripts/verify-prompt-cache.ts`; logic in
`server/src/lib/ai/cache-verification.ts`, unit-tested to 100%). It is
**provider-agnostic**: it builds a repeated cacheable prefix, fires a
cache-**write** warm-up call and a cache-**read** measured call, normalizes
whichever `usage` shape returns (the two conventions **disagree** on the
prompt-token denominator — the OpenAI-compatible gateway INCLUDES cached tokens
in `prompt_tokens`; native Anthropic EXCLUDES them from `input_tokens`), and
prints a `cache-confirmed` / `write-only` / `no-cache-observed` verdict plus the
read-based hit ratio. `verify:cache` alone runs a no-network self-check; add
`--live` to hit the configured provider.

> **Local-run caveat (load-bearing).** Caching **cannot be judged from local
> runs** on this repo's dev machine — it reaches only the direct Anthropic API
> (`AI_PROVIDER=anthropic`), with **no** `BEDROCK_GATEWAY_URL` and **no**
> AWS/CloudWatch access. The two silent-failure points above exist **only on the
> deployed Bedrock gateway**. This is the same silent-local-degradation class as
> the local hash-embedder fallback. The gateway rows below therefore stay
> **pending** until run in a deployed env — tracked as **#704** (steps + the
> CloudWatch cross-check, since the gateway could fabricate or omit `usage`).

**Platform-split cache floors** are the canonical table in the "Platform-split
cache floors, TTL availability & cross-region caveat" subsection above (Sonnet
4.6 = **1,024** on Bedrock / **2,048** on direct Anthropic; Haiku 4.5 = **4,096**
on both; below the floor the platform caches nothing, silently). The largest
legitimate analysis prefix (**~2,225 tok**, see §7.5 sizing above) clears Sonnet
on both platforms but never Haiku, so the Haiku route is **expected to stay at
zero** by construction — a pass, not a regression.

**Verification matrix** (path × model × ARN → `cacheRead` observed?):

| # | Path | Model | Profile ARN | Prefix | Expected | `cacheRead` observed? |
|---|------|-------|:-----------:|:------:|----------|----------------------|
| 1 | Bedrock gateway | Sonnet 4.6 | yes (`BEDROCK_SONNET_PROFILE`) | ~2,225 | hit (≥1,024 floor) | **pending deployed-gateway run (#704)** |
| 2 | Bedrock gateway | Sonnet 4.6 | no (raw model ID) | ~2,225 | hit (isolates ARN var) | **pending deployed-gateway run (#704)** |
| 3 | Bedrock gateway | Haiku 4.5 | either | ~2,225 | **zero** (< 4,096 floor) | **pending deployed-gateway run (#704)** |
| 4 | Native Anthropic | Sonnet 4.6 | n/a | ~2,225 | hit (≥2,048 floor) | pending — machine reaches this path but no live LLM calls made in this spike |

> **Status:** the harness, the normalization contract, and the floor-expectation
> logic are **verified now** (unit tests, 100% coverage; `verify:cache`
> self-check). The live `cacheRead > 0` legs are **deferred to the deployed
> gateway** and tracked in **#704** — this machine cannot reach the Bedrock
> gateway or CloudWatch. The `extra_body.prompt_caching` gateway behavior
> (open question 1 above) is likewise deferred to #704, where the deployed
> gateway source/config is readable.

---

## 10. Disaster Recovery — RPO / RTO Targets (Epic #70)

METIS is designed for a **warm-standby, cross-region DR posture**. The full
failover procedure lives in [`docs/DR_RUNBOOK.md`](./DR_RUNBOOK.md); the
provider-side infra setup (RDS replica, S3 CRR, IAM/network) is in
[`docs/EKS_DEPLOYMENT.md`](./EKS_DEPLOYMENT.md) §10. This section documents the
**targets** and the math behind them.

### 10.1 Targets

| Metric | Target | Meaning |
|---|---|---|
| **RPO** (Recovery Point Objective) | **≤ 5 min** | Maximum tolerable *data loss* on failover — the age of the last durably-replicated write. |
| **RTO** (Recovery Time Objective) | **≤ 30 min** | Maximum tolerable *downtime* — detection → standby promotion → DNS cutover → serving traffic. |

### 10.2 What is protected — and by which mechanism

Post multi-replica epic #518 the entire durable state reduces to **two stores**,
so DR is two replication streams — there is no LanceDB to ship separately:

| State | Store | Cross-region mechanism |
|---|---|---|
| Application data (projects, users, audit, vault ciphertext, rate-limit/SSO/leader tables) | **Postgres** (#539) | Postgres **streaming replication** (WAL) to a standby-region read replica. |
| RAG vectors (`rag_vectors` + HNSW index) | **pgvector on the same Postgres** (#543) | **Same** WAL stream — vectors ride the Postgres replication, no separate path. |
| Uploaded document blobs | **S3** (#546) | **S3 Cross-Region Replication (CRR)** on the uploads bucket (operator-side, asynchronous). |

> `VAULT_MASTER_KEY` is **never** stored in Postgres or S3 — it lives in your
> secret manager (AWS Secrets Manager / External Secrets). The standby region
> must be able to resolve the *same* key, or every replicated connector secret
> is unreadable after failover. Treat multi-region key availability as a DR
> prerequisite, not an afterthought (see §4 and `docs/DATA_PORTABILITY.md §7`).

### 10.3 Why the targets hold (the math)

**RPO ≤ 5 min.** Postgres asynchronous streaming replication typically keeps a
same-continent standby within **seconds** of the primary under normal load; the
5-minute budget is the *alarm ceiling*, not the expected lag. `pnpm dr:check`
(§10.4) measures `now() - pg_last_xact_replay_timestamp()` on the standby and is
wired to alarm at **300 s** in `values-prod.yaml`
(`disasterRecovery.maxReplicationLagSeconds: "300"`) — half the RPO — so on-call
is paged *before* the objective is breached. S3 CRR is asynchronous and usually
completes within **≤ 15 min** for most objects; because uploaded blobs are
content-addressed and immutable (never rewritten), a blob that has not yet
replicated only affects the newest documents, not existing analyses — so the
*effective* data-loss RPO is bounded by Postgres, and any un-replicated blob is
re-uploadable from source. If a strict blob RPO is required, enable S3
**Replication Time Control (RTC)** for a contractual 15-min replication SLA.

**RTO ≤ 30 min**, budgeted as:

| Phase | Budget | Notes |
|---|---|---|
| Detection + decision | ≤ 5 min | Health-check alarm / `dr:check` failure → declare DR. |
| Postgres standby promotion (`SELECT pg_promote()`) | ≤ 5 min | Promotion is near-instant; time is dominated by confirming replay drained. |
| App rollout in standby region (Helm already installed, scale up) | ≤ 10 min | Warm standby: chart pre-installed at `replicaCount: 0`/low; scale + readiness. |
| Route53 DNS cutover + propagation | ≤ 10 min | Use a **low TTL (≤ 60 s)** on the app record so clients re-resolve quickly. |

The largest single lever on RTO is **DNS TTL** — keep the failover record's TTL
at ≤ 60 s in steady state so cutover is not gated on stale caches. The largest
lever on RPO is **replication lag** — keep `dr:check` green.

### 10.4 Continuous verification — `pnpm dr:check`

```bash
# Point at the STANDBY's connection string, then:
DATABASE_URL=postgres://…@standby-host:5432/metis \
  DR_MAX_REPLICATION_LAG_SECONDS=300 \
  pnpm dr:check
```

`dr:check` (`server/scripts/dr-check.ts`, logic in
`server/src/lib/dr/replication-check.ts`) runs one query
(`pg_is_in_recovery()` + `pg_last_xact_replay_timestamp()` +
`pg_last_wal_receive_lsn()` / `pg_last_wal_replay_lsn()`) and exits:

| Exit | Condition |
|---|---|
| `0` | Standby in recovery and lag ≤ threshold (or fully caught up). |
| `1` | Lag > threshold, **no standby** (target is a primary / replication not configured), or Postgres unreachable. |

Threshold defaults to **600 s** and is overridden by
`DR_MAX_REPLICATION_LAG_SECONDS` (the Helm chart injects this from
`disasterRecovery.maxReplicationLagSeconds`). Run it from a Kubernetes CronJob,
your monitoring system, or by hand during a drill. Because pgvector rides the
same WAL stream, a green `dr:check` implies **both** app data and RAG vectors
are within the RPO.

### 10.5 Drills

DR is validated **quarterly** via the drill checklist
([`.github/ISSUE_TEMPLATE/dr-drill.md`](../.github/ISSUE_TEMPLATE/dr-drill.md)),
opened automatically each quarter by
[`.github/workflows/dr-drill-schedule.yml`](../.github/workflows/dr-drill-schedule.yml).
See the [Routine Maintenance](#6-routine-maintenance) table.

---

## 8. References
- [`docs/USER_GUIDE.md`](./USER_GUIDE.md) — end-user feature documentation
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture reference
- [`docs/SECURITY.md`](./SECURITY.md) — threat model and secret management
- [`docs/EKS_DEPLOYMENT.md`](./EKS_DEPLOYMENT.md) — green-field EKS guide
- [`docs/K8S_PROD_CHECKLIST.md`](./K8S_PROD_CHECKLIST.md) — k8s production audit
- [`.env.example`](../.env.example) — full environment-variable catalogue

## 9. Eval & Bench Leaderboard (Epic #194 — v1.2.0)

### 8.1 Enabling nightly evaluation

Nightly SWE-bench-Pro and TAU-bench runs are gated behind a single repository
variable. The cron entry is always registered; when the variable is unset the
workflow logs a guidance line and exits.

```bash
# GitHub repo → Settings → Variables → Actions → New repository variable
EVAL_NIGHTLY_ENABLED = true

# Optional tuning (defaults shown)
EVAL_BENCH_MODEL     = offline-stub
EVAL_COST_CAP_CENTS  = 5000
```

The cron expression is `0 2 * * *` (02:00 UTC daily). To trigger an
on-demand run, use the **Run workflow** button on
`.github/workflows/eval-nightly.yml` and pick `swe-bench-pro`, `tau-bench`,
or `both`.

### 8.2 Reading the leaderboard

`/eval/leaderboard` shows the latest 200 BenchRun rows across both
benchmarks with filters for bench (SWE-bench-Pro / TAU-bench / all) and
window (7 / 30 / 90 days). Each row links to a per-run detail page at
`/eval/leaderboard/[id]` showing every failing task with side-by-side
expected vs actual content.

| Column        | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| Score         | Pass rate (0–100%). For SWE-bench-Pro this is the share of patches whose sandbox tests passed *and* whose Jaccard similarity to the expected diff was ≥ 0.4. For TAU-bench it is the blended 50/50 of tool-call overlap and final-state correctness. |
| Tasks         | `passed / total` raw counts.                                  |
| Mean cost     | Per-task LLM spend (USD) rolled up from the FinOps tracker.   |
| Mean latency  | Wall-clock time per task in milliseconds.                     |
| Status        | `completed` / `running` / `failed` / `disabled` (env flag).   |

`expected` and `actual` payloads are admin-only — non-admins see
"admin-only" placeholders on the detail page. This avoids leaking model
output that may contain confidential code from the corpus.

### 8.3 Triggering a run from the UI

Admins (`role === "admin"`) get **Run SWE-bench-Pro** and **Run TAU-bench**
buttons in the page header. The button POSTs to
`/api/eval/leaderboard/run` and surfaces the response inline:

- `status: "completed"` → run finished synchronously (offline stub).
- `status: "running"` → run was queued; refresh to see the row.
- `status: "disabled"` → the server flag is unset; the inline banner
  links operators to this section.

## AI Bug Scanner

Epic #708. Detailed feature docs:
[docs/AI_BUG_SCANNER.md](./AI_BUG_SCANNER.md).

### Component map

| Concern             | Implementation                                                     |
| ------------------- | ------------------------------------------------------------------ |
| Scheduler task type | `scanner.run-scan` (`server/src/lib/scheduler/task-handlers.ts`)   |
| Orchestrator        | `server/src/lib/scanner/orchestrator.ts` + `prisma-adapter.ts`     |
| Prompt fence        | `server/src/lib/scanner/prompt-fence.ts`                           |
| Two-tier LLM        | `per-symbol-scanner.ts` (Haiku) → `fp-filter.ts` (Sonnet, 3 votes) |
| Publish             | `prisma-adapter.publishScanFinding` → existing publisher infra     |
| RAG isolation       | per-project keys via `code-graph` query service                    |

### Common failure modes

| Symptom                          | Likely cause / response                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| `ERR_STALE_COMMIT`               | Repo head moved during scan. Re-trigger the scan.                    |
| Rule stuck in `compiling`        | LLM call failed; check audit `rule.compile_failed`; retry compile.   |
| Rule stuck in `awaiting_grading` | <5 exemplars graded. Add more in the rule editor.                    |
| Findings empty after scan        | No active rules + heuristic mode produced no hits. Check `Scan.mode`.|
| Publish 502 `PUBLISH_FAILED`     | Provider credential rejected. Check vault + GH/Jira connector.        |
| Triage 409 `TRIAGE_NOT_APPROVED` | Publishing requires `triageStatus="approved"`.                       |

### Token spend

Every scan tracks `Scan.totalTokens` (Haiku + Sonnet combined) and aborts when the
`budgetCapTokens` cap (default 2,000,000) is exceeded. Tune via the start-scan API.
