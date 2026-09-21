# METIS — Full-Instance Data Portability

> Runbook for moving a complete METIS instance (A) to a fresh host (B). Pair with [`OPERATIONS.md`](./OPERATIONS.md) (backup, restore, vault rotation) and [`SECURITY.md`](./SECURITY.md) (threat model, secret management).

**Status — v1 scope:**
- Same-provider physical restore (SQLite → SQLite, Postgres → Postgres) is fully supported via `pnpm export` / `pnpm import` (wrappers around `scripts/backup.sh` / `scripts/restore.sh`).
- The **logical dump FORMAT is provider-neutral** and **SQLite → SQLite logical reload is fully supported and CI-tested** — `node scripts/export.mjs --logical` writes a provider-neutral NDJSON dump and `node scripts/import.mjs <dumpDir> --logical [--remap <file.json>]` reloads it into a freshly-migrated target in FK-safe order (see [Path B](#5-path-b--logical-reload-provider-neutral-format)). The **SQLite → Postgres direction is wired but opt-in**: it requires installing `@prisma/adapter-pg` in the target environment (it is deliberately not a committed dependency) and is **not yet exercised in CI** (live-Postgres CI is a deferred follow-up).
- Encrypted vault-key sidecar (`--include-vault-key`) is **supported** — the master key can travel with the export inside a passphrase-encrypted `<tarball>.vaultkey.enc` sidecar (see [§3](#encrypted-vault-key-sidecar---include-vault-key)). Transporting `VAULT_MASTER_KEY` out-of-band remains the default when the flag is omitted.

---

## 1. Store Inventory

Everything that must move from A to B, with its portability class:

| Store | Location (env var) | Portability class | Notes |
|---|---|---|---|
| Relational DB (SQLite) | `DATABASE_URL` (default `file:./dev.db`; a **relative** `file:` path resolves against `server/`, the app's CWD — so the default is `server/dev.db`, **not** `server/prisma/dev.db`) | Portable (same provider) | Carried in tarball as `db/metis.sqlite` via `sqlite3 .backup` |
| Relational DB (Postgres) | `DATABASE_URL` | Portable (same provider) | Carried in tarball as `db/metis.dump` via `pg_dump --format=custom` |
| Encrypted secrets | `Secret.ciphertext` column in DB | **Yes — with VAULT_MASTER_KEY** | AES-256-GCM envelope; decryptable on B only with the **same** `VAULT_MASTER_KEY`. Key is never in any tarball. |
| Uploaded documents | `UPLOAD_DIR` (default `<cwd>/server/data/uploads`) | Portable | Carried in tarball as `data/uploads/`. **Gap:** `backup.sh` hardcodes `server/data/uploads`; if `UPLOAD_DIR` points elsewhere those files are missed. |
| LanceDB vector store | `LANCEDB_PATH` (default `<cwd>/server/data/lancedb`) | Portable **or** re-derivable | Carried in tarball as `data/lancedb/`. **Gap:** same hardcoding issue as uploads. Alternatively, skip the copy and reindex on B. |
| BM25 index | In-memory, rebuilt from DB on startup | Re-derivable (automatic) | No action needed; reconstructed automatically at boot. |
| RuntimeConfig URL/host rows | DB table `RuntimeConfig` | **Needs fix-up** | Rows such as endpoint base URLs and host tunables are topology-coupled and must be reviewed after import. |
| Connector rows | DB tables `RepoConnection`, `DatabaseConnection`, `MCPServer`, `JiraConnection` | **Needs fix-up** | Fields like `localPath`, `host`, `url`, `command`, `args`, `runtime`, and egress/k8s limits are instance-specific. See [fix-up checklist](#8-env-specific-config--connector-fix-up-checklist). |
| `VAULT_MASTER_KEY` | Environment / `.env.prod` | **No — out-of-band only** | Never in any backup or export artifact by design. Must be transported separately via a secure channel. |
| `JWT_SECRET`, `SESSION_SECRET` | Environment / `.env.prod` | **No — out-of-band only** | Generate fresh values on B, or carry the same values via a secure channel. |
| `DATABASE_URL`, ports, `CORS_ORIGIN` | Environment / `.env.prod` | **No — out-of-band only** | Must be set to B-appropriate values before starting the server. |

---

## 2. What `backup.sh` / `restore.sh` Cover vs. Gaps

### Covered

- Database dump: `sqlite3 .backup` → `db/metis.sqlite` (SQLite) or `pg_dump --format=custom` → `db/metis.dump` (Postgres).
- Uploaded documents: `server/data/uploads/` copied to `data/uploads/` in the tarball.
- LanceDB vector store: `server/data/lancedb/` copied to `data/lancedb/` in the tarball.
- `MANIFEST.json` with `timestamp`, `provider`, `schemaVersion`, and `host`. Note: this is `backup.sh`'s simpler manifest shape — it does **not** include `secretCount` or `vaultKeyIncluded`; those fields belong to the `PortabilityManifest` type in `server/src/lib/portability/manifest.ts`, which is a validation helper used by tooling and tests, not written into the tarball.
- SHA-256 sidecar (`.tar.gz.sha256`) written alongside every tarball; verified on restore when present.
- Retention pruning: tarballs older than `BACKUP_RETENTION_DAYS` (default 30) are deleted.
- On restore: SHA-256 verification, DB overwrite, uploads and lancedb replace, prints manifest.

### Gaps

1. **`VAULT_MASTER_KEY` is never carried** (by design). Encrypted `Secret.ciphertext` rows travel in the DB dump and are useless without the matching key on B. This is the single most important portability dependency.
2. **Env-specific config and connector rows are not remapped.** `restore.sh` restores the DB verbatim; all topology-coupled rows (endpoints, hostnames, paths, k8s namespaces) still reflect instance A's values. An operator fix-up is required before B is functional.
3. **Cross-provider not handled by the physical path.** A SQLite dump cannot be fed into `pg_restore`; a Postgres custom dump cannot be fed into SQLite. Cross-provider requires a logical Prisma-level export/reload (see [Path B](#5-path-b--logical-reload-provider-neutral-format)).
4. **`backup.sh` hardcodes `server/data/uploads` and `server/data/lancedb`.** If your deployment sets `UPLOAD_DIR` or `LANCEDB_PATH` to paths outside those directories, `backup.sh` silently misses them. Work around this by pointing `UPLOAD_DIR` and `LANCEDB_PATH` to the default paths, or by supplementing the tarball with a manual copy before transport.

---

## 3. `pnpm export` / `pnpm import` Quick Reference

These are the recommended wrappers for full-instance portability. They call `scripts/backup.sh` / `scripts/restore.sh` and add preflight checks, a vault-key warning, and a post-import fix-up checklist.

### Export

```bash
# Export to ./backups/ (default)
pnpm export

# Export to a specific directory
pnpm export ./out

# Rehearse without writing anything (shows plan + NEXT STEPS)
pnpm export --dry-run
pnpm export ./out --dry-run

# Show help
pnpm export --help
```

### Encrypted vault-key sidecar (`--include-vault-key`)

`pnpm export --include-vault-key` lets the vault master key travel **with** the
export — safely — instead of out-of-band. It encrypts `VAULT_MASTER_KEY` under a
passphrase and writes a **separate** sidecar file next to the tarball:
`<tarball>.vaultkey.enc`.

- **Crypto:** AES-256-GCM with a scrypt-derived key, a per-file random salt, a
  random IV, and a 16-byte auth tag. Self-describing, versioned JSON envelope.
  Source of truth: `server/src/lib/portability/vault-key-cipher.ts`; the `.mjs`
  scripts use the format-compatible sibling `scripts/lib/vault-key-cipher.mjs`.
- **Passphrase handling:** the passphrase is read from the
  `METIS_EXPORT_PASSPHRASE` environment variable **or** an interactive prompt —
  **never from argv** (which would leak into shell history and the process
  table). Weak/empty passphrases are refused (minimum 12 characters).
- **The plaintext key is NEVER written to disk in plaintext and NEVER placed
  inside the tarball.** It exists only inside the passphrase-encrypted sidecar.

```bash
# Export the instance AND an encrypted vault-key sidecar.
METIS_EXPORT_PASSPHRASE='choose-a-strong-passphrase' \
  pnpm export ./out --include-vault-key

# Produces:
#   ./out/metis-backup-<ts>.tar.gz
#   ./out/metis-backup-<ts>.tar.gz.sha256
#   ./out/metis-backup-<ts>.tar.gz.vaultkey.enc   ← encrypted master key
```

On the target host, `pnpm import` **auto-detects** `<tarball>.vaultkey.enc` (or
takes `--vault-key-file <path>`), decrypts it in-memory using the passphrase,
and supplies `VAULT_MASTER_KEY` to the restore step. The decrypted key is
**never** written to a plaintext file.

```bash
METIS_EXPORT_PASSPHRASE='the-same-passphrase' \
  pnpm import ./out/metis-backup-<ts>.tar.gz
```

> **Transport the passphrase out-of-band — not alongside the tarball + sidecar.**
> Anyone with both the sidecar and the passphrase recovers the master key.

If you prefer the classic flow, omit `--include-vault-key` and transport
`VAULT_MASTER_KEY` out-of-band (see [§7](#7-carrying-vault_master_key-out-of-band)).

**Environment variables read by `pnpm export`:**

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | Required by `backup.sh`. A **relative** `file:` sqlite path resolves against `server/` (the app's CWD), i.e. the default points at `server/dev.db` — **not** `server/prisma/dev.db`. Absolute `file:/…` paths are used verbatim. |
| `DATABASE_PROVIDER` | `sqlite` | `sqlite` or `postgresql` / `postgres` |
| `BACKUP_DIR` | `./backups` | Output dir override (used when `outDir` omitted) |
| `BACKUP_RETENTION_DAYS` | `30` | Age in days before old tarballs are pruned |
| `VAULT_MASTER_KEY` | — | **Never bundled.** Must be transported out-of-band. |

Output: `<outDir>/metis-backup-<TIMESTAMP>.tar.gz` + `<outDir>/metis-backup-<TIMESTAMP>.tar.gz.sha256`

### Import

```bash
# Import a tarball (vault key required — default-deny)
VAULT_MASTER_KEY=<key> pnpm import ./backups/metis-backup-20260622T120000Z.tar.gz

# Dry-run — shows the full plan + preflight result + fix-up checklist
pnpm import ./backups/metis-backup-20260622T120000Z.tar.gz --dry-run

# Bypass vault preflight (only when you know the export has no encrypted secrets,
# or you accept that secrets will be permanently undecryptable)
pnpm import ./backups/metis-backup-20260622T120000Z.tar.gz --no-vault-key

# Show help
pnpm import --help
```

**Default-deny vault preflight:** `pnpm import` blocks with exit code 2 if `VAULT_MASTER_KEY` is absent in the environment, unless `--no-vault-key` is explicitly passed. This prevents silently importing an installation where all connector secrets are permanently undecryptable.

**Environment variables read by `pnpm import`:**

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | Required by `restore.sh` |
| `DATABASE_PROVIDER` | `sqlite` | `sqlite` or `postgresql` / `postgres` |
| `VAULT_MASTER_KEY` | — | **Required** unless `--no-vault-key` is passed |

---

## 4. Path A — Same-Provider Physical Restore

Use this path when A and B use the same database provider (SQLite → SQLite or Postgres → Postgres). These steps are ordered; do not skip or reorder.

### On instance A

**Step 1.** Ensure `UPLOAD_DIR` and `LANCEDB_PATH` are at their defaults (`server/data/uploads`, `server/data/lancedb`) or note any custom paths that will need manual supplementing (see [gap (d) above](#gaps)).

**Step 2.** Run the export:

```bash
pnpm export ./out
```

This produces `./out/metis-backup-<TIMESTAMP>.tar.gz` and `./out/metis-backup-<TIMESTAMP>.tar.gz.sha256`.

**Step 3.** Transport the tarball and its `.sha256` sidecar to B. Transfer both files together — `restore.sh` checks the sidecar automatically.

**Step 4.** Carry `VAULT_MASTER_KEY` **out-of-band** to B — via your organisation's secret manager, a password vault, or an SSH-encrypted channel. **Never include it in the tarball, in email, or in any communication channel that is not end-to-end encrypted.** See [§7](#7-carrying-vault_master_key-out-of-band).

### On instance B (fresh host)

**Step 5.** Provision B's environment. Set these before touching the database:

```bash
DATABASE_PROVIDER=<same as A>   # sqlite or postgresql
DATABASE_URL=<B-appropriate connection string>
VAULT_MASTER_KEY=<the key from A, received out-of-band>
```

For Postgres, also ensure the target database exists and is accessible:

```bash
createdb metis   # or use your managed DB console
```

**Step 6.** Stop the METIS server on B if it is running. `restore.sh` overwrites the live database without checking whether the server is up; data corruption is possible if the server writes concurrently.

```bash
docker compose stop server
# or, if running as a systemd service:
systemctl stop metis-server
```

> **Note:** The METIS server is started with `tsx` and has no hot-reload. After any restore or config change you must do a full restart before trusting a test result. See [`MEMORY.md`](../memory/MEMORY.md) note on `metis-server-tsx-no-hot-reload.md`.

**Step 7.** Import the tarball:

```bash
VAULT_MASTER_KEY=<key> pnpm import ./metis-backup-<TIMESTAMP>.tar.gz
```

The import script will:
- Run the vault key preflight (exits 2 if key is absent and `--no-vault-key` not passed).
- Check the tarball and sha256 sidecar.
- Invoke `restore.sh`, which verifies the sha256 sidecar, restores DB + uploads + lancedb, and prints the manifest.
- Print the post-import fix-up checklist.

**Step 8 — Schema migration (if METIS versions differ).** Check `MANIFEST.json`'s `schemaVersion` against B's installed METIS version. If they differ, run Prisma migrations after the restore:

```bash
pnpm --filter @metis/server prisma migrate deploy
```

**Step 9 — Apply the env-specific fix-up checklist.** See [§8](#8-env-specific-config--connector-fix-up-checklist) for the complete list.

**Step 10 — Restart and smoke test:**

```bash
docker compose --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Verify:
- `GET /readyz` reports all subsystems healthy, especially `vault: ok`.
- Open a connector that uses a vault-backed secret (e.g. a GitHub connector with a stored PAT) and verify it resolves — this confirms `VAULT_MASTER_KEY` is correct.
- Run a search or doc-gen operation to confirm the vector store is functional.

---

## 5. Path B — Logical Reload (Provider-Neutral Format)

Use this path when you need a Prisma-level logical dump — either for a same-provider SQLite → SQLite move that you want as portable NDJSON, or to seed a Postgres target. A Postgres custom dump cannot be loaded into SQLite, and a SQLite backup cannot be fed into `pg_restore` — so cross-provider transport requires a **provider-neutral logical dump**.

> **Status:**
> - **SQLite → SQLite logical reload: fully supported and CI-tested.** Shipped as `node scripts/export.mjs --logical` / `node scripts/import.mjs <dumpDir> --logical` (both wrappers delegate to `server/scripts/logical-export.ts` / `logical-import.ts`). Exercised on every PR by `server/src/lib/portability/logical-roundtrip.test.ts`.
> - **SQLite → Postgres: the dump format is provider-neutral and the Postgres path is wired, but it is opt-in and NOT yet exercised in CI.** Reloading into Postgres requires `@prisma/adapter-pg` installed in the target environment — it is intentionally **not** a committed dependency of this repo (METIS runs on SQLite at runtime, and shipping the pg adapter would add an unused heavy dependency). Set `DATABASE_PROVIDER=postgresql` and `DATABASE_URL=<postgres connection string>`; the import CLI selects the Postgres adapter by dynamic import and **fails loudly with an actionable message** if `@prisma/adapter-pg` is absent. Validate a real Postgres reload in a staging environment before relying on it in production. Live-Postgres CI is a [deferred follow-up](#9-deferred-follow-ups).
> - The default (no `--logical` flag) remains the physical tarball path (§4) — unchanged.

### Why this is safe across providers

Both Prisma schemas (`server/prisma/schema.prisma` for SQLite and `server/prisma/postgres/schema.prisma` for Postgres) are **semantically identical** — the same 132 models/fields; only the `datasource provider` differs; **no `@db.*` native column types**. Every scalar column is one of `String / Int / Float / Boolean / DateTime / Json`, and all primary keys are cuid strings. Data therefore transfers 1:1 between providers with no type coercion and no key collisions.

### Output format

The logical export writes a **directory** (not a tarball):

- `<ModelName>.ndjson` — one newline-delimited JSON file per model, one row per line. Values are serialized losslessly by type: `DateTime` → ISO-8601 string, `Json` → embedded JSON, `Bytes` → base-64 (tagged so the reload restores a `Buffer` byte-identically), `BigInt`/`Decimal` → string, nulls → `null`, enums → string.
- `logical-manifest.json` — per-model row counts, source provider, schema/app version (root `package.json` version), the FK-safe load order, the deferred-FK list (see below), and the explicit included/excluded model & field registry.

### FK ordering, cycles, and self-references

The load order is derived **programmatically from the Prisma schema** (the runtime DMMF in Prisma 7 no longer exposes `relationFromFields`, so `server/src/lib/portability/schema-fk-graph.ts` parses the `@relation(fields: […], references: […])` declarations directly). A deterministic topological sort (Kahn's algorithm, lexicographic tie-break) guarantees that referenced rows load before referencing rows.

The METIS schema contains real cycles (e.g. the self-referential `Requirement.parent`, plus several cross-model relationships). These are resolved with a **two-pass deferred-FK strategy**: cycle/self-reference FK columns are recorded in `logical-manifest.json` as `deferredFks`, loaded as `NULL` on the first insert, then restored by a second `UPDATE` pass. This breaks cycles without ever deadlocking.

> The reload is **not** wrapped in a single interactive transaction — a 132-table dataset can exceed Prisma's interactive-transaction time budget and risk SQLite lock contention. Each model load and the deferred fix-up run as their own batched operations; the import verifies per-model row counts against the manifest at the end and **exits non-zero on any mismatch**.

### Included vs. excluded models

All 132 models are exported — including `KnowledgeChunk` text and every other DB-resident row. There are currently **no model or field exclusions**. The registry (`EXCLUDED_MODELS` / `EXCLUDED_FIELDS` in `server/src/lib/portability/logical-dump.ts`) exists so that any future column that cannot round-trip safely (for example, an in-DB vector blob) is excluded **explicitly with a reason**, logged at export time, and recorded in the manifest — nothing is ever silently dropped. **LanceDB vectors are not in this scope at all**: they live on the filesystem (not in the relational DB) and are re-indexable from `KnowledgeChunk.text` (see [§9](#9-reindex-vs-copy-for-vectors)).

### Workflow

**Step 1 — Logical export on A:**

```bash
# Writes <Model>.ndjson + logical-manifest.json into ./out/logical
node scripts/export.mjs ./out/logical --logical
```

**Step 2 — Carry `VAULT_MASTER_KEY` out-of-band** exactly as in Path A, Step 4. The encrypted `Secret.ciphertext` rows travel inside the NDJSON and are useless without the matching key on B.

**Step 3 — On B:** Set `DATABASE_PROVIDER`, `DATABASE_URL`, and `VAULT_MASTER_KEY`, then create the schema on the **empty** target database:

```bash
pnpm --filter @metis/server prisma migrate deploy
```

**Step 4 — Logical import on B** (target tables must be empty):

```bash
node scripts/import.mjs ./out/logical --logical
```

The import loads rows in FK-safe order, runs the deferred-FK second pass, and verifies row counts against the manifest.

**Step 5 — (Optional) Remap env-specific connector/config rows** with `--remap <file.json>` (see §5.1). Without `--remap`, the post-import fix-up checklist is printed instead (§7).

**Step 6 — Restore uploads and reindex vectors.** Carry `server/data/uploads` from a physical `pnpm export` tarball (or re-upload), then reindex (see [§9](#9-reindex-vs-copy-for-vectors)).

**Step 7 — Restart B.**

### 5.1 `--remap <file.json>` — connector / env-config rewrite on import

A logical dump carries the **source** host's connector endpoints and topology-coupled config. `--remap` rewrites them in one transaction immediately after load (and only ever touches non-secret topology fields — secret values are never logged). Supported targets:

| Model | Remappable fields |
|-------|-------------------|
| `RepoConnection` | `apiBaseUrl`, `localPath`, `uploadPath` |
| `DatabaseConnection` | `host`, `port`, `databaseName` |
| `MCPServer` | `url` |
| `RuntimeConfig` | only keys classified `env-specific-tunable` by `env-config-classifier` |

Each model supports two mechanisms: a `valueMap` (old-value → new-value substitution) and `byId` per-row overrides (which take priority). The spec is **Zod-validated**; unknown top-level keys, non-allowlisted fields, and `RuntimeConfig` keys that are not env-specific tunables are rejected before the database is touched.

Sample `remap.json`:

```json
{
  "version": 1,
  "RepoConnection": {
    "valueMap": { "apiBaseUrl": { "https://ghe.old-host/api/v3": "https://ghe.new-host/api/v3" } },
    "byId": { "ckRepo123": { "localPath": "/srv/metis/repos/app" } }
  },
  "DatabaseConnection": {
    "byId": { "ckDb456": { "host": "db.new-host.internal", "port": 5432, "databaseName": "analytics_prod" } }
  },
  "MCPServer": {
    "valueMap": { "url": { "http://mcp.old-host:8080": "http://mcp.new-host:8080" } }
  },
  "RuntimeConfig": {
    "set": { "MCP_K8S_NAMESPACE": "metis-prod", "LOCAL_GEMMA_BASE_URL": "http://ollama.new-host:11434" }
  }
}
```

Apply it with:

```bash
node scripts/import.mjs ./out/logical --logical --remap ./remap.json
```

### Provider caveats

The SQLite → SQLite round-trip is exercised on every PR by the CI test `server/src/lib/portability/logical-roundtrip.test.ts` (creates two throwaway SQLite DBs, applies migrations, seeds relational + self-referential + `Secret.ciphertext` + `Json`/`DateTime` data, exports, imports, and asserts byte-identical survival).

The SQLite ↔ **Postgres** variant is **not exercised in CI** — standing up a Postgres server is not available in the default CI sandbox, so there is **no automated cross-provider data test** (it is a [deferred follow-up](#9-deferred-follow-ups)). What CI *does* assert about the Postgres path is its adapter-selection contract: a pure unit test (`server/src/lib/portability/logical-adapter.test.ts`) verifies that selecting `DATABASE_PROVIDER=postgresql` fails loudly with the actionable "install `@prisma/adapter-pg`" message when the adapter is absent, and never silently falls back to the SQLite adapter. Because both schemas are semantically identical (same models/fields; only the datasource provider differs), the same load code path applies once the adapter is installed — but **validate a real cross-provider reload in a staging environment before relying on it in production.**

---

## 6. Carrying `VAULT_MASTER_KEY` Out-of-Band

### Why this matters

Every connector credential, BYOK API key, GitHub PAT, webhook secret, and database password stored in METIS is encrypted using AES-256-GCM with a per-secret random salt and IV, derived from `VAULT_MASTER_KEY` via Argon2id (or PBKDF2-SHA512 with 600,000 iterations as a fallback). The key is read from the `VAULT_MASTER_KEY` environment variable at startup; it is **never written to the database, never included in any backup tarball, and never logged**.

The encrypted `Secret.ciphertext` rows travel in the database dump. Without the matching `VAULT_MASTER_KEY` on B, every one of those rows is permanently unrecoverable. There is no escrow, no recovery mechanism, and no support path.

> **If you lose `VAULT_MASTER_KEY`, all secrets stored in METIS are permanently unrecoverable. There is no recovery path.**

In production, when `NODE_ENV=production`, the server **refuses to start** if `VAULT_MASTER_KEY` is absent or decodes to fewer than 32 bytes (`VaultConfigurationError`). See `server/src/lib/vault/vault-service.ts`.

### How to transport it

Choose one option:

- **Organisation secret manager (recommended):** HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault — store the key there and retrieve it on B with least-privilege access.
- **Password manager secure share:** 1Password, Bitwarden, or similar — share via an encrypted vault item, not via plaintext message or email.
- **SSH-encrypted channel:** `echo "$VAULT_MASTER_KEY" | ssh operator@host-b 'cat >> /tmp/vault.key'` over a verified host-key connection. Destroy the file after B is configured.

### Generate a new key for B (when starting fresh)

If you are migrating only data and connector rows without their encrypted secrets (i.e., you will re-enter credentials on B), generate a fresh key:

```bash
openssl rand -base64 32
```

In this case, pass `--no-vault-key` to `pnpm import` to acknowledge that secrets will be undecryptable, then re-enter all connector credentials via the METIS UI after the import.

### Link to rotation

If you are performing a portability migration as part of a key rotation, follow the rotation procedure in [OPERATIONS.md §4](./OPERATIONS.md#4-vault-master-key-rotation) first on A, then carry the new key to B.

---

## 7. Env-Specific Config / Connector Fix-Up Checklist

After import, these values still reflect instance A. Review every item and set B-appropriate values before starting the server.

### Environment variables (`.env.prod` on B)

These must be set to B-appropriate values; they are not carried in any export artifact:

```
DATABASE_URL          # B's connection string (not A's)
DATABASE_PROVIDER     # must match the DB provider on B
VAULT_MASTER_KEY      # carried out-of-band from A (or regenerated — see §7)
JWT_SECRET            # generate fresh or carry via secure channel
SESSION_SECRET        # generate fresh or carry via secure channel
CORS_ORIGIN           # B's origin(s) — e.g. https://metis.b.example.com
PORT / UI port        # B's listen ports if different from defaults
```

### Env-specific tunable keys (RuntimeConfig in DB)

The following 9 keys are classified as `env-specific-tunable` in `server/src/lib/portability/env-config-classifier.ts` (`ENV_SPECIFIC_TUNABLE_KEYS`). Their imported values are coupled to A's infrastructure topology and **must be reviewed and overridden for B**:

```
LOCAL_GEMMA_BASE_URL          # base URL for local Ollama/vLLM server on B
MCP_DOCKER_NETWORK            # docker bridge network name on B
MCP_IMAGE_ALLOWLIST           # container image registry glob allowlist for B
MCP_K8S_NAMESPACE             # k8s namespace for MCP Deployments on B
MCP_K8S_SERVICE_DOMAIN        # in-cluster DNS suffix on B (e.g. cluster.local)
MCP_K8S_EGRESS_ALLOWLIST      # per-pod NetworkPolicy egress CIDRs/hosts for B
DB_ALLOWED_HOSTS              # database hostname allowlist for B
REPO_ALLOWED_HOSTS            # repository hostname allowlist for B
PUBLISH_GITHUB_ALLOWED_HOSTS  # GitHub Enterprise publish hostname allowlist for B
```

`env-config-classifier.ts` is the authoritative source of truth for this list; its module-load self-check throws at startup if the list drifts from the key registry. Keep this runbook section in sync with that file.

### Connector model fields (update per-connector in the METIS UI or DB)

| Model | Fields requiring review |
|---|---|
| `RepoConnection` | `localPath`, `uploadPath`, `apiBaseUrl` |
| `DatabaseConnection` | `host`, `port`, `databaseName` |
| `MCPServer` | `url`, `command`, `args`, `runtime`, k8s limits, `egressAllowlist` |
| `JiraConnection` | `baseUrl`, `proxyUrl` |
| `RuntimeConfig` | Any row whose key is in the `env-specific-tunable` class above |

Update these via the METIS admin UI (Settings → Connectors) or via a direct database update. Re-enter vault-backed credentials (API keys, tokens, passwords) in the connector edit form — they are decryptable on B only if `VAULT_MASTER_KEY` matches A's.

---

## 8. Reindex vs. Copy for Vectors

LanceDB stores the vector embeddings for all knowledge chunks under `LANCEDB_PATH` (default `server/data/lancedb`). The relational table `KnowledgeChunk` stores the source text (`KnowledgeChunk.text`). The two approaches for moving vectors to B:

### Copy (carry lancedb in the tarball)

- **When to use:** A and B use the same embedding backend (`EMBEDDINGS_MODE`, model, sidecar version), the same vector dimensions, and you want a fast restore without triggering re-embedding compute.
- **Risk:** If the embedding model or ONNX runtime version differs between A and B, the vector space is not comparable and semantic search will silently return wrong results.

### Reindex (re-derive from `KnowledgeChunk.text` on B)

- **When to use:** Embedding backends differ between A and B; the lancedb directory was not included in the tarball (e.g., due to the `LANCEDB_PATH` relocation gap); or you cannot confirm deterministic reproducibility of the embeddings.
- **How:** After the DB restore and server restart, trigger reindex per project via the admin API:

  ```bash
  curl -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    https://<host-b>/api/admin/embeddings/projects/<projectId>/reindex
  ```

  The endpoint is `POST /api/admin/embeddings/projects/:projectId/reindex` and requires the `admin.write` permission. Run this for each project.

- **Cost:** Re-embedding scales with the number of `KnowledgeChunk` rows. For large instances this may take minutes to hours depending on the embedding sidecar throughput.

BM25 index reconstruction is always automatic (in-memory, rebuilt at startup) and requires no operator action.

---

## 9. Deferred Follow-Ups

These items are out of scope for v1. Tracked for future implementation:

| Item | Description |
|---|---|
| Project/workspace-scoped export | Export a single project's data (DB rows + uploads + vectors) without carrying the full instance |
| Live SQLite → Postgres CI + data test | There is **no** automated cross-provider data test (no Postgres in the default CI sandbox). The SQLite → SQLite round-trip is the CI-blocking test; CI only unit-tests the Postgres **adapter-selection** contract (loud failure when `@prisma/adapter-pg` is absent). A live SQLite → Postgres reload must be validated in staging. |
| Commit `@prisma/adapter-pg` | The Postgres driver adapter is loaded by dynamic import and is intentionally not a committed dependency; committing it (or gating it behind an optional install) is deferred until live-Postgres CI exists. |

**Now implemented (previously deferred):**

| Item | Description |
|---|---|
| Provider-neutral logical dump/load (SQLite → SQLite CI-tested; SQLite → Postgres wired, opt-in) | `node scripts/export.mjs --logical` / `node scripts/import.mjs <dumpDir> --logical` — provider-neutral NDJSON dump via Prisma, FK-safe two-pass reload, manifest row-count verification. SQLite → SQLite is CI-tested; SQLite → Postgres requires `@prisma/adapter-pg` in the target env and is not yet exercised in CI. See [§5](#5-path-b--logical-reload-provider-neutral-format). |
| Auto-remap of connector rows on import | `node scripts/import.mjs … --logical --remap <file.json>` — Zod-validated A→B overrides for `RepoConnection`/`DatabaseConnection`/`MCPServer`/env-specific `RuntimeConfig`, applied in one transaction. See [§5.1](#51---remap-filejson--connector--env-config-rewrite-on-import). |
| `--include-vault-key` | Encrypted vault-key sidecar (`<tarball>.vaultkey.enc`) — AES-256-GCM, scrypt-derived key, passphrase via `METIS_EXPORT_PASSPHRASE`/prompt (never argv). See [§3](#encrypted-vault-key-sidecar---include-vault-key). |
| `backup.sh` / `restore.sh` honoring `UPLOAD_DIR` / `LANCEDB_PATH` | Both scripts (and their `.ps1` siblings) read app data from the env-configured dirs; the tarball's internal layout (`data/uploads`, `data/lancedb`) is unchanged so existing archives still restore. |
| Helm backup CronJob | Opt-in `backup-cronjob.yaml` in `deploy/helm/metis/` (gated on `backup.enabled`, default `false`); mounts the server uploads + LanceDB PVCs and writes timestamped tarballs. The vault master key is NOT in the backup. |

---

## 10. See Also

- [`OPERATIONS.md §3`](./OPERATIONS.md#3-backup--restore) — standard backup/restore cron setup, off-site shipment with encryption at rest
- [`OPERATIONS.md §4`](./OPERATIONS.md#4-vault-master-key-rotation) — `VAULT_MASTER_KEY` rotation procedure; rotate before a portability migration if a compromise is suspected
- [`SECURITY.md`](./SECURITY.md) — vault threat model, secret-management policy
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — LanceDB wiring, embedding sidecar, storage layout
- `server/src/lib/portability/env-config-classifier.ts` — authoritative source for `ENV_SPECIFIC_TUNABLE_KEYS` and portability class definitions
- `server/src/lib/vault/vault-service.ts` — AES-256-GCM envelope implementation, production startup guard
- `scripts/backup.sh`, `scripts/restore.sh` — low-level backup/restore scripts
- `scripts/export.mjs`, `scripts/import.mjs` — `pnpm export` / `pnpm import` wrappers
