# Reference answers worksheet — `docretrieval-01-metis-docs`

**43 questions** · corpus `docretrieval-01-metis-docs` · snapshotCommit `953bfe7034cd7a4f7e3c5ca82b03642a0cdebcf7`

A fill-in-the-blanks companion to `REFERENCE-AUTHORING.md`, which holds the authoritative
rules. This file exists so an author does not have to extract 43 questions and their anchored
spans out of `queries.json` by hand before starting. Fill the ANSWER blocks; the prose then
becomes `answers[]` entries in `reference.json`.

Issue #1319, epic #1316.

## Rules (summary — `REFERENCE-AUTHORING.md` governs)

1. **1–3 sentences, your own words**, self-contained prose. State the fact, not where it lives —
   "Up to five minutes", not "see the RPO row in `OPERATIONS.md`".
2. **Do not read METIS's own answer first.** It anchors you to its phrasing, and an anchored
   reference scores the system against itself. Already seen one? Give that question to someone else.
3. **Partial is fine and explicitly encouraged** — a few good answers beat 43 guesses. Skip freely.
4. **`FLAG:` is a valid answer.** If the quote does not actually answer the question, write
   `FLAG: <what is wrong>`. That records a corpus defect rather than guessing past it.
5. Copying the quote verbatim buys nothing — the metric is semantic, so a paraphrase scores as correct.

## Needed once, not per question

- **`provenance.author`**: a GitHub handle (e.g. `gh:mcronin`). The validator rejects model-shaped names.
- **`provenance.reviewedBy`** (optional): someone other than the author — self-review is rejected.

> **A model must not write these.** If the gold answer comes from a model, answer-correctness
> compares a model to a model and measures the judge against itself — a number that looks healthy
> in every circumstance, including the broken ones. That is why these blocks are empty.

### Worked example

```
### dq-ops-06  ·  paraphrase
Q: How much recent data are we allowed to lose if we have to cut over to the standby region?
ANSWER: Up to five minutes of data. The RPO is <= 5 min, measured as the age of the last
        durably-replicated write.
```

---


## `OPERATIONS.md` — 6 question(s)

### dq-ops-01  ·  _paraphrase_

**Q:** Why does the monitoring scrape URL come back with a not-found status instead of returning data after a deploy?

**Anchored quote:** The third call should return Prometheus-format text. If you see `404`, `METRICS_TOKEN` is unset and the route is intentionally disabled (fail-closed).

**ANSWER:**

```
If the third call should return Prometheus-format text. If you `404`, `METRICS_TOKEN` in not set  the is intentionally disabled.
```

### dq-ops-02  ·  _lexical_

**Q:** What is the relationship between correlationId and traceId in the production request logs, and which response header exposes it?

**Anchored quote:** Each request line carries both `correlationId` and `traceId` (alias of the same ULID, mirrored as `X-Trace-Id` on the response).

**ANSWER:**

```
Each request has both the `correlationId` and `traceId` on the response. These are alias of the same ULID, mirrored as `X-Trace-Id` on the response.
```

### dq-ops-03  ·  _lexical_

**Q:** Which dump commands does the backup script use for SQLite versus Postgres?

**Anchored quote:** For SQLite, the script uses `sqlite3 .backup` for an online-consistent copy. For Postgres, it uses `pg_dump --format=custom`.

**ANSWER:**

```
For SQLite the script uses `sqllite2.backup` for a consistent copy. Postgres uses `pgdump --format=custom`.
```

### dq-ops-04  ·  _paraphrase_

**Q:** While swapping the encryption key, how can entries protected with the previous key still be read part-way through the migration?

**Anchored quote:** The vault module supports a version byte on every ciphertext, so historical rows with the old key remain readable while you migrate.

**ANSWER:**

```
The vault supports versioning through a byte on every portion of text, so historical rows remain readable as you migrate.
```

### dq-ops-05  ·  _lexical_

**Q:** A spike in `pr_review.dlq` audit rows appeared — what does it mean and where do I find the underlying failure?

**Anchored quote:** Spike in `pr_review.dlq` audit rows → jobs are exceeding `maxAttempts` (3). Look at the `errorMessage` metadata field for the underlying failure (judge LLM 5xx, Octokit rate-limit, etc.).

**ANSWER:**

```
Spike i audit row jobs exceeding 3 max attempts, Look at the error message in the metadata field for underlying failure.
```

### dq-ops-06  ·  _paraphrase_

**Q:** How much recent data are we allowed to lose if we have to cut over to the standby region?

**Anchored quote:** | **RPO** (Recovery Point Objective) | **≤ 5 min** | Maximum tolerable *data loss* on failover — the age of the last durably-replicated write. |

**ANSWER:**

