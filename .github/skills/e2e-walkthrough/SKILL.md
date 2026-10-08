---
name: e2e-walkthrough
description: "Runbook to re-run the #706 METIS end-to-end walkthrough from scratch and compare runs: Miniflux v2.3.3 sample project, SQL-lineage sidecar and seeded Postgres, DeepSeek pricing, the five ui-vision waves (A to E) plus the BA re-ask over the API, safety guard-rails for sandbox publishing, the token/cost ledger queries, and the HTML tutorial and run-report slideshows built from the screenshots. Use when asked to run, repeat or compare the walkthrough (run 3 onward), to set up its fixtures, or to build its slideshow."
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
| `scripts/walkthrough/build-slideshow.mjs` | Tutorial and run-report slideshows from `steps.jsonl` |

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
5. **Workspace first, then the project inside it.** #731 (PR #927) now lets an existing
   project join a workspace, but create it inside so runs stay comparable; wave B tests the
   move on a throwaway project. Enable lineage and database-aware analysis. **Save the
   publish target `openzigs/flux-v2` before adding any
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

The BA re-ask needs no browser. Create a session with `POST /api/ai/sessions`
`{"projectId":"…","title":"BA Qn"}`; the id is at `data.session.id`, not `data.id`. Then send
`POST /api/ai/chat` `{"sessionId":"…","message":"…"}`. Run it over the API even when Phase 10
runs in the UI: in run 3 the auto-mode classifier blocked selecting the `/chat` project-scope
radio, so the UI path may be unavailable without an allow rule.

