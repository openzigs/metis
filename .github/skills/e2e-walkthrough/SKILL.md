---
name: e2e-walkthrough
description: "Runbook to re-run the #706 METIS end-to-end walkthrough from scratch and compare runs: Miniflux v2.3.3 sample project, SQL-lineage sidecar and seeded Postgres, DeepSeek pricing, the five ui-vision waves (A to E) plus the BA re-ask over the API, safety guard-rails for sandbox publishing, and the token/cost ledger queries. Use when asked to run, repeat or compare the walkthrough (run 3 onward) or to set up its fixtures."
---

# E2E walkthrough runbook (#706)

The **procedure** — phases 1–20, Spec Kit S1–S24, pass bars, BA questions and developer
issues — lives in [#706](https://github.com/openzigs/metis/issues/706). Do not copy it
here; read it at the start of every run, because phases are added and removed (#799 drops
Phase 4's bug scan, #812 replaces Phase 17 with "Tested by" in traceability). This skill is
the **mechanics**: fixtures, order, waves, guard-rails and measurement.

| File | Use |
|---|---|
| `briefs/wave-{a..e}.md`, `briefs/ba-reask.md` | Dispatch templates, one per wave |
| `scripts/walkthrough/miniflux-seed.sql` | Idempotent Miniflux seed |
| `docs/walkthroughs/RESULTS_TEMPLATE.md` | The results comment, with the run-2 baseline |

## 1. Setup — in this order

Run 1 set things up out of order (lineage after the first ingest, no workspace) and its
results were not comparable. Do not reorder.

1. **SQL-lineage sidecar first.**
   ```bash
   docker build -f Dockerfile.sql-lineage -t metis-sql-lineage:dev .
   docker run -d --name metis-sql-lineage -p 127.0.0.1:5070:5070 \
     -e SQL_LINEAGE_PORT=5070 -e SQL_LINEAGE_HOST=0.0.0.0 \
     -e SQL_LINEAGE_TOKEN=<token> metis-sql-lineage:dev
   ```
   Then in `.env`: `SQL_LINEAGE_MODE=sidecar`, `SQL_LINEAGE_URL=http://127.0.0.1:5070`,
   `SQL_LINEAGE_TOKEN=<token>`.
2. **Miniflux Postgres, then migrate.** The image entrypoint is not the binary, so the
   command is `miniflux -migrate`, not `-migrate`.
   ```bash
   docker run -d --name mf-pg -e POSTGRES_PASSWORD=mf -e POSTGRES_DB=miniflux \
     -p 127.0.0.1:55432:5432 postgres:16
   docker run --rm \
     -e DATABASE_URL='postgres://postgres:mf@host.docker.internal:55432/miniflux?sslmode=disable' \
     miniflux/miniflux:2.3.3 miniflux -migrate
   ```
3. **Seed with SQL.** `miniflux -create-admin` refuses to run without a TTY.
   ```bash
   docker exec -i mf-pg psql -v ON_ERROR_STOP=1 -U postgres -d miniflux \
     < scripts/walkthrough/miniflux-seed.sql
   ```
   Expect 1 user / 1 category / 1 feed / 25 entries (8 read, 5 starred). Re-running is a no-op.
4. **Server and UI in the operator's own terminal** — `pnpm --filter ./server run dev` and
   `pnpm --filter ./ui run dev`. Agent background shells are killed at 2 h, which is
   shorter than a wave. Sync steps and mock auth: the `run-metis-dev` skill.
5. **Workspace first, then the project inside it** (#731). Enable lineage and
   database-aware analysis. **Save the publish target `openzigs/flux-v2` before adding any
   connector.**
6. **Repo connector** `https://github.com/miniflux/v2` with **Branch or tag = `v2.3.3`**
   (#714). Confirm the connector's `lastCommitSha` and the code graph's `commitSha` both
   start `c4d54f87`.
7. **Ground truth** for citation checks, outside the repo's tracked tree:
   `git clone --depth 1 --branch v2.3.3 https://github.com/miniflux/v2`.

## 2. LLM

DeepSeek `deepseek-flash` through the Anthropic-compatible endpoint
(`AI_PROVIDER=anthropic`, `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`,
`ANTHROPIC_MODEL=deepseek-flash`). Price it, or usage records as Unpriced:

```bash
MODEL_PRICES={"deepseek-flash":{"inputPerMTok":0.30,"outputPerMTok":1.20,"cacheReadPerMTok":0.006}}
```

These are peak prices; off-peak is half. Record which window the run used.

## 3. Waves

Each wave is one `ui-vision` dispatch, **in sequence** — the waves share one browser.
Fill the wave's brief from `briefs/`, substituting `{{…}}` placeholders with the state the
previous wave returned. Record each wave's returned IDs before dispatching the next.

| Wave | Scope | Brief |
|---|---|---|
| A | Setup (steps 5–6 above) + Phases 1–4 | `briefs/wave-a.md` |
| B | Phases 5–8 | `briefs/wave-b.md` |
| C | Phases 9–13 | `briefs/wave-c.md` |
| D | Spec Kit S1–S24 | `briefs/wave-d.md` |
| E | Phases 15–20 + developer-issue impact | `briefs/wave-e.md` |
| BA | The 8 BA questions over `POST /api/ai/chat`, one project-scoped session each | `briefs/ba-reask.md` |

The BA re-ask needs no browser: create a session with `POST /api/ai/sessions`
`{"projectId":"…","title":"BA Qn"}`, then `POST /api/ai/chat` `{"sessionId":"…","message":"…"}`.

## 4. Safety guard-rails

- **Never** publish, comment or review on `miniflux/v2`.
- Publish **only** to `openzigs/flux-v2`, **dry run first**, at most **2** issues.
  Spec Kit `taskstoissues` only with that sandbox repo set explicitly.
- Use the GitHub token **only through the METIS vault picker** — never paste it.
- Real publishing needs the operator's Claude Code auto-mode **allow rule** for the publish
  call; without it the classifier blocks the agent. The operator adds it, not the agent.
- Never click **Regenerate** on a reviewed run (fixed in #769; keep the warning until it is
  re-verified).
- Never **reject** approval items on a run that is still needed (#723).
- Afterwards, both must return `[]`:
  ```bash
  gh search issues --repo miniflux/v2 --author <user> --json url
  gh search prs    --repo miniflux/v2 --author <user> --json url
  ```

## 5. Measurement

Snapshot the ledgers **before and after each phase**; the per-phase figure is the delta.
Until #792 lands, sum both ledgers — `token_usages` (project-scoped) and `ai_token_usages`
(chat sessions; impact and test-coverage spend landed only here in run 2). After #792, use
`token_usages` alone and say so in the results. Run against the METIS database
(`server/dev.db` with `sqlite3`, or `psql` on the Postgres adapter). Columns are Prisma
camelCase, so keep the double quotes — Postgres folds unquoted names to lower case.
Substitute the project ID and the snapshot timestamp for `:project` / `:since`; SQLite
stores these timestamps as ISO-8601 text, so `:since` is a string like
`'2026-10-03T09:00:00'`.

```sql
-- token_usages: project ledger
SELECT COUNT(*) AS n, SUM("inputTokens") AS input, SUM("outputTokens") AS output,
       SUM("cacheReadTokens") AS cache_read, SUM("costCents") AS cents,
       SUM(CASE WHEN "costCents" IS NULL THEN 1 ELSE 0 END) AS unpriced_rows
FROM token_usages WHERE "projectId" = :project AND "createdAt" >= :since;

-- ai_token_usages: session ledger (no project filter: some rows carry no projectId)
SELECT COUNT(*) AS n, SUM("promptTokens") AS input, SUM("completionTokens") AS output,
       SUM("cacheReadTokens") AS cache_read, SUM("estimatedCostUsd") AS usd
FROM ai_token_usages WHERE ts >= :since;

-- lineage: schema edges by kind and provenance (run 2: 1,436 reads/writes)
SELECT kind, source, COUNT(*) AS n FROM code_edges
WHERE "projectId" = :project AND kind IN ('reads', 'writes', 'persists-to')
GROUP BY kind, source;
```

Exact cost in USD is `(input × 0.30 + output × 1.20 + cacheRead × 0.006) / 1e6` — compute
it from the token sums and compare with the ledger's own cost; a mismatch is a finding.
`unpriced_rows > 0` fails the "no Unpriced usage" criterion.

Results go in a comment built from `docs/walkthroughs/RESULTS_TEMPLATE.md`, including its
run-to-run comparison table, on #706 or a tracking issue that links back.

## 6. Agent tips (put these in every brief — the templates already do)

- Login is rate-limited to **20 per 15 min**. Log in once; drive the API with `fetch(…,
  {credentials:'include'})` from inside the logged-in page.
- Clicking a **download** button crashes the Playwright page. Fetch the export URL instead.
- In dev mode, snapshots fail for **20–40 s** after a navigation while the route compiles.
  Wait, then retry.
- File **uploads must come from under the repo** root.
- A second user needs `browser.newContext()`. Mock users exist only after their first login.
- After a workspace membership change, call `/api/auth/refresh` or the workspace claim is stale.
- **Each agent keeps its scratch files in its own subdirectory.** A shared scratchpad
  clobbered backups in run 2.
- Evidence goes under `.playwright-mcp/walkthrough-706-run<N>/<wave>/` (gitignored).
