---
name: e2e-walkthrough
description: "Runbook to re-run the #706 METIS end-to-end walkthrough from scratch and compare runs: Miniflux v2.3.3 sample project, SQL-lineage sidecar and seeded Postgres, DeepSeek pricing, the six ui-vision waves (A to E, plus the F persona journeys) and the BA re-ask over the API, the generated and tracked fixes-to-verify list, safety guard-rails for sandbox publishing, the token/cost ledger queries, and the HTML tutorial and run-report slideshows built from the screenshots. Use when asked to run, repeat or compare the walkthrough (run 3 onward), to set up its fixtures, or to build its slideshow."
---

# E2E walkthrough runbook (#706)

The **procedure** — phases 1–20, Spec Kit S1–S24, pass bars, BA questions, developer
issues and the persona journeys — lives in [`docs/walkthroughs/TEST_PLAN.md`](../../../docs/walkthroughs/TEST_PLAN.md)
(moved out of #706's body in #948). Do not copy it here; read it at the start of every run,
because phases are added and removed (#799 dropped Phase 4's bug scan, #812 replaced Phase 17
with "Tested by"). Results still go on [#706](https://github.com/openzigs/metis/issues/706).
This skill is the **mechanics**: fixtures, order, waves, guard-rails and measurement.

**Start every run with `pnpm walkthrough:check-plan`.** It fails when the plan names an API
route or page that no longer exists. A step the run finds wrong is fixed in the plan, in a PR,
not only in the results comment.

| File | Use |
|---|---|
| `docs/walkthroughs/TEST_PLAN.md` | The procedure and pass bars |
| `scripts/walkthrough/check-test-plan.mjs` | Drift check: dead routes and pages in the plan |
| `briefs/wave-{a..f}.md`, `briefs/ba-reask.md` | Dispatch templates, one per wave |
| `scripts/walkthrough/fixes-since.mjs` | The fixes a run verifies, as a reviewable `fixes.json` (section 3a) |
| `docs/walkthroughs/fix-phase-map.json` | Which wave and phase verifies each fix, by issue or PR |
| `scripts/walkthrough/fill-brief.mjs` | Fills the briefs from a state file and `fixes.json` |
| `scripts/walkthrough/miniflux-seed.sql` | Idempotent Miniflux seed |
| `docs/walkthroughs/RESULTS_TEMPLATE.md` | The results comment, with the run-2 baseline |
| `scripts/walkthrough/build-slideshow.mjs` | Tutorial and run-report slideshows from `steps.jsonl` |

## 1. Setup — in this order

Run 1 set things up out of order (lineage after the first ingest, no workspace) and its
results were not comparable. Do not reorder.

1. **SQL-lineage sidecar first, rebuilt from the commit under test** — every run, even when
   an old image is still running. A rebuilt sidecar only reaches *stored* edges when
   `LINEAGE_EXTRACTOR_VERSION` changes, because ingest skips files whose extractor version
   matches (#935). When lineage looks wrong, `POST /extract_usage` on the sidecar with the
   function's SQL tells a wrong sidecar (bad answer) from a stale graph (good answer).
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
5. **Workspace first, then the project inside it.** Membership has no invite UI (#941): invite
   over the API, open `/invites/<token>` as the invitee, then log them in afresh. Reviewers
   must be workspace members. A project *outside* a workspace can only be created with
   `POST /api/projects`. #731 (PR #927) now lets an existing
   project join a workspace, but create it inside so runs stay comparable; wave B tests the
   move on a throwaway project. Enable lineage and database-aware analysis. **Save the
   publish target `openzigs/flux-v2` before adding any
   connector.**
6. **Repo connector** `https://github.com/miniflux/v2` with **Branch or tag = `v2.3.3`**
   (#714). Confirm the connector's `lastCommitSha` and the code graph's `commitSha` both
   start `c4d54f87`.
7. **Ground truth** for citation checks, outside the repo's tracked tree:
   `git clone --depth 1 --branch v2.3.3 https://github.com/miniflux/v2`, or the release
   source tarball. Check a cited line with `sed -n '163,164p' internal/validator/user.go`.

## 2. LLM

DeepSeek `deepseek-flash` through the Anthropic-compatible endpoint
(`AI_PROVIDER=anthropic`, `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`,
`ANTHROPIC_MODEL=deepseek-flash`). Price it, or usage records as Unpriced:

```bash
MODEL_PRICES={"deepseek-flash":{"inputPerMTok":0.30,"outputPerMTok":1.20,"cacheReadPerMTok":0.006}}
```

These are peak prices; off-peak is half. Record which window the run used.

**Analysis cap.** `ANALYSIS_MONTHLY_TOKEN_CAP` is deployment-wide, not per project, and other
work this month counts against it. Check the headroom before waves B–E; run 4 raised it from 5M
to 20M with 1.53M already used.

## 3. Waves

Waves A–F are one `ui-vision` dispatch each, **in sequence** — they share one browser.
Fill the wave's brief with `fill-brief.mjs` (section 3a), putting the state the previous wave
returned into the state file's `placeholders`. Record each wave's returned IDs before
dispatching the next.

| Wave | Scope | Brief |
|---|---|---|
| A | Setup (steps 5–6 above) + Phases 1–4 | `briefs/wave-a.md` |
| B | Phases 5–8 | `briefs/wave-b.md` |
| C | Phases 9–13 | `briefs/wave-c.md` |
| D | Spec Kit S1–S24 | `briefs/wave-d.md` |
| E | Phases 15–20 + developer-issue impact | `briefs/wave-e.md` |
| F | Journeys 1 (analyst) and 2 (developer), **UI only**, no IDs handed over | `briefs/wave-f.md` |
| G | *Optional.* Implement one request's Spec Kit `tasks.md` on a branch of `openzigs/flux-v2` and prove it builds (`TEST_PLAN.md`, "Wave G") | `briefs/wave-g.md` |
| BA | The 8 BA questions over `POST /api/ai/chat`, one project-scoped session each | `briefs/ba-reask.md` |

The BA re-ask needs no browser. Create a session with `POST /api/ai/sessions`
`{"projectId":"…","title":"BA Qn"}`; the id is at `data.session.id`, not `data.id`. Then send
`POST /api/ai/chat` `{"sessionId":"…","message":"…"}`. Run it over the API even when Phase 10
runs in the UI: in run 3 the auto-mode classifier blocked selecting the `/chat` project-scope
radio, so the UI path may be unavailable without an allow rule.

Wave G is **optional**: run it after wave D, or after journey J2 if wave F ran, and skip it on a
targeted run that did not touch Spec Kit. Dispatch it to an **implementing agent**, not
`ui-vision`; it needs no browser and makes no METIS calls. Its state carries `FEATURE_ISSUE`
(default `4478`), `TASKS_PATH` and `PLAN_PATH` (the `tasks.md` and `plan.md` exported from
METIS), and `SCRATCH_DIR`; fill it with `--wave G`.

Wave F's personas know names, not IDs: its state carries `WORKSPACE_NAME`, `PROJECT_NAME` and
`J1_PROJECT_NAME` (the fresh project journey 1 creates), never a project or run ID. Its sandbox
publishes count toward the run's cap of 2, so leave it a slot or let it dry-run only.

### 3a. The fixes to verify — generated, not hand-written (#954)

1. **Before wave A**, list the candidates since the previous run's METIS SHA:
   ```bash
   node scripts/walkthrough/fixes-since.mjs \
     --previous .playwright-mcp/walkthrough-706-run<N-1>/run.json \
     --out .playwright-mcp/walkthrough-706-run<N>/fixes.json \
     --comment .playwright-mcp/walkthrough-706-run<N>/scope.md --run <N>
   ```
   It reads `metisSha` from the previous `run.json` (or takes `--since <sha>`), lists the PRs
   merged on `main`'s first-parent line since, and keeps those labelled `e2e-walkthrough` (or
   closing such an issue) or touching a UI page, a route, or `server/src/lib/{analysis,
   spec-kit,publishing,docs-gen,traceability,impact-analysis,code-graph}`. Dependabot PRs are
   listed apart, flagged only for a runtime dependency. Every fix the previous run did not
   record as `confirmed` is carried forward.
2. **Review `fixes.json`.** A relevant PR the map cannot place lands in `unmapped` and is
   printed: add it to `docs/walkthroughs/fix-phase-map.json` (by issue, or by PR) and re-run.
   A fix no wave can verify, such as walkthrough tooling, gets `{"skip": "<reason>"}` there and
   is listed under `excluded`, and in the scope comment. Edit a `check` line that would not tell a wave agent what to look at. This review also screens
   the check text: when the map gives none it defaults to the issue or PR title, and that text goes
   verbatim into briefs the wave agents act on.
3. **Post the scope** on #706 before wave A: `gh issue comment 706 --body-file <run>/scope.md`.
4. **Fill the briefs.** Write `<run>/state.json`:
   `{"placeholders": {"RUN_NUMBER": "5", "UI_URL": "…", …}, "requiredPrs": [952]}`, then
   ```bash
   node scripts/walkthrough/fill-brief.mjs --state <run>/state.json \
     --fixes <run>/fixes.json --out <run>/briefs
   ```
   Each brief gets its own wave's fixes as `{{FIXES_TO_VERIFY}}`. It writes nothing while any
   placeholder is unfilled, any PR is `unmapped`, or a `requiredPrs` entry is missing from the
   fixes. Later waves need IDs earlier waves produce, so fill one wave at a time: add `--wave A`
   (or `--wave B`, `A,B`) to fill and check only those briefs, then re-run with the next wave's
   returned IDs added to `state.json`. The unmapped, `requiredPrs` and unknown-brief checks stay
   run-wide; without `--wave`, every brief must be fully filled.
5. **Run the waves**, then record each fix's verdict in `run.json` (section 7).
6. **Build the decks** (section 7), then **close what the run confirmed** (section 8).

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
- **The harness classifier blocks some checks outright.** It denies
  `browser_run_code_unsafe` on a second browser context (two-user presence) and in-page
  `fetch` calls that send `UPDATE` SQL (the read-only query probe). Plan those with the
  operator — who runs or approves them, using no-op writes (`… WHERE false`) — or verify them
  from the database tables, and record which.
- **Spec Kit issue export (S21) cannot publish until #953 lands.** The dry run lists the
  titles and the target repo; Publish then stays disabled with the "not available on this
  server yet" reason. Spend no sandbox slot on it. If Publish is enabled, #953 has landed:
  publish within the 2-issue cap, to `openzigs/flux-v2` only. **Finding-publish has no dry
  run**: it publishes at once and counts against the cap. Impact analyses have no draft path.
- **Wave G** (optional) writes **only** to `openzigs/flux-v2`, and **only** as a push of its
  branch `walkthrough/run-<N>-<issue>`. **No pull requests**, no issues and no comments on any
  repository, and **nothing at all on `miniflux/v2`**. Before pushing, `git remote get-url origin`
  must be `openzigs/flux-v2`. No secrets in the code or commit messages; no `.env` committed.
  **Budget:** about **$3** of the agent's spend or **45 minutes**, whichever comes first; a stop
  is scored as it stands ("builds: not reached"), not as a fail of METIS. The check below covers
  wave G too.
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
Test **Cancel generation** once on purpose (wave C). Run 3's BRD was 2.19 MB and $4.61;
**run 4's was $1.91, 30 min and 171 KB under a 500¢ cap** — the baseline to compare against.
**Regenerate** works only on a failed, cancelled, or degraded-with-no-version document, so test
cancel and resume on a **new** document.

**Doc quality, not only size (#1041).** Wave C scores the BRD and the architecture document
against the answer key and rubric in `TEST_PLAN.md` Phase 9 (coverage, accuracy,
hallucinations, A/B/C/F per section) and returns a fixed `Doc quality —` line per document.
Copy the numbers into `run.json` as `docQuality` (section 7).

**Wave G's cost is not METIS spend (#1043).** The implementing agent's tokens and dollars are
not in `token_usages`: report them from the agent's own usage, **separately**, and never add them
to the run's METIS totals or the `ledger` / `waves` figures. They go in `run.json`
`buildProof.agentCostUsd` (section 7), which the deck labels as the agent's own.

**Approved requirements.** Report how many promoted requirements have no acceptance criteria and
no code link (#909, #926; the query is in wave B's brief).

Results go in a comment built from `docs/walkthroughs/RESULTS_TEMPLATE.md`, including its
run-to-run comparison table, on #706 or a tracking issue that links back. Fix any step the run
found wrong in `TEST_PLAN.md`, in a PR.

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
- **After signing out in Playwright, clicks can stop delivering events.** Open a new tab, and
  sign in or out with in-page `fetch` rather than the account menu, except for the one sign-out
  check Phase 20 asks for.
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
- **Playwright can only write under the repo**: `browser_evaluate` `filename` and any dump go
  in the wave's evidence folder; the scratchpad is outside the allowed roots.
- A custom agent enabled for a project **joins every later analysis run** on it, and gets no
  code there (#938). Disable it after Phase 7.
- **Clarification starts when the Questions tab opens.** Don't remount the tab while it is
  starting; that starts and bills it twice (#937).
- **Run 5 lessons:**
  - **Spec Kit Publish:** needs a feature slug of 41 characters or fewer until #988 lands, because the `speckit:<slug>` label is capped at 50. Use a very short `/speckit.specify` brief for the feature you publish. A failed Publish is recorded in `audit_logs` (`speckit.tasks_export_failed`, `createdBeforeFailure`); check it before counting a sandbox slot.
  - **Request review:** it resets approved requirements to draft (#989), so request the review before approving.
  - **Requirements hub:** it follows only the latest completed analysis (#999).
  - **Second user:** `browser_run_code_unsafe` with `browser.newContext()` was allowed in run 5. Find the context again with `page.context().browser().contexts()`, because globals don't persist between calls.
  - **Vault picker:** the publish page's picker needs an operator allow rule, or the classifier blocks it.
  - **Waits:** `browser_wait_for` with text times out after 5 s. Use timed waits and poll `server/dev.db`.
  - **Dev-mode reloads:** leftover tabs reload the active tab in dev mode, so close them at the start of each wave.
  - **Cost cap:** the per-agent analysis cap is 80,000 tokens (`/api/analyses/cost-cap`, `agentCap`). Most "Could not verify" code findings trace to it (#1001).
- **Spec Kit contracts:** `tasksGate` needs both `spec.md` and `plan.md`; a feature-artifact
  `PUT` takes `{content}`; feature slugs match `^\d{3}-…`.
- **Over the chat API, `inspect_schema` and `query_database` are refused** with
  `no_interactive_approver`, so database-backed BA answers fall back to source.
  `search_code_graph` does not index string-literal config keys.
- An enabled custom skill is loaded into later chat sessions. Disable test skills before the
  BA re-ask.
- Evidence goes under `.playwright-mcp/walkthrough-706-run<N>/<wave>/` (gitignored).

## 7. Build the slideshow — last step of every run (#829)

Each wave appends one line per screenshot to `<evidence-dir>/steps.jsonl`, where
`<evidence-dir>` is `.playwright-mcp/walkthrough-706-run<N>/`; the briefs carry the
instruction and good and bad wording.

**Write `<evidence-dir>/run.json` after filing the run's issues and before building (#947).**
It also carries the run's METIS SHA and every fix verdict (#954). The steps only know the
issues they *checked* and the tokens attributed to them. The issues the
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
             "BA": { "tokens": 90000, "costUsd": 0.12 } },
  "metisSha": "f117d406083316cc8c204399b7826cf69a7fb7a5",
  "previousRunSha": "7cc6310df6999f3f627016d41a0f46f4ec4e9011",
  "fixes": [{ "pr": 950, "issues": [939], "wave": "F", "phase": "J1.4",
              "check": "Approving the checkpoint approves the requirements",
              "status": "confirmed", "evidence": "f-j1-4-1" }],
  "changePlanAccuracy": [{ "issue": 4336, "output": "j2-impact", "source": "curated",
                           "files": { "tp": 2, "fp": 1, "fn": 3 },
                           "functions": { "tp": 3, "fp": 1, "fn": 8 },
                           "migrationCorrect": true }],
  "docQuality": { "brd": { "coverage": { "hit": 11, "total": 15 },
                           "accuracy": { "correct": 10, "stated": 11 }, "hallucinations": 2,
                           "sectionGrades": { "A": 3, "B": 4, "C": 1, "F": 0 } } },
  "buildProof": { "issue": 4478, "branch": "walkthrough/run-7-4478", "commit": "0123abcd",
                  "builds": true, "testsPass": false, "tasksTotal": 8, "tasksCorrected": 2,
                  "files": { "tp": 2, "fp": 1, "fn": 1 }, "functions": { "tp": 2, "fp": 0, "fn": 0 },
                  "agentCostUsd": 2.15, "wallMinutes": 38 }
}
```

- `newIssues`: every issue filed from the run, `severity` one of `high` / `medium` / `low`.
- `ledger`: the run's `token_usages` total from section 5's query, over the whole run window,
  for the walkthrough project, including the BA re-ask's chat rows. `source` must be
  `token_usages`. `tokens` is `SUM("inputTokens" + "outputTokens")` and **excludes
  cache-read tokens**, which is how step `tokens` are counted, so the unattributed remainder
  compares like with like. `costUsd` is `SUM(COALESCE("costUsd", "costCents" / 100.0))`.
- `waves`: optional per-wave totals over each wave's window, keyed `A`–`G` and `BA`;
  `since` / `until` are optional here and record the window.
- `metisSha` / `previousRunSha`: the METIS commit this run tested and the one the previous run
  did. The next run's `fixes-since` starts from `metisSha`.
- `fixes`: every entry of `fixes.json`'s `fixes[]` with a `status` of `confirmed`, `partial`,
  `regressed` or `not-exercised`, and `evidence`, the step id that shows it (required for all
  but `not-exercised`; it must exist in `steps.jsonl`). Keep `carried` when an entry has it.
- `changePlanAccuracy` (#1042): one row per developer issue and output from wave E's and
  wave F's change-plan tables. `output` is `impact`, `chat`, `plan`, `j2-impact` or `j2-plan`;
  `source` is `upstream`, `candidate` or `curated`, as the plan's change set states. `files` and
  `functions` hold **counts** (`tp`, `fp`, `fn`), not ratios: the deck computes precision and
  recall. One row per issue and output, and every row for an issue must agree on `source` and
  on `tp + fn` (the change set's size). The report deck adds a "Change-plan accuracy" slide
  before the new-issues slide.
- `docQuality`: wave C's doc-quality scores, keyed `brd` and/or `architecture`, each with all
  four of `coverage` (`hit`/`total`), `accuracy` (`correct`/`stated`), `hallucinations` and
  `sectionGrades` (`A`/`B`/`C`/`F` counts), as non-negative integers. `hit ≤ total`,
  `correct ≤ stated`, and `stated` must equal `hit` (accuracy is judged over present facts).
  The report summary then shows a doc-quality table, one row per scored document.
- `buildProof` (#1043): wave G's score, when it ran. `branch` is `walkthrough/run-<N>-<issue>`
  and must name `issue`; `commit` is the branch head. `builds` and `testsPass` are `true`,
  `false` or `null` (not reached); tests cannot pass on a build that did not, and a build not
  reached leaves tests not reached. `tasksCorrected ≤ tasksTotal`. `files` and `functions` hold
  counts against the reference change set, and must agree on `tp + fn` with any
  `changePlanAccuracy` row for the same issue. `agentCostUsd` is the implementing agent's own
  spend (section 5), never METIS's. The report deck adds a "Build proof" slide after the
  change-plan accuracy slide.

Every key is optional. Unknown fields are rejected, and an invalid file fails the build,
naming the field, before anything is written. With `ledger`, the summary shows the ledger
total as authoritative, the per-step sum as "attributed to steps", and the unattributed
remainder. With `waves`, the per-wave table uses the ledger, adds a `BA` row, and shows `–`
for a wave it does not list. The summary lists "Issues checked" (the steps' `issues`),
"Fixes confirmed this run (N of M)" with a count per status and the confirmed issues to close,
and "New issues filed (N)" by severity, and the report deck ends with a slide listing the new
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
or a screenshot path outside the evidence folder. It writes nothing to disk until the whole manifest, `run.json` (when present) and every
screenshot path check out.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique step id, e.g. `a-2-1` |
| `wave` | yes | `A`–`G` |
| `phase` | yes | `"2"`, `"S4"`, `"J1.4"`; ordered naturally within a wave |
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

Some issues are merged as partial fixes and left open for the walkthrough to confirm. List the
ones `run.json` records as `confirmed` that are still open:

```bash
node scripts/walkthrough/fixes-since.mjs --close-list .playwright-mcp/walkthrough-706-run<N>/run.json
```

Close each with a comment linking the results comment. Anything not confirmed stays open and
is carried into the next run's `fixes.json` automatically. Record the closures under "Findings"
in the results.