**Never overlap long jobs.** Waves run in sequence, and so must the jobs inside them. A repo
refresh, re-ingest or scheduler run while docs generation is in flight used to fail the
document at commit after its whole spend: $4.61 and 88 min in run 3 (#856). #867 now stops
early on changed inputs, but the run still ends `failed`. Pause every scheduled job before
Phase 9, and create the Phase 13 scheduler job **after** Phase 9's documents finish.

## 4. Safety guard-rails

- **Never** publish, comment or review on `miniflux/v2`.
- Publish **only** to `openzigs/flux-v2`, **dry run first**, at most **2** issues.
  Spec Kit `taskstoissues` only with that sandbox repo set explicitly.
- Use the GitHub token **only through the METIS vault picker** — never paste it.
- Real publishing needs the operator's Claude Code auto-mode **allow rule** for the publish
  call; without it the classifier blocks the agent. The operator adds it, not the agent.
- Never click **Regenerate** on a reviewed run (fixed in #769; keep the warning until it is
  re-verified).
- Never **reject** approval items on a run that is still needed (#723). PR #902 makes a
  rejection resolve the gate; keep this rule until wave B re-verifies it on its agent run.
- **Docs generation has a cancel** (#855): use **Cancel generation** on the doc card, or
  `POST /api/projects/:id/docs/:docId/cancel`. Don't restart the server to stop a runaway
  document. Per-run ceilings `DOCS_GEN_MAX_RUN_COST_CENTS` (default 2500) and
  `DOCS_GEN_MAX_RUN_TOKENS` (default 20M) stop it automatically. For a walkthrough, set a
  tighter cost ceiling in `.env`, for example 500, so one runaway document can't spend the
  run's budget.
- Sending a write statement to the database connector's query endpoint, to prove it is
  read-only, is classifier-blocked for agents. The operator runs it, or approves it,
  using no-op writes (`… WHERE false`).
- Afterwards, both must return `[]`:
  ```bash
  gh search issues --repo miniflux/v2 --author <user> --json url
  gh search prs    --repo miniflux/v2 --author <user> --json url
  ```

## 5. Measurement

Snapshot the ledger **before and after each phase**; the per-phase figure is the delta.
Since #792 and #854, **`token_usages` is the ledger**; use it alone and say so in the results.
Chat also writes each call to `ai_token_usages` with identical tokens, so **never sum the two
tables**. Only chat in a session with no project lands in `ai_token_usages` alone. Since #761
(PR #868), `costUsd` holds the exact per-call cost. `costCents` is still rounded per row, and
rows written before #761 have `costUsd` NULL, so read `COALESCE(costUsd, costCents / 100.0)`. Run against the METIS database
(`server/dev.db` with `sqlite3`, or `psql` on the Postgres adapter). Columns are Prisma
camelCase, so keep the double quotes — Postgres folds unquoted names to lower case.
Substitute the project ID and the snapshot timestamp for `:project` / `:since`; SQLite
stores these timestamps as ISO-8601 text, so `:since` is a string like
`'2026-10-03T09:00:00'`.

```sql
-- token_usages: the ledger. Always pass an explicit upper bound: in SQLite a bare
-- '9999' compares as a number against the ISO text and matches nothing (run 3's helper
-- returned 0 for a whole wave that way). Use '9999-12-31T00:00:00Z'.
SELECT COUNT(*) AS n, SUM("inputTokens") AS input, SUM("outputTokens") AS output,
       SUM("cacheReadTokens") AS cache_read,
       SUM(COALESCE("costUsd", "costCents" / 100.0)) AS usd,
       SUM(CASE WHEN "costUsd" IS NULL AND "costCents" IS NULL THEN 1 ELSE 0 END) AS unpriced_rows
FROM token_usages
WHERE "projectId" = :project AND "createdAt" >= :since AND "createdAt" < :until;

-- per agent step (docs-gen, analysis, chat, spec-kit.*, impact.*, discussion, …)
SELECT "agentStep", SUM("inputTokens") + SUM("outputTokens") AS tokens,
       SUM(COALESCE("costUsd", "costCents" / 100.0)) AS usd
FROM token_usages
WHERE "projectId" = :project AND "createdAt" >= :since AND "createdAt" < :until
GROUP BY 1 ORDER BY 3 DESC;

-- lineage: schema edges by kind and provenance (run 2: 1,436 reads/writes)
SELECT kind, source, COUNT(*) AS n FROM code_edges
WHERE "projectId" = :project AND kind IN ('reads', 'writes', 'persists-to')
GROUP BY kind, source;
```

Exact cost in USD is `(input × 0.30 + output × 1.20 + cacheRead × 0.006) / 1e6`. Compute
it from the token sums and compare it with the ledger's `usd`. Since #761 they should agree to
within a cent per summed view, so a larger mismatch is a finding. Run 3, before #761, recorded
999¢ against $9.84 computed.
`unpriced_rows > 0` fails the "no Unpriced usage" criterion.

**Docs generation against its caps (#855, #741).** Record `DOCS_GEN_MAX_RUN_COST_CENTS`
(default 2500), `DOCS_GEN_MAX_RUN_TOKENS` (20M), `DOCS_GEN_SECTION_MAX_CHARS` (60,000) and
`DOCS_GEN_DOCUMENT_MAX_CHARS` (250,000) as set for the run. Per document, report its cost
against the ceiling, whether a ceiling stopped it, and its body and longest-section length.
Test **Cancel generation** once on purpose (wave C). Run 3's BRD was 2.19 MB and $4.61.

**Approved requirements.** Report how many promoted requirements have no acceptance criteria and
no code link (#909, #926; the query is in wave B's brief).

Results go in a comment built from `docs/walkthroughs/RESULTS_TEMPLATE.md`, including its
run-to-run comparison table, on #706 or a tracking issue that links back.

## 6. Agent tips (put these in every brief — the templates already do)

- Login is rate-limited to **20 per 15 min**. Log in once. **Drive the UI**; use `fetch(…,
  {credentials:'include'})` from inside the logged-in page only for a check with no UI caller
  in `ui/src` (the briefs name them). Since run 3, Spec Kit, reviews, baselines and workspace
  membership all gained UI (#931, #929, #927).
- Clicking a **download** button crashes the Playwright page. Fetch the export URL instead.
- In dev mode, snapshots fail for **20–40 s** after a navigation while the route compiles.
  Wait, then retry.
- File **uploads must come from under the repo** root.
- A second user needs `browser.newContext()`. Mock users exist only after their first login.
- After a workspace membership change, call `/api/auth/refresh` or the workspace claim is stale.
- **Each agent keeps its scratch files in its own subdirectory.** A shared scratchpad
  clobbered backups in run 2.
- **Mock users:** `admin`, `coordinator`, `developer` and `reader` all use password
  `password`. `developer` lacks `project.update`.
- The access token expires after about **40 min**. One navigation may bounce to
  `/login?reason=expired`, and the next recovers without a new login.
- **API paths that differ from what you'd guess:**
  - Code search is `POST /api/projects/:id/code-search` `{query, limit}`; a GET returns 404.
  - Knowledge retrieval is `POST /api/projects/:id/retrieve` `{query, k}`.
  - Admin token budgets are `/api/admin/token-budgets/:userId`, and auth providers are
    `/api/admin/auth/providers`.
  - Requirement edits use `PUT /api/requirements/:id` with the current `version` in the body
    (409 `VERSION_CONFLICT` on a stale one). Since #865, `PATCH
    /api/analyses/:id/requirements/:reqId` is versioned the same way.
  - **New baseline** on the Baselines page (review admins) pins every requirement; a subset
    still needs `POST /api/projects/:id/baselines` `{name, requirementIds}` (#929).
- **Connector labels** must match `^[A-Za-z0-9][A-Za-z0-9 _.\-]*$`. A label like
  `miniflux/v2 @ v2.3.3` fails with only "invalid payload".
- **Uploaded and URL documents land in quarantine.** Approve them under Project settings →
  Quarantine before searching.
- **Waiting for long jobs:**
  - The embeddings reindex now streams its code-symbol phase (#862, PR #878). Confirm the
    end with `GET /api/admin/embeddings/projects/:id/coverage` (`shadow.inProgress=false`).
  - An analysis shows "0 tok" until it ends, so poll `GET /api/analyses/:id`.
  - Issue Playwright waits one at a time: parallel `browser_wait_for` calls run concurrently.
- **Spec Kit (#931):** drive the Spec Kit page: Features panel, `speckit.*` palette,
  **Generate checklists**, export preview/publish, Delete, **Start analysis**. Still API-only:
  the 409/400/403/404 error codes the UI pre-empts, legacy-alias `Deprecation` headers,
  `x-speckit-force`, writing a *feature* artifact (no Edit button), and `/install`. Chat no
  longer runs Spec Kit commands.
- `browser_evaluate` `filename` must be under the repo, for example the wave's evidence
  folder; the scratchpad is outside the allowed roots.
- A custom agent enabled for a project **joins every later analysis run** on it. Disable it
  after Phase 7 if later runs must stay comparable.
- An enabled custom skill is loaded into later chat sessions. Disable test skills before the
  BA re-ask.
- Evidence goes under `.playwright-mcp/walkthrough-706-run<N>/<wave>/` (gitignored).

## 7. Build the slideshow — last step of every run (#829)

Each wave appends one line per screenshot to `<evidence-dir>/steps.jsonl`, where
`<evidence-dir>` is `.playwright-mcp/walkthrough-706-run<N>/`; the briefs carry the
instruction and good and bad wording.

**Write `<evidence-dir>/run.json` after filing the run's issues and before building (#947).**
The steps only know the issues they *checked* and the tokens attributed to them. The issues the
run *found* are filed after the waves, and the ledger sees calls no step claims: a wave with no
attributed tokens, the BA re-ask, a call that finishes in a later wave. Run 4's deck showed
$3.58 against the ledger's $4.32. `run.json` is optional, and without it the build behaves as
before:

```json
{
  "newIssues": [{ "number": 935, "title": "SQL lineage: …", "severity": "high" }],
  "ledger": { "tokens": 1234567, "costUsd": 4.32, "source": "token_usages",
              "since": "2026-10-08T16:33:46Z", "until": "2026-10-08T20:50:00Z" },
  "waves": { "A": { "tokens": 120000, "costUsd": 0.41,
                    "since": "2026-10-08T16:33:46Z", "until": "2026-10-08T17:06:43Z" },
             "BA": { "tokens": 90000, "costUsd": 0.12 } }
}
```

- `newIssues`: every issue filed from the run, `severity` one of `high` / `medium` / `low`.
- `ledger`: the run's `token_usages` total from section 5's query, over the whole run window,
  for the walkthrough project, including the BA re-ask's chat rows. `source` must be
  `token_usages`.
- `waves`: optional per-wave totals over each wave's window, keyed `A`–`E` and `BA`;
  `since` / `until` are optional here and record the window.

All three keys are optional. Unknown fields are rejected, and an invalid file fails the build,
naming the field, before anything is written. With `ledger`, the summary shows the ledger
total as authoritative, the per-step sum as "attributed to steps", and the unattributed
remainder. With `waves`, the per-wave table uses the ledger, adds a `BA` row, and shows `–`
for a wave it does not list. The summary lists "Issues checked" (the steps' `issues`) and
"New issues filed (N)" by severity, and the report deck ends with a slide listing the new
issues with their titles.

After the last wave and `run.json`, build both decks:

```bash
node scripts/walkthrough/build-slideshow.mjs \
  --in .playwright-mcp/walkthrough-706-run<N> \
  --out .playwright-mcp/walkthrough-706-run<N>/slides \
  --deck both --title "METIS walkthrough, run <N>"
```

This writes `slides/tutorial/index.html` and `slides/report/index.html`, each with an `assets/`
folder. Add `--inline-images` for one self-contained HTML file per deck; it warns above 15 MB.
The decks open from disk with no network. Keys: arrows, Page Up/Down, Space, Home/End; `g` or
`o` opens the slide index, `n` shows presenter notes (the reviewer's `result` in the tutorial),
`t` toggles the theme. Print to PDF gives one slide per page.

- **Tutorial deck**: a guided tour for analysts and developers. It contains a title, the contents,
  then each chapter's intro and steps, in wave and phase order. It shows `tutorial` text only,
  and leaves out steps with `works` of `fail` or `blocked`, steps with `useful` of `fail`, and
  steps with no `tutorial` text. A step that works but is only `weak` stays in.
- **Run report deck**: every step, with its Works and Useful badges, `result`, tokens, cost and issue
  links, after a summary slide with the Works and Useful tallies, overall and per wave, and the total spend. Attach it to
  the results comment, or compare it with the previous run's report.

The build fails, naming the line, step or field, on an invalid manifest, an invalid `run.json`,
or a screenshot path outside the evidence folder. It changes nothing on disk until the whole manifest checks out.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique step id, e.g. `a-2-1` |
| `wave` | yes | `A`–`E` |
| `phase` | yes | `"2"`, `"S4"`; ordered naturally within a wave |
| `chapter` | yes | Feature area, e.g. "Connect a repository"; becomes a tutorial chapter |
| `title` | yes | Step title; also the screenshot's `alt` text |
| `screenshot` | yes | Image path relative to the evidence folder (`.png`, `.jpg`, `.webp`, `.gif`) |
| `tutorial` | no | User-facing, imperative "how to" text |
| `result` | no | Reviewer-facing outcome |
| `works` | yes | Did it do what it should: `pass` / `partial` / `fail` / `blocked` |
| `useful` | yes | Was it worth using: `pass` / `weak` / `fail` / `n/a` |
| `issues` | no | Issue numbers, linked to `openzigs/metis` |
| `tokens` / `costCents` | no | Spend for the step |
| `ts` | yes | ISO-8601 timestamp |

`works` and `useful` are the two axes of `docs/walkthroughs/RESULTS_TEMPLATE.md`, so the report's
tally matches the results comment and the run-2 baseline. A step that does not work gets
`useful: "n/a"` unless the failure itself is the finding; a step that works but is not worth
using gets `works: "pass"`, `useful: "weak"` or `"fail"`.

Unknown fields are rejected, so a typo is reported rather than dropped silently. All text is
shown as plain text; the only formatting is `**bold**`, `` `code` `` and `http(s)` links.

**Sharing.** The decks can optionally be published as a **private** shareable link, for
example the inline build uploaded somewhere only the team can open. Review the screenshots
first: they show the run's data, and the decks are not redacted.

## 8. Close what the run confirms

Some issues were merged as partial fixes and left open for the walkthrough to confirm:
**#726, #741, #768, #785, #791** before run 4. When a wave's fix verification says `holds`
with evidence, close the issue with a comment linking the results comment. Otherwise leave
it open and say what is missing. Record the closures under "Findings" in the results.