```
Maximum tolerable data loss on failover is 5 minutes.
```


## `SECURITY.md` — 5 question(s)

### dq-sec-01  ·  _lexical_

**Q:** What cookie attributes are set on the refresh token, and is it rotated?

**Anchored quote:** **Refresh token** — opaque ULID stored in an `httpOnly`, `Secure`, `SameSite=Strict` cookie. Rotated on every refresh.

**ANSWER:**

```
The cookie attributes are httpOnly, Secure, SameSite=Strict cookies. They are rotated on every refresh.
```

### dq-sec-02  ·  _paraphrase_

**Q:** Can an administrator read the real values of sensitive configuration variables through the app's settings API?

**Anchored quote:** The `/api/settings/env` admin endpoint returns `[REDACTED]` for known secret env names and `[unset]` for missing ones — it never echoes raw values.

**ANSWER:**

```
The admin endpoint returns redacted values for known secret env names and unset for missing ones.
```

### dq-sec-03  ·  _lexical_

**Q:** What audit event fires when a denylisted MCP image is admitted by an override, and what fields does it carry?

**Anchored quote:** Every admission emits a `mcp.image_denylist_overridden` WARN-level audit event with the CVE id, the actor (or `system` at provision time), the source (`registration` vs `provision`), and the affected `image@version`.

**ANSWER:**

```
WARN-level with the cve id, the actor, and the source of the affected image.
```

### dq-sec-04  ·  _paraphrase_

**Q:** What stops a hostile name server from swapping in a different destination after the address checks have already passed?

**Anchored quote:** an `undici.Agent` is built with a custom `connect.lookup` that returns the FIRST validated address regardless of which hostname undici asks for.

**ANSWER:**

```

```

### dq-sec-05  ·  _lexical_

**Q:** Which file paths and placeholder strings are on the gitleaks allow-list?

**Anchored quote:** Allow-list is restricted to `*.env.example`, `docs/**.md`, `README.md`, `CHANGELOG.md`, and explicit placeholder strings (`replace-me-…`, `your-…-here`, `example-…`).

**ANSWER:**

```

```


## `EKS_DEPLOYMENT.md` — 5 question(s)

### dq-eks-01  ·  _paraphrase_

**Q:** Does the Helm chart bring its own relational database, or do I have to supply one myself?

**Anchored quote:** The chart explicitly does **not** ship Postgres. Use AWS RDS (or any other managed Postgres) and pass the `DATABASE_URL` via External Secrets.

**ANSWER:**

```

```

### dq-eks-02  ·  _lexical_

**Q:** Why does the high-scale rate-limit backend specify Valkey instead of Redis?

**Anchored quote:** Uses **Valkey** (Linux-Foundation BSD fork of Redis — e.g. **ElastiCache / MemoryDB for Valkey**, ~20–33% cheaper than Redis OSS), **not** Redis Ltd's relicensed Redis (RSALv2/SSPL; Redis 8 → AGPLv3).

**ANSWER:**

```

```

### dq-eks-03  ·  _paraphrase_

**Q:** How does the shared store for the login handshake keep a one-time value from being replayed while still working whichever pod handles the return leg?

**Anchored quote:** State is consumed atomically via `DELETE … RETURNING` so a `state` is single-use **cluster-wide** (replay-safe) and the callback succeeds on whichever pod it lands on.

**ANSWER:**

```

```

### dq-eks-04  ·  _lexical_

**Q:** With `VECTOR_STORE=pgvector`, where do the vectors live and why does that remove the LanceDB corruption mode?

**Anchored quote:** Vectors live in one `rag_vectors` table; Postgres serializes concurrent writers, so the LanceDB corruption mode is gone.

**ANSWER:**

```

```

### dq-eks-05  ·  _lexical_

**Q:** What SQL statement creates the replication role on the primary Postgres for the DR standby?

**Anchored quote:** Create the replication role on the primary: `CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '…';`

**ANSWER:**

```

```


## `DATABASE_IMPACT_ANALYSIS.md` — 6 question(s)

### dq-dbi-01  ·  _paraphrase_

**Q:** Can the analysis ever change a customer's database or fire off the SQL it prints?

**Anchored quote:** Introspection never runs   DDL and never fetches a routine body; suggested DDL is a review artifact with no   execution path; nothing ever writes to a customer database.

**ANSWER:**

```

```

### dq-dbi-02  ·  _lexical_

**Q:** What happens to a connection that lacks the minimum identity of host + databaseName, and can two null-host connections be merged?

**Anchored quote:** a connection lacking the minimum identity (**host + databaseName**,   `hasResourceIdentity`) is left unlinked — a null-host connection is **never**   given a guessed link

**ANSWER:**

```

```

### dq-dbi-03  ·  _lexical_

**Q:** Is the AFFECTED SCHEMA block's token cost carved out of the consuming agent's budget or added on top of it?

**Anchored quote:** (8) and truncated at `DEFAULT_AFFECTED_SCHEMA_TOKEN_BUDGET` (1200 ≈ 4 chars per   token), keeping the highest-confidence rows; its cost is carved **out** of the   consuming agent's budget, never added on top.

**ANSWER:**

```

```

### dq-dbi-04  ·  _paraphrase_

**Q:** If an analyst forces the feature on for a project that has nothing indexed, are they told why nothing happened?

**Anchored quote:** with no schema data is **never a silent no-op** — it resolves `enabled: true, ran: false, reason: "skipped-no-schema-data"`, and the UI (§5.2 below) surfaces an actionable "connect a database or re-ingest" hint

**ANSWER:**

```

```

### dq-dbi-05  ·  _paraphrase_

**Q:** Why is the generated statement for a table that doesn't exist yet wrapped in SQL comment markers?

**Anchored quote:** A `CREATE TABLE` for a missing table is emitted as a commented-out template precisely so a copy-paste cannot accidentally run it.

**ANSWER:**

```

```

### dq-dbi-06  ·  _lexical_

**Q:** Which findings does the schema reconciliation gate cap at could-not-verify?

**Anchored quote:** reconciliation `table-not-found` / `column-not-found`, or a cross-project claim whose canonical identity did not resolve — is capped at `could-not-verify`.

**ANSWER:**

```

```


## `IMPACT_ANALYSIS_LLM_STAGES.md` — 5 question(s)

### dq-lls-01  ·  _lexical_

**Q:** Is there anywhere in the impact pipeline that calls a model without going through the AIProvider abstraction?

**Anchored quote:** The pipeline reaches an LLM **only** through the `AIProvider` abstraction (`server/src/lib/ai/types.ts`) — never a raw SDK. So the authoritative check is:

**ANSWER:**

```

```

### dq-lls-02  ·  _paraphrase_

**Q:** What happened to accuracy when a model was used to choose the starting code symbols rather than to prune the results?

**Anchored quote:** An LLM **seeder** — one that picks the code symbols BM25 will expand from — was built (#931) and measured: table precision fell **0.42 → 0.29**.

**ANSWER:**

```

```

### dq-lls-03  ·  _paraphrase_

**Q:** What structurally prevents these stages from returning a table or column name that does not exist?

**Anchored quote:** **integer index** into an array the deterministic pipeline built. The model's own   spelling of a name is never used, so fabrication is structurally impossible   rather than filtered after the fact.

**ANSWER:**

```

```

### dq-lls-04  ·  _paraphrase_

**Q:** If I analyse ten changed requirements in one run, does every provider call multiply by ten?

**Anchored quote:** Four of the five calls are **per changed requirement** (table filter, additive DDL, clause reconcile, item narrative); the fifth, the run overview, happens **once per run** regardless of requirement count.

**ANSWER:**

```

```

### dq-lls-05  ·  _lexical_

**Q:** What did the measurement show IMPACT_LLM_ENTITY_SEEDS did to macro table precision?

**Anchored quote:** It is the one stage with a **measured cost to output quality**: macro table precision **0.7626 → 0.6909**, lower in **34 of 34** pairwise comparisons on non-overlapping spreads.

**ANSWER:**

```

```


## `DATA_PORTABILITY.md` — 4 question(s)

### dq-dpo-01  ·  _lexical_

**Q:** If UPLOAD_DIR or LANCEDB_PATH point outside the default directories, does backup.sh still pick those files up?

**Anchored quote:** If your deployment sets `UPLOAD_DIR` or `LANCEDB_PATH` to paths outside those directories, `backup.sh` silently misses them.

**ANSWER:**

```

```

### dq-dpo-02  ·  _paraphrase_

**Q:** What stops me from restoring an instance when the master decryption key isn't set in the environment?

**Anchored quote:** `pnpm import` blocks with exit code 2 if `VAULT_MASTER_KEY` is absent in the environment, unless `--no-vault-key` is explicitly passed.

**ANSWER:**

```

```

### dq-dpo-03  ·  _lexical_

**Q:** How does the logical reload handle deferredFks for self-referential and cyclic relations?

**Anchored quote:** cycle/self-reference FK columns are recorded in `logical-manifest.json` as `deferredFks`, loaded as `NULL` on the first insert, then restored by a second `UPDATE` pass.

**ANSWER:**

```

```

### dq-dpo-04  ·  _paraphrase_

**Q:** What can go wrong if I just copy the vector directory across instead of rebuilding it on the new host?

**Anchored quote:** If the embedding model or ONNX runtime version differs between A and B, the vector space is not comparable and semantic search will silently return wrong results.

**ANSWER:**

```

```


## `integrations/teams.md` — 4 question(s)

### dq-tms-01  ·  _paraphrase_

**Q:** What does the bot endpoint answer with when that workspace has never had its bot set up?

**Anchored quote:** A workspace with **no installed credentials → 403** (`TEAMS_NOT_INSTALLED`). We   never run an auth-disabled adapter that would accept unsigned activities.

**ANSWER:**

```

```

### dq-tms-02  ·  _lexical_

**Q:** Where in mirrorMessageToTeams is the non-`metis` origin checked, and why before the link lookup?

**Anchored quote:** the very first check in   `mirrorMessageToTeams` returns early on any non-`metis` origin, BEFORE any link   lookup, so a Teams-sourced message is never echoed back into the channel it   arrived from.

**ANSWER:**

```

```

### dq-tms-03  ·  _paraphrase_

**Q:** Somebody posts in a bridged channel but their chat account was never tied to a METIS account — what happens to that post?

**Anchored quote:** When the resolver returns    `null`, ingestion is **skipped** and a one-time, per-conversation, best-effort    hint is posted back to the channel inviting the user to link their METIS    account. No message is created.

**ANSWER:**

```

```

### dq-tms-04  ·  _lexical_

**Q:** Which permission does the Approve button check, and is a `reader` allowed to use it?

**Anchored quote:** permission the REST route enforces via `requirePermission("issue.draft")`. A   `reader` (or an actor with **no** assigned role) is refused.

**ANSWER:**

```

```


## `ops/local-serving.md` — 4 question(s)

### dq-lsv-01  ·  _paraphrase_

**Q:** Why won't METIS accept a hosted vendor endpoint as the address for its local model provider?

**Anchored quote:** and **rejects every public host** — including `api.openai.com`, `*.azure.com`, `*.anthropic.com` — so document content can never egress.

**ANSWER:**

```

```

### dq-lsv-02  ·  _lexical_

**Q:** Why does this Mac run Ollama on Metal instead of MLX?

**Anchored quote:** MLX only activates at **≥ 32 GB** unified RAM, and a model should fit in roughly 60–70% of RAM. **24 GB is below the MLX threshold**, so the Mac path is **Ollama on Metal**

**ANSWER:**

```

```

### dq-lsv-03  ·  _lexical_

**Q:** Does setting NCCL_P2P_DISABLE=1 reliably work around the PCIe P2P hang, and what if it doesn't?

**Anchored quote:** `NCCL_P2P_DISABLE=1` before launch sometimes works around the P2P hang at a > throughput cost; if it doesn't, fall back.

**ANSWER:**

```

```

### dq-lsv-04  ·  _paraphrase_

**Q:** How much input will Ollama actually accept before I change anything, and why does that break the shipped 48000 facts budget?

**Anchored quote:** Ollama defaults to a **2,048-token** context unless you set > `OLLAMA_CONTEXT_LENGTH` (or `num_ctx` per request). If you leave it at 2,048 the > effective window is tiny — the `48000` cap will massively overflow it.

**ANSWER:**

```

```


## `data-model.md` — 4 question(s)

### dq-dmo-01  ·  _lexical_

**Q:** What exactly does gen-postgres-schema.sh change when it produces the Postgres copy of the schema?

**Anchored quote:** which strips the sqlite header, prepends an autogen warning, and rewrites the datasource provider. The resulting file is byte-identical to the SQLite source except for the datasource block.

**ANSWER:**

```

```

### dq-dmo-02  ·  _paraphrase_

**Q:** Can the admin config API change the database connection string or the listening port at runtime, or is a restart needed?

**Anchored quote:** **Tier 1 — Bootstrap** (`.env` only): `DATABASE_URL`, `VAULT_MASTER_KEY`, `JWT_SECRET`, `PORT`, `NODE_ENV`. Restart required to change. Writes to bootstrap keys via the API are rejected with `400 BOOTSTRAP_KEY`.

**ANSWER:**

```

```

### dq-dmo-03  ·  _paraphrase_

**Q:** Why is the rule about extracted findings scoring exactly 1.0 checked in application code rather than by the database itself?

**Anchored quote:** The Prisma layer cannot enforce this directly because SQLite (dev) does not expose the CHECK-constraint round-trip Prisma needs for cross-driver parity;

**ANSWER:**

```

```

### dq-dmo-04  ·  _lexical_

**Q:** How does /speckit.taskstoissues avoid creating duplicate GitHub issues when it is run again?

**Anchored quote:** Idempotency table for `/speckit.taskstoissues` — records the GitHub issue number created for each `(projectId, featureSlug, taskId)` so re-runs upsert instead of duplicating.

**ANSWER:**

```

```
