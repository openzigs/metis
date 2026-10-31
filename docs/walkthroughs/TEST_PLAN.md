# METIS end-to-end walkthrough — test plan

This is the test plan for the end-to-end walkthrough tracked in
[#706](https://github.com/openzigs/metis/issues/706): phases 1–20, Spec Kit S1–S24, pass bars, the
Business Analyst questions, the developer issues, the persona journeys and the conditional wave G build proof. It moved here from #706's body in #948 so that
changes to it are reviewed, show up in PRs and are checked by CI. **Results still go on #706**, as
one comment per run built from [`RESULTS_TEMPLATE.md`](RESULTS_TEMPLATE.md).

The `e2e-walkthrough` skill (`.github/skills/e2e-walkthrough/`) holds the **mechanics**: fixtures,
setup order, waves, guard-rails and measurement. This file holds the **procedure**: what to do and
what passing looks like. The wave briefs point here for the steps; where a phase has a check that
only matters for one run, the brief carries it.

## Run shape: the analyst journey first (#1177)

METIS is built mainly for business analysts; developers are expected to use Claude Code or a
similar tool. From run 10 the run is weighted that way:

- **Journey 1 (the business analyst) is the core of the run.** Two people work on the analyst's
  requirements: a reviewer (`coordinator`) approves or rejects them and the analyst responds, and
  a second analyst (`developer`) comments, mentions and discusses on the same project
  (J1.4a to J1.4c). The operator creates both memberships before wave B (Setup order 3), and
  the second user's sign-ins are operator-run or operator-approved ("Second-user steps" below).
- **The BRD is checked as a deliverable**: its Word and PDF exports are fetched by URL and
  opened, and it is scored on the sign-off rubric (#1175) as well as the answer key (#1041).
  J1 publishes to the sandbox Jira once #1176 provides one (J1.8a); until then that step is
  skipped and recorded.
- **The developer side is a smoke test.** Spec Kit runs a **smoke set** (S2, S4, S6, S7 and
  S21: enable, specify, plan, tasks and export); every other S-step is marked *(optional)*.
  Wave E runs **two** developer requests (#4478 and #4386); the other four are optional.
  Wave G runs only when the METIS commits since the previous run touch Spec Kit or impact
  analysis ("Wave G").
- **Optional steps stay in this plan** with their pass bars. Run one when a fix in the wave's
  fixes-to-verify list names it, or when the operator asks for a full pass; otherwise record it
  `skipped (optional)`, which is neither a pass nor a fail.

Runs 1 to 9 ran the older shape. `RESULTS_TEMPLATE.md` says which run-to-run numbers stay
comparable across the change and which do not.

## Keeping this plan current

- **Feature PRs update it.** A PR that adds or removes a page under `ui/src/app/**/page.tsx`, or
  adds or removes a route in `server/src/routes/**`, must change this file or carry the
  `no-walkthrough-impact` label. CI's `changelog` job enforces it
  (`scripts/verify-walkthrough-plan.mjs`); after adding the label, re-run that job. Dependabot and
  docs-only PRs are exempt.
- **Drift check.** `pnpm walkthrough:check-plan` fails when this file names an API route the
  server does not register, or a UI page with no `page.tsx`. CI runs it on every PR, and a run
  starts with it.
- **What the drift check reads.** Inline code spans only, outside fenced blocks:
  - `` `GET /api/projects/:id/overview` `` or `` `/api/projects/:id/overview` `` is an API route.
    With a method it must match a registered route exactly; without one, something must be
    registered at or under that path.
  - `` `/projects/:id/settings` `` (a bare path) is a UI page. A query string is ignored.
  - `` `POST …/documents/url` `` (with an ellipsis) is relative to the route the sentence last
    named, so it is checked as a suffix: some registered route (with that method) must end with
    it, and the segment after the ellipsis must be a literal of that route. That cannot tell
    *which* prefix you meant, so prefer a full path when adding a step.
  - `:id`, `<token>`, `{id}` and `[id]` are placeholders; `a|b` in a segment names both routes.
  - Spec Kit commands are written without a leading slash (`speckit.plan`), so they are not read
    as pages. A line that must name a dead path on purpose ends with
    `<!-- drift-check: skip -->`.
  - The route walk also fails on a server mount it cannot follow (`r.use("/x", fooRouter())`
    where `fooRouter` is a relative import it cannot resolve). A call into a package
    (`cors({…})`) is middleware and passes. A mount that must stay unfollowed on purpose
    carries `// drift-check: skip` on its `.use(` line.

> **Setup notes (2026-10-02, from #706):**
> - **DeepSeek:** `.env` already has `AI_PROVIDER=anthropic`, `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` and `ANTHROPIC_MODEL=deepseek-flash`, plus the key.
> - **Prices:** `MODEL_PRICES` has been added to `.env` at DeepSeek's peak list prices, checked today: input $0.30, output $1.20, cache-read $0.006 per 1M tokens. Off-peak is half these. The env value is a fallback, so a DB-set value at `/settings/api-keys` takes precedence if one exists.
> - **Sandbox:** the publish target is the fork **`openzigs/flux-v2`**, forked from `miniflux/v2`. **Issues are disabled on it by default**, so enable them before Phase 12 / S21.
> - **Browser:** the Playwright MCP was fixed in #709. Restart Claude Code before starting the run.

## Goal

`ui-vision` drives a real headed browser through **every user-facing METIS feature**, start to finish, on one real open-source project, with **DeepSeek Flash** as the only LLM. The run must prove two things:

1. **Works.** Every feature completes without errors, with no console errors, no 4xx/5xx it didn't intend, and no spinner that never finishes.
2. **Useful.** Every feature's output is good enough for a **Business Analyst** to answer domain questions, or for a **Developer** to work a real issue. Each "Useful" check below can be verified against the pinned source.

Spec Kit is covered in its own section (Phase 14).

## Sample project

### Primary: `miniflux/v2` (minimalist self-hosted feed reader)

| | |
|---|---|
| Clone URL | `https://github.com/miniflux/v2.git` |
| Pin | tag **`v2.3.3`** = `c4d54f87a81b30aa173fddf05d7ff83ae7da5796` (committed 2026-07-23) |
| Licence | Apache-2.0 (permissive) |
| Activity | last push **2026-10-01**; 9,764 stars; 287 open issues + PRs; not archived (`gh api repos/miniflux/v2`, read 2026-10-02) |
| Size | about 44k lines of non-test Go, about 37k lines of Go tests (88 `_test.go` files), about 11k lines of JS/HTML/CSS. Total ≈ 92k, inside the 20k–150k target. Measured on `main@703fe826`, not on the tag; expect a similar size. |
| Language | Go. METIS has a Go parser and rule miner (`server/src/lib/code-graph/go-rule-miner.ts`). Not affected by #318. |
| Database | PostgreSQL only. **135 schema migrations** as Go funcs in `internal/database/migrations.go`. Hand-written SQL throughout `internal/storage/*.go` (17 files with SELECT/INSERT/UPDATE). |
| Tests | Unit and integration tests across `internal/**`, e.g. `internal/validator/*_test.go`, `internal/api/api_integration_test.go`. |
| Domain | Users, feeds, categories, entries, enclosures, refresh scheduling, retention/cleanup, 31 third-party integrations, OAuth2/OIDC, WebAuthn, API keys, plus Fever and Google Reader compatibility APIs. |

**Why Miniflux.**
- Its raw SQL in Go string literals is exactly what METIS's embedded-SQL extractor targets (`server/src/lib/code-graph/embedded-sql-extractor.ts`, which covers TS/JS/Python/Go/Java). Together with the Postgres DB connector, that exercises code→table/column lineage from both sides.
- It is Postgres-only, so the database connector gets a real schema just by running Miniflux's own migrations.
- Its issue tracker is active and has well-scoped feature requests.
- It is mid-sized, permissively licensed and mainstream Go.

### Backup: `healthchecks/healthchecks` (cron-job monitoring)

| | |
|---|---|
| Clone URL | `https://github.com/healthchecks/healthchecks.git` |
| Pin | tag **`v4.4`** = `49924faadf0f24a846abc3acf3014b396fdc1f29` (committed 2026-08-31) |
| Licence / activity | BSD-3-Clause; last push **2026-10-02**; 10,377 stars; 54 open issues + PRs |
| Size | about 40k lines of Python excluding migrations (tests included), about 23k lines of templates/JS/CSS; 192 migration files; 200 `test_*.py` files. Measured on `master@e566e1c`. |
| Trade-off | It has the richer BA domain: plans and limits, team roles (`Member.Role` READONLY/REGULAR/MANAGER at `hc/accounts/models.py:602`), grace periods and billing. But it uses the **Django ORM**, and METIS has no Django extractor (the ORM extractor is JPA and Prisma only). Code→DB lineage would come only from the live DB connector. Use it only if Miniflux is blocked. Possible developer issues: #1347 (webhook 2xx handling, `hc/api/transports.py:161`), #939 (log truncation, `hc/api/transports.py:50-51`), #1005 (read-only members can create projects, `hc/accounts/views.py:348`). |

## Environment and LLM setup (DeepSeek Flash)

**How it works.** METIS reaches DeepSeek through its **Anthropic provider** (the official `@anthropic-ai/sdk`) pointed at DeepSeek's Anthropic-compatible endpoint.
- `isDeepSeekEndpoint()` (`server/src/lib/ai/providers/anthropic-endpoint.ts:12`) matches any `*.deepseek.com` host.
- On that endpoint, `AnthropicProvider` turns off `responseFormat` and `jsonSchema` (`server/src/lib/ai/providers/anthropic-provider.ts:231-259`). The model catalog drops the built-in Claude entries and marks every model `jsonSchema: false` (`server/src/lib/ai/model-catalog.ts:715-771`).

**Model id: `deepseek-flash`.** Checked against DeepSeek's docs on **2026-10-02**:
- `https://api-docs.deepseek.com/guides/anthropic_api` names `deepseek-flash` as the primary model. `claude-haiku-*` and `claude-sonnet-*` map to `deepseek-flash`; `claude-opus-*` maps to `deepseek-v4-pro`.
- `https://api-docs.deepseek.com/quick_start/pricing` lists `deepseek-flash` with a 1M context and 384K max output. The legacy `deepseek-v4-flash` is "still accepted but retired".
- Set the id explicitly. Don't rely on the `claude-*` name mapping.

**Steps (root `.env`, then restart the server):**

```dotenv
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=<DeepSeek API key>            # DeepSeek key, NOT an Anthropic key
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_MODEL=deepseek-flash
# leave ANALYSIS_NATIVE_TOOL_CALLS unset (default OFF) — see limitations
# SQL lineage sidecar must be reachable for Phase 5 lineage checks:
# SQL_LINEAGE_URL=...   (see docker-compose.prod.yml `sql-lineage` service, port 5070)
```

1. In the UI, open **Project settings** (`/projects/:id/settings`, the `ai-provider-picker` / `ai-model-picker` cards) and confirm the provider is `anthropic` and the model is `deepseek-flash`. `GET /api/ai/models` should list `deepseek-flash` with `source: "configured"`, `jsonSchema: false`, and no `claude-*` built-ins.
2. **Pricing.** Without a price, DeepSeek usage is recorded as **Unpriced** (`docs/USER_GUIDE.md` §Usage). Before Phase 1, an admin sets `MODEL_PRICES` at **Settings → Configuration** (`/settings/api-keys`, `PUT /api/admin/config/MODEL_PRICES`). DeepSeek's peak prices, read 2026-10-02, are used here as an upper bound because METIS has no peak/off-peak model:
   ```json
   { "deepseek-flash": { "inputPerMTok": 0.30, "outputPerMTok": 1.20, "cacheReadPerMTok": 0.006 } }
   ```
   Off-peak prices are half of these.
3. Set a project budget (`/projects/:id/settings` budget card, `PATCH /api/projects/:id/budget`). The card takes **tokens**, not dollars. Suggested: **30,000,000** tokens for the whole walkthrough (run 8's setting; at DeepSeek's peak prices a full pass costs well under $25).

**Cost note.** A full pass (ingest, analysis with deep dives, 3 doc generations, Spec Kit, impact ×3, PR review, chat) was estimated at **5–20M tokens, about $2–$25 at peak**. Measured: run 3 spent $9.84 and run 4 $4.32. Record the real figure per phase.

**Known limitations to expect. Do not file these as new bugs.**
- **No `json_schema` on DeepSeek.** Structured output goes through the parse-and-repair path (`docs/ARCHITECTURE.md` §6.2). Occasional repair retries in the logs are expected. File a finding only for a **user-visible** failure.
- **`ANALYSIS_NATIVE_TOOL_CALLS` is off by default** (`server/src/lib/analysis/agent-loop.ts:218`). Analysis uses the text tool protocol, and #214 tracks flipping the default. Chat uses native tool calls whenever the model can.
- **DeepSeek thinks by default.** Docs-gen adds a reasoning allowance (`DOCS_GEN_REASONING_ALLOWANCE_TOKENS`, default 32768). Grounding calls send `thinking: disabled` (`.env.example` §#247). Expect long docs-gen latencies.
- **#197 is OPEN.** The recorded fixtures in `server/tests/fixtures/llm/provider-contract/deepseek/` all use `deepseek-v4-pro`, so nothing in CI covers `deepseek-flash`. This walkthrough is the first live end-to-end evidence for it.
- **DeepSeek ignores `cache_control`** (its own guide says so). Cache-hit figures come from DeepSeek's automatic caching, if it reports any.
- **Embeddings do not come from DeepSeek**, which has no embeddings API. They come from the embeddings backend (`EMBEDDINGS_MODE`; in-process Xenova by default in dev).

## Preconditions

- [ ] **Dev stack is running.** Use the `run-metis-dev` skill: it launches server and UI, covers stale deps, the stale `@metis/shared` build (`pnpm --filter @metis/shared build`), the migration-guard spawn and mock auth. Do its chat smoke first, against DeepSeek, not Ollama.
- [ ] **Check that the headed Playwright MCP connects before anything else.**
  - Earlier sessions failed with **`playwright-headed (CONNECTION_CLOSED)`**. Root cause, confirmed 2026-10-02: `.mcp.json` passes `--headed`, and `@playwright/mcp@latest` rejects it with `error: unknown option '--headed' (Did you mean --headless?)`. The server is headed by default.
  - Fix: remove the arg, or use the plain `playwright` server, which is what `ui-vision` declares (`mcp__playwright__*`).
  - Then call `browser_navigate` to `http://localhost:3000/dashboard` and take a screenshot. **Stop and report if it fails.**
- [ ] **Embeddings backend is real, not the hash stub.** `/settings/embeddings` (`GET /api/admin/embeddings`) must show a backend other than **"Offline hash stub"** (`metis-offline-hash-v1`, `server/src/lib/rag/embedder.ts:669`). Spec Kit's RAG silently goes ungrounded on empty retrieval (`server/src/lib/spec-kit/rag-context.ts`).
- [ ] **SQL lineage sidecar is reachable** (`SQL_LINEAGE_URL`) and **rebuilt from this commit** (see the skill's setup). Without it, embedded-SQL lineage degrades to nothing by design (`embedded-sql-extractor.ts`).
- [ ] **A Miniflux Postgres database exists** for the DB connector, migrated and seeded (the skill's setup steps 2–3; `scripts/walkthrough/miniflux-seed.sql`). `\dt` should list `users`, `feeds`, `entries`, `categories`, `enclosures`, `icons`, `api_keys` and so on.
- [ ] **GitHub token** in the vault (`/vault`) with read access to `miniflux/v2`, for PRs and issue import.
- [ ] **A sandbox publish target**: a personal fork or scratch repo, e.g. `openzigs/flux-v2`. **Never publish issues, PRs or comments to `miniflux/v2`.** Every publish step uses dry-run first, then the sandbox.
- [ ] `MODEL_PRICES` and the project budget are set (see above).
- [ ] **Analysis headroom.** `ANALYSIS_MONTHLY_TOKEN_CAP` is deployment-wide, not per project. Check how much of it this month has used before waves B–E (run 4 raised it from 5M to 20M with 1.53M already spent).
- [ ] `pnpm walkthrough:check-plan` passes on the commit under test.

## Setup order (learned from run 1, 2026-10-02)

Run 1 set things up in the wrong order, and three things could not be recovered without a fresh project. Do them **in this order**, before Phase 1's ingest. The commands are in the `e2e-walkthrough` skill, section 1.

1. **Start the SQL lineage sidecar first.** Set `SQL_LINEAGE_MODE=sidecar`, `SQL_LINEAGE_URL=http://127.0.0.1:5070` and `SQL_LINEAGE_TOKEN` in `.env`, then restart the server.
   - Deep Ingest is incremental. Turning lineage on after the first ingest leaves **0** `reads`/`writes` edges (#721).
2. **Create the workspace first, then create the project inside it.** #731 (PR #927) now lets an existing project join a workspace, but create it inside so runs stay comparable; Phase 5 tests the move on a throwaway project. Without a workspace, requirement links, workspace traceability, DB identity and the custom-agent wizard (`/workspaces/:id/agents/new`) are all unavailable.
3. **The operator creates the second users' memberships before wave B.** `coordinator` is the reviewer (Phase 8 and J1's reviewer) and `developer` is J1's second analyst (and S3b's non-editor). For each: `POST /api/workspaces/:id/invites` `{email, role: "member"}` as `admin` (the mock users' emails are `<name>@metis.local`), then, signed in as that user in the operator's own browser, open `/invites/<token>` and accept, then sign them in afresh. Both users then exist and are members before any wave needs them. Reviewers must be workspace members. Run 9's classifier refused the invite in waves B and D and allowed it only in F, so a wave cannot be relied on to do it. Confirm both are listed under **Members** on `/settings/workspaces/:id`.
4. **Add the repo connector pinned to `v2.3.3` before anything auto-ingests `main`.** Never click **Test** on it afterwards, because Test resets the branch to the default (#714).
5. **There is no `ChangeLog` at v2.3.3.** Phase 3 uploads `miniflux.1` (renamed `.txt`; `.1` is rejected) instead.
6. **Never reject an approval item on a run you still need.** One rejection permanently blocked promotion, Deep Dive and publishing for that run (#723); PR #902 changes that, and wave B re-verifies it on a throwaway run.
7. **API checks:** login is limited to 20 per 15 minutes. Use `fetch('/api/...')` from the logged-in page instead.
8. **Run the UI and server dev processes in a terminal you own**, not as a harness background task, which is killed after at most 2 h.

### Second-user steps (operator-run or operator-approved)

A step marked **[2nd user]** is done by a user other than the one the wave is signed in as. The
harness classifier has refused a wave agent signing in a second user (`browser_run_code_unsafe`
with `browser.newContext()`: allowed in run 5, refused in waves B and D of run 9, allowed in F),
so no wave relies on it. The operator chooses one way, before filling the first brief that uses
it (wave C), and the briefs carry the choice as `SECOND_USER_MODE`, a run-wide `state.json` key.
To choose differently for a later wave, change it in `state.json` before filling that wave.

**Who is who.** Priya, Sam and "the reviewer" are role names. In the UI they are the mock users'
display names: Priya is `admin` (**System Admin**), the reviewer is `coordinator` (**Test
Coordinator**) and Sam is `developer` (**Test Developer**). "@mentions Priya" means picking
**System Admin** in the mention picker.

- **`operator-approved`**: the operator adds a Claude Code auto-mode allow rule for the
  second-context call, and the wave agent drives the second user in its own browser context. If
  the call is refused anyway, the agent stops the [2nd user] steps there and returns them as
  pending, as for `operator-run`.
- **`operator-run`**: the operator does each [2nd user] step in their own browser, following the
  step's text: a private window signed in as the named mock user (password `password`), **and a
  second, normal window signed in as `admin` (Priya), open on the page the step's must-hold names**
  (the requirement's comment panel, the discussion thread, the review). That second window is the
  observer for every live and presence check, because the wave agent has returned by then and can
  only look after a reload. The operator writes what that window showed, without reloading it, to
  `.playwright-mcp/walkthrough-706-run<N>/operator/notes.md`, one block per step id, with a
  screenshot beside it in the same folder.
  - **Wave F** stops before J1.4a and returns `Operator steps pending: J1.4a, J1.4b, J1.4c`.
    The two users' actions in those steps interleave live, so the operator does all three, Priya's
    part included in the `admin` window, and wave F is re-dispatched with `J1_RESUME_AT` set to
    `J1.5`. The agent reads `operator/notes.md`, records each operator step in `steps.jsonl` with
    the operator's observation as its `result` and screenshot, and checks the lasting result from
    Priya's own screen: the notification, the review's status, the comment or the message.
  - **Waves C and D are never re-dispatched for an operator step.** Re-running wave C would
    repeat Phase 9's docs generation, the run's largest spend. The agent finishes the rest of the
    wave and returns the [2nd user] checks (Phase 11, S3b, S12) as `Operator steps pending`; the
    operator does them after the wave, records them in `operator/notes.md` the same way, and the
    results comment takes them from there.

A live or presence check that nobody watched as it happened is recorded `not-exercised
(operator-run)`, never passed on what a reload shows.

Record in the step's `result` which way it ran: `operator-run`, `operator-approved` or `agent`.
Never work around a refusal: no API calls made as the other user, no tokens minted for them, no
SQL. A [2nd user] step that nobody could run is `blocked`, with the reason.

## The walkthrough

Every phase records: **steps → Works → Useful**, plus the evidence listed under "Evidence to capture". Paths: UI = `ui/src/app/(authed)/…`; API = `/api/…`, defined in `server/src/routes/…`.

### Phase 1 — Project creation and setup
- **Steps:**
  1. Go to `/projects` and use the create form (`components/projects/project-create-form`). This calls `POST /api/projects`. Name the project "Miniflux v2.3.3".
  2. Open `/projects/:id` (pipeline overview), then `/projects/:id/settings`. Confirm the AI provider and model, then set the budget, safety, autopilot (off) and database-aware analysis (on). These call `PATCH /api/projects/:id`, `PATCH /api/projects/:id/budget` and `…/database-aware-analysis`.
  3. Open `/projects/:id/settings/models`. This calls `GET /api/projects/:id/model-preferences` and `…/analyses/model-recommendation`.
- **Works:** the project appears in `/projects` and on `/dashboard`, settings persist across a reload, and the model picker shows `deepseek-flash`. The workspace slug field logs no console error and rejects an invalid slug (#729).
- **Useful:** the model recommendation names `deepseek-flash` or explains why not. It must not recommend a `claude-*` model that DeepSeek would silently remap. `/projects/:id/settings/models` shows no Claude model at Anthropic prices, and shows a price for `deepseek-flash` only from `MODEL_PRICES` (#713).

### Phase 2 — Connectors: repository
- **Steps:**
  1. In `/projects/:id/connections`, add a repo connector for `https://github.com/miniflux/v2.git` at ref `v2.3.3`, using the vault picker for the token. This calls `POST /api/projects/:id/connectors/repos`. Connector labels must match `^[A-Za-z0-9][A-Za-z0-9 _.\-]*$`.
  2. Run `…/repos/:id/test`, then **deep ingest**: `POST /api/projects/:id/connectors/repos/:repoId/deep-ingest` (clone + code graph + RAG). Then `set-primary`.
  3. Open `/repositories`, the cross-project repository list (no redirect), and confirm Miniflux is listed. `/projects/:id/repositories` redirects to `/projects/:id/connections` (#1371), so expect that redirect and do not file it.
- **Works:**
  - The ingest job's progress (`components/realtime/job-progress`) reaches completion.
  - The code-graph stats are greater than 0. `GET /api/projects/:id/connectors/repos/:repoId` carries none, so read them from the Deep Ingest banner on `/projects/:id/connections` (its text reads "code graph of N files, N symbols, N edges"; run 8 showed 427 files, 3,845 symbols, 28,158 edges). Or press **Sync** on the connector card: `POST /api/projects/:id/connectors/repos/:repoId/refresh-ingest` returns `data.codeGraph.graphFiles`, `data.codeGraph.graphSymbols` and `data.codeGraph.graphEdges`, which the Sync result panel shows as `sync-graph-totals`. Starting a Deep Ingest clears that panel, and the deep-ingest job event carries only the banner message.
  - The connector card reads `connected` with the commit as soon as the first ingest ends, with no reload, and its commit is the code graph's `commitSha` (#758, #762).
  - The Deep Ingest banner reports the graph's totals ("code graph of N files, …"), not the delta (#715).
  - No credential-scan quarantine for Miniflux. If one fires, record which file.
- **Useful:** the code graph stats name a file count on the order of Miniflux's roughly 400 Go files *(order of magnitude; confirm with `find . -name '*.go' | wc -l` at the tag)*. `internal/storage`, `internal/api` and `internal/validator` appear as modules.

### Phase 3 — Ingest, embeddings and RAG
- **Steps:**
  1. In `/projects/:id/documents`, upload `README.md` and `miniflux.1` (as `.txt`) from the checkout (`POST /api/projects/:id/documents`). Add the URL `https://miniflux.app/docs/api.html` (`POST …/documents/url`) and one text note (`POST …/documents/text`).
  2. Approve the documents (`POST …/documents/:id/approve`). Uploaded documents, URLs and pasted notes all land in quarantine (Project settings → Quarantine) until approved.
  3. In `/settings/embeddings`, view the project's coverage (`GET /api/admin/embeddings/projects/:id/coverage`) and trigger a reindex (`POST …/reindex`, which returns 202 plus a jobId).
  4. Query retrieval: `POST /api/projects/:id/retrieve` with "how often are feeds refreshed".
- **Works:**
  - Documents reach a ready/indexed status, with no indexing error (see `documents.indexing-error.test.ts` for that shape).
  - Coverage is 100% at the active backend's dimension.
  - The reindex job completes. It streams a second phase, "Re-embedded X/Y code symbols", and its completion names both phases (#862); confirm the end with `shadow.inProgress=false` on the coverage route.
  - Record the repo connector's source-document count; Phase 13 compares it after a refresh.
- **Useful:** the retrieval top-k includes `internal/model/feed.go` (`ScheduleNextCheck`, line 123) or `internal/config/options.go` (`POLLING_SCHEDULER`, line 511), with a score shown.

### Phase 4 — Code graph and project overview
- **Steps:**
  1. Open `/projects/:id/overview` (`GET /api/projects/:id/overview`), then click **regenerate** (`POST …/overview/regenerate`).
  2. *(Removed in run 3: the bug scanner, its scans and rule sets were removed by #799.)*
- **Works:** the overview renders markdown with entry points.
- **Useful:** the overview correctly says three things:
  - the entry point is `main.go` → `internal/cli`;
  - persistence is `internal/storage` on PostgreSQL;
  - the HTTP surfaces are `internal/ui` (web), `internal/api` (REST), `internal/fever` and `internal/googlereader` (compatibility APIs).

### Phase 5 — Connectors: database and lineage
- **Steps:**
  1. In `/projects/:id/connections`, use the DB connector wizard (`components/connectors/db-connector-wizard`) to add a Postgres connector to `mf-pg`. This calls `POST /api/projects/:id/connectors/dbs`, then `…/test`, `…/inspect`, `…/ingest`, and `…/link` to the repo connector.
  2. Open `/databases`.
  3. Open lineage via `GET /api/projects/:id/sql-lineage` and data mappings via `GET /api/projects/:id/data-mappings`, and record the lineage edge count by kind and source (run 2: 1,436 reads/writes edges).
  4. **Move a project into a workspace (#731).** A project outside a workspace can only be created through `POST /api/projects` (the UI creates projects inside one). Create a throwaway project that way, open its **Project settings → Workspace** card, choose the run's workspace, **Add**, and confirm.
- **Works:**
  - Inspect lists the tables.
  - Ingest completes.
  - `dbs/identities` shows the connector.
  - The read-only query (`POST …/dbs/:id/query`) accepts a `SELECT` and **rejects** an `UPDATE` (`sql-validator.ts`). The harness classifier refuses an agent sending `UPDATE` SQL, so the operator runs this probe with a no-op write (`… WHERE false`).
  - The moved project's card shows the workspace (`workspace-assign-current`) and the project is listed in it; on the run's own project the card offers no move.
- **Useful:**
  - Lineage links `internal/storage/feed.go` `UpdateFeed` (line 331) to `feeds.checked_at` and `feeds.parsing_error_count`.
  - Lineage links `internal/storage/entry.go` `MarkAllAsRead` (line 506) to `entries.status`.
  - A missing edge for either is a **weak result**. Before filing it, probe the sidecar's `POST /extract_usage` directly with the function's SQL: a correct answer there means the stored graph is stale, not the sidecar wrong (#935).

### Phase 6 — Connectors: import and Jira
- **Steps:**
  1. In `/projects/:id/import`, add an import source of kind `github`, owner `miniflux`, repo `v2`, state `open` (`POST /api/projects/:id/imports/preview`, then `POST …/sources`). Watch `GET …/runs`.
     For a feature-only import, put `[Feature]:` in "Title starts with" (`titlePrefixes`, #1006). The preview count drops to the `[Feature]:` issues only, and the imported titles no longer carry the prefix.
  1a. Re-sync keeps edits (#1220). On `/projects/:id/analysis`, open the import's run, **Edit** one imported requirement's body and save, then **Run now** on the source (`POST …/sources/:id/run`). The edit stays and the run's badge says "kept 1 local edit". To see a divergence without changing Miniflux, set that requirement's `sourceFingerprint` to NULL in the database and **Run now** again: because it was edited (History), its card shows **Diverged from source** worded "edited in METIS before METIS tracked its source"; an imported requirement nobody edited, given the same NULL, is simply updated; **Compare**, then **Keep mine** (`POST /api/requirements/:id/source-divergence`). The badge goes, the version is unchanged (an approved review stays approved), and History says the local version was kept.
  2. Open `/projects/:id/jira` (`/api/jira/connections`). *(The test-management connections page was removed with Test Coverage, #812 / #819.)*
- **Works:**
  - The preview shows a count roughly equal to Miniflux's open *issues* (fewer than the 287 issues + PRs).
  - Re-sync never puts back an edited requirement's source text (#1220): an unchanged source keeps the edit; a divergence shows the badge and both answers.
  - The run completes.
  - Jira shows a clean "not configured" state. **Skip its live path unless credentials exist**, and record "skipped: no credentials".
- **Useful:** the imported items include #4511, #4336 and #4478 with their titles intact. The three bug reports added to the developer requests (#4479, #4386, #4456, #1044) are **closed** upstream, so a `state` `open` import must **not** include them (if it does, the state filter is broken: a finding). To have them as imported items too, add a second source with state `closed` (the import page's "State (open / closed / all)"; about 1,280 closed issues on 2026-10-10) and check that they arrive with their titles intact. Otherwise paste their text from a read-only `gh issue view <n> -R miniflux/v2`.

### Phase 7 — Analysis, deep dive and agents
- **Steps:**
  1. In `/projects/:id/analysis`, start an analysis: `POST /api/projects/:id/analyses`, after `GET …/analyses/capability` and `GET /api/analyses/personas`.
     To analyse imported items, tick them in "Analyze imported requirements" (`GET …/analyses/imported-requirements`, sent as `importedRequirementIds`, #1006). The run's Summary tab then lists each one as "Imported requirements analyzed in this run", with its `NR-*` id and a link back to the GitHub issue.
  2. Watch the agents (`code`, `database`, `document`, `synthesis`, `web`). An analysis shows "0 tok" until it ends, so poll `GET /api/analyses/:id`.
  3. Open one finding's **deep dive** (`POST …/analyses/:aid/findings/:fid/deep-dive`).
  4. Regenerate one agent (`POST /api/analyses/:id/agents/:agentKey/regenerate`).
     On a run whose requirements were approved in the checkpoint (#1389): before regenerating, note one requirement's acceptance criteria. After the regenerate every approved requirement still reads **approved** and keeps the criteria it was approved with; a requirement the re-synthesis gave no criteria shows nothing. If any requirement got materially different criteria, one notice above the list reads **Re-synthesis suggested different acceptance criteria for N approved requirements** (no per-card notice before **Review**). **Review** shows only those; **Accept** on one (`POST /api/requirements/:id/criteria-proposal`) writes the suggestion as your version, and **Restore** in History on the version before it brings the approved criteria back. **Keep approved criteria for all** (`POST …/analyses/:id/criteria-proposals/dismiss-all`) clears the rest with no new version, and a second Regenerate raises none for them. A requirement that lost its approved criteria, or reads unreviewed, is a FAIL.
     On a run where you reviewed a requirement yourself (approve, edit, link or comment) before regenerating (#780): the regenerate is withheld, and the notice above the list offers **Review changes**. **Review changes** (`GET …/analyses/:id/withheld-replacement`) lists new, changed (current and new side by side) and left-out requirements by title, with no ids. Inside the open comparison, **Apply changes** asks first and names each reviewed requirement that gets new wording. Confirming (`POST …/analyses/:id/withheld-replacement/apply`) clears the notice. Each reviewed requirement keeps its status and links, and its History shows a version under your name. **Dismiss changes**, also inside the open comparison, asks first and changes no requirement (`POST …/withheld-replacement/dismiss`). Signed in as a developer, the comparison shows but Apply and Dismiss do not, and it says to ask someone who can edit the project (a coordinator or admin). Edit a reviewed requirement, or change its status, in another tab after opening the comparison: Apply then applies nothing and says the requirements changed. Regenerate again while the comparison is open: Apply then says a newer re-synthesis replaced the one you were reviewing. A reviewed requirement that was deleted or lost its status is a FAIL.
  5. Run clarify (`GET/POST …/clarify`, `…/clarify/export`). **Clarification starts when the Questions tab opens**; don't switch away and back while it is starting, which starts it twice (#937).
  6. Run the gap report (`…/gap-report`), export (`…/export`) and approvals (`…/approvals`).
- **Custom and library agents:**
  1. In `/library?tab=agents`, enable a library agent for this project (`PUT /api/projects/:id/library/agents/:agentId`).
  2. In `/workspaces/:id/agents/new`, create a custom agent named "Go SQL reviewer" (`POST /api/custom-agents`). The **tools** step lists `search_code_graph`, `search_code_symbols` and `read_file_slice`; the **playground** says it runs on the prompt alone and every playground answer carries the "Ungrounded answer" notice.
     #1445: once saved, the wizard says the agent is **off for this project until you enable it**. On the project's **Custom agents** card it reads **Off until enabled**, and chat's agent picker does not offer it. Signed in as a plain member (not a workspace admin), the playground answers 409 "… is off for this project until a workspace admin enables it" (the card reads `GET /api/custom-agents/projects/:id/disabled` for the **Off** label).
  3. Enable it (`PUT /api/custom-agents/:id/enablement`) and invoke it (`POST /api/custom-agents/:id/invoke`). The card now reads **On**, and the agent picker offers it. Disable it, then reopen a chat bound to it: a notice names the agent and says it is switched off for the project. Enable it again before step 4.
  4. Start a **second** analysis run with both agents enabled. Their findings carry the **Not checked against code** badge, and the findings filter offers **Not checked**. Custom agents get no code in analysis runs (#938), so a custom-agent finding shown as Confirmed is a FAIL. **Disable both agents afterwards**: an enabled custom agent joins every later run on the project.
- **Web research without a provider:** with `WEB_SEARCH_PROVIDER` unset, **Evidence Review** shows one `web-research-notice`, and the `web` agent cites no repository file, database object or score-0 fallback chunk.
- **Works:**
  - The analysis reaches a terminal state with every agent done or degraded, never stuck.
  - Cancel works on a third run.
  - The cost cap (`/api/analyses/cost-cap`) is shown.
  - The custom agent's invocation returns.
- **Useful:**
  - At least 5 findings with **code citations** (`components/findings/code-citation`) that open the right file and line at `v2.3.3`.
  - The deep dive on a storage finding cites SQL in `internal/storage/*.go`.
  - There are no findings about files that do not exist. Spot-check 5 citations.

### Phase 8 — Requirements and traceability
- **Steps:**
  1. In `/projects/:id/requirements` (`components/requirements/requirements-hub`), review the requirements extracted from the analysis. Approve them in the Approvals checkpoint, editing one first. **Approve all N pending** on the Approvals tab (`POST …/approvals/approve-all`, asks for confirmation) resolves the rest in one go (#939).
  2. Approve, reject or edit one (`PATCH /api/analyses/:id/requirements/:reqId`, versioned: a stale `version` gets 409 `VERSION_CONFLICT`).
  3. Open the per-requirement traceability (`GET /api/projects/:id/requirements/:reqId/traceability`) and link a requirement (`POST /api/requirements/:reqId/links`).
  4. Open `/workspaces/:id/traceability` (`GET /api/workspaces/:wid/traceability/summary`) and `/projects/:id/baselines`. As an admin, **New baseline** pins every requirement except items imported from a tracker that nobody has approved, and its form says how many it pins and leaves out first (#1137); make a second after an edit and **compare** them. A subset still needs `POST /api/projects/:id/baselines` `{name, requirementIds}`.
  5. **Request review** on the Requirements page for `coordinator` (a workspace member; see Setup order 3). It is listed on `/reviews`.
- **Works:** requirements approved in the checkpoint arrive on the hub already **Approved**, not "Awaiting review", so they need no second Approve (#939); links persist, the workspace roll-up counts match (the moved project from Phase 5 appears in it), the baseline compare shows the edit, and `request-review-done` confirms the review.
- **Useful:**
  - *Conditional on the requirement existing.* The requirement "a user cannot subscribe to the same feed URL twice" traces to `unique (user_id, feed_url)` (`internal/database/migrations.go:69`) and to the feed validator in `internal/validator/feed.go` or `subscription.go`. Runs 8 and 9 produced neither it nor the "Reading Speed Validation" fallback, so the analysis cannot be relied on to produce a named requirement. Either **seed** the feed-URL requirement on the hub before Phase 8 (and say so: a seeded requirement tests the trace, not the extraction), or take the first requirement whose mapped code is in `internal/validator/` and check it traces to that validator file. If neither exists, record this bar as **n/a**, not a fail. Record which was used.
  - Approved requirements keep their acceptance criteria and code links (#730, #909). Report how many promoted requirements have none of each (run 3: 29/29 without criteria; run 4: 3/37).

### Phase 9 — Docs generation
- **Steps:** in `/projects/:id/documentation`, generate three documents with `POST /api/projects/:id/docs/generate` (rate limit is 5 per 15 minutes):
  1. `docType: business-requirements`, scope `full`, with `DOCS_GEN_BRD_LAYOUT=reader` set in **Settings** (the registry, not the server environment: an environment change queues a regeneration of every document, #1119). That is the layout the sign-off rubric below scores: a main document for a business reader, then an appendix with the module-by-module detail (#1175). Record the layout used;
  2. `architecture`, scope `repository`;
  3. scope `database`, which produces a schema graph.

  Then view versions and provenance (`…/docs/:docId/versions/:vid/provenance`), export (`…/export?format=`), regenerate (`…/regenerate`), and open the schema graph (`…/schema-graph`).
  - **Do not leave `/projects/:id/documentation` open while a document generates** (run 10, #1570): the page polls `GET /api/projects/:id/docs` and `GET /api/projects/:id/docs/:docId` about 3 times a second and trips its own `GENERATED_DOCS_RATE_LIMITED` limiter (900 per 15 min) within ~5 min, freezing progress for up to 15 min. Watch progress from the API or the database, and open the page only to act on it (Cancel, Regenerate, provenance). A 429 seen with the page closed is a finding; one caused by leaving it open is the known #1570.
  - **Cancel once on purpose** (#855): start a **new** document, and after its first section finishes click **Cancel generation** (`POST /api/projects/:id/docs/:docId/cancel`). Regenerate it; the second attempt lists the sections it reused (#857).
  - **Regenerate** only works on a failed, cancelled, or degraded-with-no-version document; on a ready one it is refused. Test cancel and resume on a new document, never on the BRD.
  - **Fetch the BRD's exports by URL, never by clicking Download** (a download crashes the Playwright page). From the signed-in page, fetch `GET /api/projects/:projectId/docs/:docId/export` with `?format=docx`, `?format=pdf` and `?format=markdown` (`credentials: 'include'`), and save each file into the wave's evidence folder (return the body base64-encoded through `browser_evaluate`'s `filename`, then `base64 -d` it; Playwright writes only under the repo). Then open each: the `.docx` with `unzip -p brd.docx word/document.xml` (or `textutil -convert txt`), the `.pdf` with `pdftotext brd.pdf -` (or `mdls`/Preview if `pdftotext` is missing). Record each file's status, `Content-Type`, size and first bytes (`%PDF-` for the PDF, `PK` for the Word file).
- **Works:**
  - Statuses move `pending → generating → ready`, or `degraded` with warnings shown; never stuck in `generating` (statuses per `server/prisma/schema.prisma`: `pending|generating|ready|degraded|failed`).
  - Phase-1 progress renders.
  - Each export answers 200 with its own content type. The Word and PDF files open, carry the document's title and its top-level headings in the same order as the markdown export, and are not empty or cut short (the last heading of the markdown is in both).
  - No section exceeds `DOCS_GEN_SECTION_MAX_CHARS` (60,000) and no body exceeds `DOCS_GEN_DOCUMENT_MAX_CHARS` (250,000); text is never cut mid-sentence (#741). A cancelled document leaves `generating` within a minute and keeps its finished sections.
  - The database document's model calls appear in the ledger under `docs-gen` (#858).
- **Useful:**
  - The BRD explains feed refresh scheduling (round_robin vs entry_frequency), retention (`CLEANUP_ARCHIVE_READ_DAYS`) and the integrations.
  - The architecture doc names the storage/api/ui/worker split.
  - The DB doc's schema graph shows the `entries → feeds → users` foreign keys.
  - Provenance links resolve to real lines.
  - **Baseline:** run 4's full-scope BRD cost **$1.91, took 30 min and was 171 KB** under a 500¢ `DOCS_GEN_MAX_RUN_COST_CENTS`. Run 3's was $8.73, 2 h 51 min and 2.19 MB.
  - **Scored:** both documents scored against the answer key below (#1041), and the BRD also against the sign-off rubric after it (#1175). Score the markdown export; the Word and PDF files are checked for being the same document, not scored again.

#### Phase 9 — doc-quality answer key and rubric (#1041)

The caps above measure how **big** a document is; this key measures how **good** it is. Score the
exported BRD (scope `full`) and architecture document (scope `repository`) against the two tables
below, with the rubric that follows, and report the numbers in the fixed block from
`briefs/wave-c.md`. Every ground-truth cite is a `file:line` in `miniflux/v2` at **`v2.3.3`** =
`c4d54f87a81b30aa173fddf05d7ff83ae7da5796`, read from the source at that commit (not from an
earlier run's output). Open the cited line before scoring a fact you are unsure of.

**Baseline (run 6):** the full-scope BRD was **188,654 characters** and listed **108 topics** as
dropped (#995, reopened); the architecture document (by repository) dropped its **"Technology
Stack"** section, along with three data-architecture topics, at a stated limit of about 60k. Doc
quality had never been scored before this key, so the next run is the first scored one.

**BRD answer key (scope `full`)**: business rules, workflows and data entities.

| Id | The document must say | Ground truth at `v2.3.3` |
|---|---|---|
| BRD-1 | Feed refresh has two schedulers, chosen by `POLLING_SCHEDULER`: `round_robin` (the default) and `entry_frequency`. | `internal/config/options.go:511-518` |
| BRD-2 | Under `entry_frequency`, a feed's interval is one week divided by its weekly entry count (times `SCHEDULER_ENTRY_FREQUENCY_FACTOR`), clamped between a minimum (5 min) and a maximum (24 h); a feed with no entries that week waits the maximum. A feed's own TTL, `Retry-After` or cache headers can lengthen the interval. | `internal/model/feed.go:123-150`; `internal/config/options.go:540`, `:548` |
| BRD-3 | Every `POLLING_FREQUENCY` (60 min) the scheduler takes a batch of up to `BATCH_SIZE` (100) enabled feeds whose next check is due and refreshes them. | `internal/cli/scheduler.go:33-48`; `internal/config/options.go:108`, `:487` |
| BRD-4 | A feed stops being polled once its parsing-error count reaches `POLLING_PARSING_ERROR_LIMIT` (default 3). | `internal/config/options.go:503-505`; `internal/storage/batch.go:48-53` |
| BRD-5 | Cleanup retention: **read** entries are archived after **60 days** (`CLEANUP_ARCHIVE_READ_DAYS`), **unread** entries after **180 days** (`CLEANUP_ARCHIVE_UNREAD_DAYS`). | `internal/config/options.go:134`, `:139`; `internal/cli/cleanup_tasks.go:26`, `:39` |
| BRD-6 | **Starred** entries are never archived (nor are shared ones). | `internal/storage/entry.go:379` (`starred is false`), `:380` (`share_code=''`) |
| BRD-7 | Archiving deletes the entry and records a tombstone, so the same item is not imported again on the next refresh. | `internal/storage/entry.go:367`, `:391`; skipped on insert at `:119-121` |
| BRD-8 | Third-party integrations are per user, under `internal/integration/` (29 service packages): the **Save** action sends one entry to read-later and bookmarking services (Wallabag, Readwise, Pinboard and others). | `internal/integration/integration.go:40-41` |
| BRD-9 | New entries found by a refresh are pushed to the user's notification integrations (Matrix, webhook, ntfy, Apprise, Discord, Slack and others). | `internal/integration/integration.go:511`; called at `internal/reader/handler/handler.go:338-339` |
| BRD-10 | A password must be at least 6 characters. | `internal/validator/user.go:163-164` |
| BRD-11 | An entry's status is `unread` (the default) or `read`; no other status is accepted. | `internal/model/entry.go:12-13`; `internal/validator/entry.go:42-48`; default at `internal/database/migrations.go:86` |
| BRD-12 | A user cannot subscribe to the same feed URL twice, and a feed's category must belong to the same user. | `internal/validator/feed.go:23`, `:27`; `internal/database/migrations.go:69` |
| BRD-13 | Category titles are unique per user. | `internal/database/migrations.go:52` |
| BRD-14 | Data model: users own categories, feeds and entries; a feed belongs to one category; an entry belongs to one feed and is unique per feed by content hash; deleting a user deletes everything they own. | `internal/database/migrations.go:23-91` (foreign keys at `:53`, `:70-71`, `:88-90`) |
| BRD-15 | Per-feed and per-user block and keep rules filter entries out during processing. | `internal/reader/processor/processor.go:75`; `internal/reader/filter/filter.go:101` |

**Architecture answer key (scope `repository`)**: components, data flow, integrations and stack.

| Id | The document must say | Ground truth at `v2.3.3` |
|---|---|---|
| ARCH-1 | Technology stack: a single Go binary (Go 1.26); `main` only calls `cli.Parse()`. | `go.mod:6`; `main.go:11` |
| ARCH-2 | Technology stack: PostgreSQL is the only database, through `database/sql` and `lib/pq`. | `internal/database/postgresql.go:15`; `go.mod:13` |
| ARCH-3 | `internal/cli` is the entry point: it opens the connection pool, runs or checks migrations, builds the storage layer and starts the daemon. | `internal/cli/cli.go:40`, `:157`, `:168`, `:175`, `:222`, `:248` |
| ARCH-4 | `daemon.go` creates the worker pool, starts the scheduler (unless disabled or in maintenance mode) and starts the HTTP server. | `internal/cli/daemon.go:33`, `:35-36`, `:41-42` |
| ARCH-5 | `scheduler.go` runs two loops: the feed scheduler and the cleanup scheduler, which calls `runCleanupTasks` in `cleanup_tasks.go`. | `internal/cli/scheduler.go:15-31`, `:53-56`; `internal/cli/cleanup_tasks.go:16` |
| ARCH-6 | `internal/storage` is the data-access layer: one `Storage` over `*sql.DB` with hand-written SQL. | `internal/storage/storage.go:13`, `:18` |
| ARCH-7 | `internal/database` owns the connection pool and the schema migrations (an ordered list of Go functions). | `internal/database/postgresql.go:14`; `internal/database/migrations.go:16`; `internal/database/database.go:13` |
| ARCH-8 | `internal/ui` is the server-rendered web UI, mounted as the catch-all route. | `internal/ui/ui.go:17`; `internal/http/server/routes.go:46` |
| ARCH-9 | `internal/api` is the REST API, mounted under the v1 prefix only when the API is enabled. | `internal/api/api.go:20`; `internal/http/server/routes.go:36-38` |
| ARCH-10 | `internal/fever` and `internal/googlereader` are compatibility APIs for third-party reader apps. | `internal/http/server/routes.go:27-28`, `:31-33` |
| ARCH-11 | `internal/worker` is a pool of `WORKER_POOL_SIZE` (16) goroutines fed from a queue; each job refreshes one feed. | `internal/worker/pool.go:23`, `:42`; `internal/worker/worker.go:47`; `internal/config/options.go:600` |
| ARCH-12 | `internal/reader/fetcher` makes the HTTP request for a feed. | `internal/reader/fetcher/request_builder.go:49`, `:152`; used at `internal/reader/handler/handler.go:224`, `:243` |
| ARCH-13 | `internal/reader/parser` detects and parses the feed format (RSS, Atom, RDF, JSON) and `internal/reader/processor` filters and transforms the entries before they are stored. | `internal/reader/parser/parser.go:20`; `internal/reader/processor/processor.go:27` |
| ARCH-14 | Data flow: scheduler → worker pool → `handler.RefreshFeed` → fetcher → parser → processor → storage (`RefreshFeedEntries`, then `UpdateFeed`). | `internal/cli/scheduler.go:36-48`; `internal/worker/worker.go:47`; `internal/reader/handler/handler.go:196`, `:243`, `:287`, `:319`, `:325`, `:367`; `internal/storage/entry.go:320` |
| ARCH-15 | Integrations (`internal/integration`) are called from the refresh path for new entries and from the Save action. | `internal/reader/handler/handler.go:339`; `internal/integration/integration.go:41`, `:511` |

**Scoring rubric.** Score each document on four measures. Two scorers following these rules
should reach the same numbers; where you hesitate, open the cited line and apply the rule.

- **Coverage** = key facts **present** / key facts in the key (for example 11/15).
- **Accuracy** = key facts stated **correctly** / key facts **present**. A present fact is stated
  either correctly or wrongly, so accuracy's denominator always equals coverage's numerator
  (`run.json` rejects a `docQuality` entry where they differ).
- **Hallucinations** = the number of **concrete claims** outside the key (a named function,
  file, package, config option, default value, table or column) that have no support at
  `v2.3.3`. List each one with the sentence it came from.
- **Usefulness per section**: one grade per top-level section of the document.
  **A** a new team member could act on it (specific, correct, points at code or settings);
  **B** right but thin; **C** generic or vague (could describe any feed reader);
  **F** wrong or misleading. Report the count of each grade.

What counts:

- **Present** means stated **in substance**, anywhere in the document, not keyword-matched. A
  keyword with no claim behind it is not present; the right claim in other words is.
  *Worked example (BRD-1):* "Miniflux can either check every feed on a fixed cycle or check busy
  feeds more often than quiet ones, configured by `POLLING_SCHEDULER`" is **present**, although
  it never says `entry_frequency`. A configuration table that lists `POLLING_SCHEDULER` with the
  description "the polling scheduler" is **not present**: it names the option and says nothing
  about the two modes.
- **Correct** means it agrees with the cited lines on every detail it states. "Read entries are
  removed after 90 days" makes BRD-5 present but **wrong** (the default is 60). A wrong key fact
  counts against accuracy only; do not also count it as a hallucination.
- **Hallucination** means a concrete claim with nothing at `v2.3.3` to support it; search the
  source at the tag before counting one. *Worked example:* "retention is controlled by
  `CLEANUP_ARCHIVE_DAYS`" is **one hallucination**: no option of that name exists at `v2.3.3`
  (the real ones are `CLEANUP_ARCHIVE_READ_DAYS` and `CLEANUP_ARCHIVE_UNREAD_DAYS`). So is
  "entries can be set to `removed`": that status was retired into `entry_tombstones`
  (`internal/database/migrations.go:1472-1493`) and the validator rejects it
  (`internal/validator/entry.go:42-48`). A vague claim with nothing concrete in it ("Miniflux
  uses caching to improve performance") is not a hallucination; it lowers the section's grade.
- Count each distinct hallucination once, however often it repeats.

#### Phase 9 — BRD sign-off rubric (#1175)

The answer key measures whether the facts are right; this rubric measures whether a
stakeholder could read the BRD and sign it off. Score the exported BRD of scope `full` here,
and the requirements-scoped BRD of J1.7 with the J1.7 readings in the table. Each check is
**pass**, **weak** or **fail**; the document passes sign-off only when all four pass. The ids
are `SO1`–`SO4` ("sign-off"): `S1`… are Spec Kit ids in Phase 14, and `R1.`… are requirement
headings in a requirements-scoped BRD.

Run the commands below from the directory holding the export, saved as `brd.md`. They are
outside the table on purpose: copy them as they are written here.

```bash
# The main part: from the start of the document to the appendix heading (characters, not bytes).
awk '/^# Appendix: Module-by-Module Detail/{exit} {print}' brd.md | LC_ALL=en_US.UTF-8 wc -m

# The whole body: everything before the first footnote definition.
awk '/^\[\^src-[0-9]+\]:/{exit} {print}' brd.md | LC_ALL=en_US.UTF-8 wc -m

# SO1: the approved requirements listed (#1218), or else the reconstructed ones and their lead-in.
grep -cE '^### R[0-9]+\. ' brd.md
grep -c 'approved requirements are listed here' brd.md
grep -cE '^### RC-[0-9]+:' brd.md
grep -c 'Reconstructed from the code.' brd.md

# SO2: raw markers and citation tokens. Must print nothing.
grep -nE '\[(facts|rag|web):|<!--|\{\{|metis-source' brd.md
```

**SO3 pre-check (#1223).** METIS counts the code names in each main section it wrote. The
version's **Provenance** panel shows the count (per section) and the flagged sections with examples
(`GET /api/projects/:projectId/docs/:docId/versions/:versionId/provenance/summary`,
`data.codeIdentifiers`). Start the SO3 list from it, then read the main part for what the
check misses (an unquoted dotted name such as `feeds.disabled` is a known blind spot; names that
start or end in an acronym, such as `MinifluxSessionID`, are counted since #1223). The
check is a heuristic and the score is still yours: confirm each flagged name before counting it.

| Id | Check | Pass | Weak | Fail |
|---|---|---|---|---|
| SO1 | Every requirement is present, with acceptance criteria | Scope `full`, project **with approved requirements** (#1218; Phase 8 approved some): the main part has the **Approved Requirements** section and no `RC-n`. Its `R<n>.` entries match, one for one, the approved requirements of the run the Requirements hub opens on (#1230: the newest completed run with any requirements, approved or not; its label shows its approved count): the same ids (`**Requirement id:**`), titles, descriptions and acceptance criteria as stored, the analyst's edits included, nothing reworded; when the note "`k of N` approved requirements are listed here" is present, `N` is that run's approved count and the `k` listed are whole. Report `matching/listed` and `N`. Project **with none approved**: the main part has the **Requirements Reconstructed from the Code** section, opening with METIS's fixed "Reconstructed from the code" lead-in. Every `RC-n` in it has at least two acceptance criteria a tester could check (a concrete value or an observable outcome), and is traceable to the Miniflux source at `v2.3.3`, read as the answer key reads a fact. Report `with criteria / RC-n listed` and, as coverage, how many of the answer key's BRD-1 to BRD-15 appear as an `RC-n` or a Key Business Rule (`k/15`). J1.7: exactly J1.2's five requirements, each with the criteria J1.4 left it with (`n/5`) | Every `RC-n` traceable, but some have one criterion, or criteria nobody could test ("works correctly") | With approved requirements: an `RC-n` section instead of them, an entry whose text differs from the stored requirement, or one cut short. Without: the lead-in is missing, a requirement has no criteria, there is no requirements section, or an `RC-n` is not traceable to the source (also count it as a hallucination) |
| SO2 | No raw marker or citation token | The SO2 command prints nothing. Footnote references (`[^src-3]`) and `_(inferred)_` are deliberate and do not count | – | Any match: list each with its line |
| SO3 | Readable by someone who does not know the code | The Executive Summary and Scope name no function, file, package, table or SQL; the rest of the main part names code only where a reader acts on it (a setting an administrator changes, a status a user sees). Code names inside **Approved Requirements** are the analysts' own stored text (#1218), copied verbatim: they are exempt and not counted (#1230). J1.7: the whole document | Up to five other code names in the main part: list them | More than five, or the Executive Summary needs the code to be understood |
| SO4 | A sensible length | The main part is 40,000–60,000 characters (about 12–18 pages), and the whole body is at most `DOCS_GEN_DOCUMENT_MAX_CHARS` (250,000) plus the header, under 1,000. J1.7: the whole body within the cap; a five-requirement document has no floor | The main part is under 40,000 characters | No main part (the catalogue layout), or a main part over 60,000 |

Report one line under the doc-quality lines, for example
`Sign-off — BRD: SO1 pass (22/22 with criteria, 11/15 key facts) · SO2 pass · SO3 weak (3 code names) · SO4 pass (52,310 main / 231,004 body)`,
and copy it into the results table's sign-off row. Read a requirement as present in
substance, as for the answer key.

### Phase 10 — Chat with citations
- **Steps:**
  1. In `/chat`, pick the project scope (`components/chat/project-scope-selector`) and ask the BA questions below (`POST /api/ai/stream`, sessions via `/api/ai/sessions`).
  2. Also try `/workbench`.
  3. Resume, fork and compact a session (`/api/ai/sessions/:id/resume|fork|compact`), and check `/sessions`: each row names its session after the first question and shows its project (linked) and last activity (#738). `GET /api/ai/sessions` with no filter lists your own sessions, newest first, with `page.hasMore` (`?limit=&offset=`); another user's sessions never appear.
  4. In one project-scoped session, ask BA question 1, then follow up with `Show me the exact lines for the first citation`.
- **Works:** answers stream, tool activity renders, there is no scope-degradation notice (unless retrieval is genuinely empty), and fork and compact keep the history.
- **Useful:** each BA answer carries **at least one correct `file:line` citation** into `v2.3.3`. Example: "What's the minimum password length?" → `internal/validator/user.go:163-164` (`len(password) < 6`). The follow-up keeps the earlier verified `file:line` and does not say it "had not actually read" the file (#773).

### Phase 11 — Discussions, presence, comments and mentions
- **Steps:**
  1. In `/projects/:id/discussions`, create a thread (`POST /api/discussions/threads`), post a message that mentions a second user, and ask for an AI reply (`POST …/threads/:id/ai-respond`).
  2. Open `/projects/:id/discussions/:discussionId` as a second user too, to check presence. **[2nd user]**: operator-run or operator-approved ("Second-user steps"), or verify presence from the database and say so. J1.4b and J1.4c repeat the two-user checks on the analyst's own project, so a run short of time may record this phase's second-user steps as covered there.
  3. Comment on a requirement and reply to it (`POST /api/requirements/:reqId/comments`, then `POST /api/comments/:threadId/replies`).
  4. Edit, then delete, one of your own discussion messages (`PATCH` / `DELETE /api/discussions/threads/:id/messages/:messageId`, #734) while the second context has the thread open. As the second user, look for **Edit** and **Delete** on that message (a UI check; never call the API as them).
- **Works:**
  - Both users see each other's presence avatars (`components/presence/PresenceAvatars`).
  - The @mention picker offers only users who can open the project (#870).
  - The mentioned user gets a notification (`/api/notifications`) that names the author and opens the comment (#735).
  - Edit and delete work for requirement comments and for discussion messages. A discussion edit is marked "(edited)" and appears live in the other context, and a deletion disappears there live. The second user sees no **Edit** or **Delete** on the first user's message (#734; the server's 403 for that call is covered by `server/src/routes/discussions.multi-member.test.ts`).
  - A teammate's live discussion message shows their display name, not a raw user id (#734).
- **Useful:** the AI reply cites project sources and answers the thread's question about Miniflux.

### Phase 12 — Publishing (issues, PRs, batches) — sandbox only
- **Steps:**
  1. Point the publish destination at the sandbox repo (`PATCH /api/projects/:id/publish-destination`).
  2. In `/projects/:id/publish`, generate drafts (`POST …/publishing/drafts/generate`) and review the draft diff. Drafts from an import of more than 25 requirements open the requirement picker (`draft-requirement-picker`); pick 3.
  3. Preview a batch with **dry-run** (`POST …/publishing/batches/preview`). **Do not publish it**: J1.8 publishes 2 issues, the whole sandbox cap (run 10), so Phase 12 dry-runs only and the after-publish checks (#863, #1106, #1311) read `not-exercised` unless the operator gives this phase a slot. Archive a settled batch from its row (`archive-batch-<id>`) with a reason, leaving **Also close the issues** unticked, when one exists.
  4. Do **not** publish a finding (`POST …/findings/:fid/publish`): **finding-publish has no dry run**, it publishes at once and would take one of J1.8's two slots.
  5. Check the review gate (`/api/projects/:id/review-gate`) and `/reviews`.
- **Works:**
  - The dry-run plan lists exact targets, issue actions before label upserts, and its "not shown" line matches the rows left out (#1064).
  - A feature draft has a **Related code** section and no project, analysis or requirement id in its visible body (#1064).
  - After a batch publishes, its draft is no longer selected and the next preview does not fail with `DRAFT_INELIGIBLE` (#863).
  - No draft title reads `[Feature] [Feature]: …`.
  - Nothing is created in `miniflux/v2`. Verify with `gh issue list -R miniflux/v2 --author @me`.
  - Sandbox issues exist and their links resolve.
- **Useful:** a published issue body has a clear title, the affected files and acceptance criteria that a developer could act on without opening METIS. Drafts from an import carry the source issue's acceptance criteria when it has an "Acceptance criteria" heading. No Miniflux issue has one (0 of 266 in run 8), so judge this on an import that does, or record n/a.

### Phase 13 — Drift, scheduler and tasks
Run this phase only after Phase 9's documents finish: a repo refresh during docs generation fails the document at commit (#856).
- **Steps:**
  0. **Read the lineage edge count first** (`GET /api/projects/:id/sql-lineage`). The scheduled refresh on an unchanged commit raised reads from 740 to 785 in run 8 (also run 7, listed on #1066), so expect a count taken before and after Phase 13 to differ. Whether that is intended is still open on #1066: record both counts there, not as a new finding. Run 8's end-of-run query gives 785 reads, 361 writes and 108 persists-to; waves A and B reported 740.
  1. Open `/projects/:id/sync` (`GET /api/sync/drift`, `…/drift/count`, `…/drift/:id/resolve`).
  2. In `/scheduler`, list the handlers (`GET /api/scheduler/handlers`) and create a job of type `refresh-repo-connector` on a cron schedule. Pause, resume and view its history.
  3. In `/tasks`, cancel and retry a task.
  4. Open `/runs` and `/runs/:id`.
- **Works:**
  - The handlers include `refresh-repo-connector`, `refresh-db-connector-schema`, `rerun-analysis`, `regenerate-generated-document`, `publish-batch` and `http-webhook`.
  - The job fires on schedule.
  - Retry produces a new attempt.
- **Useful:** drift is empty or explained. After a manual `refresh-ingest` (`POST /api/projects/:id/connectors/repos/:repoId/refresh-ingest`) on an unchanged commit, the drift view reports no false drift, the code graph keeps its ID, and the repo connector's source-document count equals Phase 3's (#756, #856).

### Phase 14 — Spec Kit (see dedicated section below)

### Phase 15 — PR reviews and change analysis
- **Steps 1–2 run on a sandbox project, never the main one.** `/projects/:id/pulls` lists only reviews that the `pull_request` webhook created, and `miniflux/v2` must never be wired to a webhook. Use a sandbox project whose repo connector is `openzigs/flux-v2`, and switch on **Automatic PR review** in its Project settings first (#1169; `PATCH /api/projects/:id { "autoReviewPrs": true }`) — with it off, `/projects/:id/pulls` says review is off and a delivery makes no review. On the sandbox connector's card in **Connections**, click **Create webhook secret** (`POST /api/projects/:id/connectors/repos/:repoId/webhook-secret`, #1475), and set the GitHub webhook's Payload URL to the server's public address plus the path shown (`/api/webhooks/github/pr/c/<connector id>`) and its Secret to the value shown: the delivery then reaches the sandbox project only. With the shared `GITHUB_WEBHOOK_SECRET` on `/api/webhooks/github/pr` instead, the connector must be **Test**ed (status *connected*), and the delivery goes to the project whose connection to `openzigs/flux-v2` is earliest (`pr_review.webhook_owner_ambiguous` in the server log names the others). Open a sandbox PR so the webhook creates the review. Switch it off again and **delete that connector before wave F**, or J1.8's publish fails with `REPO_CROSS_PROJECT` (#1171).
- **Steps:**
  1. *(Sandbox project, as a coordinator of the sandbox project's workspace. Since #1472 every role reads PR reviews, and a coordinator can also re-run them in step 2. A developer or reader sees the page without the **Re-run review** button.)* In `/projects/:id/pulls`, find the sandbox PR's row (`GET /api/projects/:id/pr-reviews`): the review job writes it for every review and every skip (#1470). Read its **Status** (Reviewed, or Not reviewed with the reason) and, once reviewed, follow **Review on GitHub**. Then click **Details** to open `/projects/:id/pulls/:prNumber` (`GET /api/projects/:id/pr-reviews/:prNumber`). The review uses the sandbox project's AI model and its repo connector's vault token (#1471), so give the `openzigs/flux-v2` connector a token that can read pull requests and post reviews before opening the PR. A row reading "This project has no AI model or GitHub token the review can use" (`lastSkipReason: review_not_configured`) means one of the two is missing: fix it and open or push to the PR again. The review's spend appears in Project settings' **this month** figure for automatic reviews (`GET /api/projects/:id/pr-review-budget`). With a monthly limit set, the project's AI model must have a price: a row reading "This project’s AI model has no price" (`lastSkipReason: budget_unpriced`) means set its price in `MODEL_PRICES` or remove the limit.
  2. *(Sandbox project.)* Click **Re-run review** on the detail page (`POST /api/projects/:id/pr-reviews/:prNumber/re-review`). The re-run reads the PR from GitHub first: its row's **SHA** is the PR's current head, and a PR that links an issue is not recorded as "does not link an issue" (#1471). Do not post the review to GitHub.
  3. On the main project, in `/projects/:id/changes`, run a change analysis (`POST /api/projects/:id/change-analyses`).
- **Works:** the review renders inline comments in METIS only, and the change analysis completes. Steps 1–2 need a public webhook; record them as blocked without one (runs 3, 4 and 9 were also blocked by #1169, now fixed).
- **Useful:** at least one review comment points at a real changed line and makes a substantive point, such as a missing test, an SQL error-handling gap or a migration ordering issue.

### Phase 16 — Impact analysis
- **Steps:** in `/impact-analyses/new`, run an impact analysis for each developer task below (`POST /api/impact-analyses`). Then open `/impact-analyses/:id`, rerun it (`…/rerun`), view drift (`…/drift`) and export (`…/export.md`). Do not run `publish/jira`. Impact analyses have no draft path, so there is nothing to dry-run.
- **Works:** the requirement impact matrix, the shared-table impact section and the drift section all render, and the export downloads. A stage degraded for want of structured output or tool calls is a finding (#754). Open the collapsed **Blast radius** group (`blast-radius-toggle`) before screenshotting the "Writes affected data" rows.
- **Useful:** see the developer tasks for the expected files, tables and columns. Impact on #4478 names Go callers reached through a receiver or field (for example `h.store.UpdateFeed(...)`) as probable call sites with `file:line`, not only tests (#774).

### Phase 17 — "Tested by" in traceability
Replaces the Test Coverage page, whose imports and runs were removed in #818 and #819 (epic #812, [ADR 0019](../decisions/0019-replace-test-coverage-with-tested-by.md)).
- **Steps:**
  1. Open the completed analysis's **Requirements** tab and pick the requirement **by rule, not by name**: the analysis's names change from run to run (run 9 had none of the ones earlier runs named). Prefer "password ≥ 6 chars" if present; otherwise take the first requirement whose mapped code is in `internal/validator/` and whose package has a `_test.go` file; otherwise the first with any mapped code in a package that has tests. Record which requirement was used and why. Expand it and read its **Tested by** section. For the #1071 check (Tested by through a bound Go method call), use the LinkTaco API-token requirement if present; otherwise apply the same rule, restricted to requirements whose **Tested by** names a test that reaches the mapped code through a method call, and check that call in the source. To check through the API, use `GET /api/projects/:projectId/requirements/:requirementId/traceability`, field `testedBy`.
  2. Open the analysis's **Traceability** tab. Read the matrix's **Tests** column and the **Untested requirements** list below it (`GET /api/projects/:projectId/traceability/test-gaps?analysisId=:id`).
  3. Open the workspace traceability rollup and read the project's **Tested** column. Hover it to see the strict figure.
- **Works:** the Tested by section, the untested list and the Tested column render, and no model call is made (the ledger delta for this phase is 0).
- **Useful:** "password ≥ 6 chars" lists `internal/validator/user_test.go` › `TestValidatePassword` under **Tested by**, with its relation label. Requirements that have mapped code but no test (for example OIDC role mapping) appear in the untested list. Requirements with no mapped code are counted as "no code mapped", not as untested. No test is listed only because it reaches a config hub, or only for its licence header (#860).

### Phase 18 — Usage and cost
- **Steps:**
  1. Open `/projects/:id/usage`. It redirects to `/settings/usage?scope=project&projectId=:id` (`ui/src/lib/legacy-routes.ts:40-42`); check the redirect lands there with the project selected.
  2. Check `GET /api/projects/:id/usage`, `GET /api/projects/:id/usage-summary` and `GET /api/projects/:id/token-breakdown`, and download the CSV (`…/usage/csv`).
  3. Open `/workspaces/:id/finops` → `/api/workspaces/:wid/finops/budget|rules|events|usage-totals`.
  4. Compare the Usage page, its **All projects** view and `GET /api/admin/usage` with the ledger queries in the skill.
  5. On the analysis page, read the header's **This project, this month** card and, during a run, the run header's tokens and cost. While the run is going, check that the header's figures move and that the run's row in **Past runs** never reads `0 tok` (`in progress` before its first model call). The header re-reads every 2.5 seconds, but **Past runs** refreshes only when the run reaches a terminal status or the page is reloaded, so do not compare the two mid-run without reloading: a difference then is staleness, not a finding. Once the run has finished, check that its row in **Past runs** shows the same two token figures as the header ("… tok without cache · … with cache"). Then open `/runs`: the run's **Tokens (usage ledger)** cell shows those same two figures, and its **Cost (as recorded)** cell the header's cost. A chat turn is not a run and is not in the runs table; read its tokens and cost in the **Chat turns** table below it (`GET /api/runs/chat-turns`, #1007), filtering by Session ID to find one turn. That table lists only the chat sessions of the signed-in user, so read it as the user who chatted. A turn's row is the chat model's calls; for a turn that used a sub-agent or apply-diff, read the session's row in **Session totals** for the rest.
- **Works:**
  - Usage rows exist for every phase.
  - **No Unpriced card** once `MODEL_PRICES` is set.
  - The CSV has a cost for each row, and an `agentStep` column. A day row that spans several steps reads `(mixed)`, not `analysis` (#977).
  - All three views agree with `token_usages` (#854), and the ledger cost with the token-computed cost (#761).
  - The Workspace scope shows month-to-date tokens and cost (`usage-totals`). The analysis header shows the project's own budget, with the deployment-wide cap labelled as such. A running analysis's token count moves, and a sub-cent chat turn in the **Chat turns** table on `/runs` shows its exact cost rather than "—" or $0.0100 (#977, #1007).
  - A run's tokens are the same two figures on the analysis header, in **Past runs**, on `/runs` and on `/runs/:id`, and both equal the ledger: without cache is `SUM("inputTokens" + "outputTokens")` over the run's `token_usages` rows (for a provider other than `anthropic`, less `"cacheReadTokens"`), and with cache adds the cache reads and writes (#1007).
- **Useful:** token totals per phase reconcile within ±10% with the per-phase numbers recorded in the evidence table.

### Phase 19 — Settings: AI config, vault, skills, agents, MCP
- **Steps:**
  1. `/settings/api-keys`: view and edit `MODEL_PRICES` (`/api/admin/config`) and check the audit trail (`/api/admin/config/audit`).
  2. `/vault`: create, rotate, reveal (and confirm it is audited), view the audit, and delete a test secret (`/api/vault`).
  3. `/library?tab=skills`: browse, enable, disable, diff versions (`/api/skills`, `/api/projects/:id/library/skills`). A skill's **Versions** dialog shows a `+`/`-` diff (#797).
  4. `/library?tab=agents`, via `/api/agents`.
  5. `/settings/mcp`: add, test, start and stop a server, and list its tools (`/api/mcp`, `/api/mcp/servers/:id/tools`). **Test** shows its result under the row, and the row updates after Start or Stop with no reload.
  6. Also visit `/settings/hooks`, `/settings/triggers`, `/settings/acp`, `/settings/integrations` (Slack/Teams/PagerDuty: "not configured" is acceptable), `/settings/notifications` and `/projects/:id/plugins`.
- **Works:** every page loads without console errors, and each mutation round-trips.
- **Useful:** a skill enabled here appears in chat's loaded-skills panel (`components/chat/loaded-skills-panel`). Disable test skills before the BA re-ask.

### Phase 20 — Admin
- **Steps:**
  1. Visit `/admin`. It must redirect to `/settings` (`ui/src/lib/legacy-routes.ts`).
  2. Visit `/settings/workspaces`, `/settings/workspaces/:id`, `/settings/auth`, `/settings/embeddings` and `/settings/audit`, plus `/eval/leaderboard` and `/products`.
  3. On a product with two repos: `GET /api/products/:id` returns `edges` and `resources` (#1618: an edge made before then reads `origin: detected` with `strength` null), and `POST /api/products/:id/edges` with an unknown `strength` answers 400.
  4. Check the admin APIs: `/api/admin/usage`, `/api/admin/token-budgets/:userId`, `/api/admin/cache-telemetry`, `/api/admin/auth/providers` and `GET /api/admin/auth/saml/group-overage` (#1552: `total` 0 and no warning on the SAML 2.0 tab unless a SAML sign-in arrived with a group overage).
  5. Sign out from the account menu.
- **Works:** every legacy `/admin/*` URL redirects (`legacy-routes.ts`), and the admin pages load for an admin while showing 403 for a non-admin. Signing out lands on the plain sign-in page, not `/login?reason=expired` (#720). `/settings/auth` loads with no console error.
- **Useful:** cache telemetry shows DeepSeek cache reads, if DeepSeek reports them (#796).

## Spec Kit (Phase 14, in full)

**Type the leading slash.** This plan writes Spec Kit commands without one (`speckit.specify`) so the drift check does not read them as pages, but the command palette requires it: type `/speckit.specify`, `/speckit.plan` and so on. Where a step says to run `speckit.<name>`, that means `/speckit.<name>` in the palette. The API paths are unaffected. <!-- drift-check: skip -->

**Smoke set (#1177): S2, S4, S6, S7 and S21**, in that order: enable, specify, plan, tasks and
issue export (dry run, then publish within the cap). Wave D runs these on every run. Every other
row below is marked *(optional)* and keeps its pass bar: run it when a fix in wave D's list names
it, or on a full pass the operator asks for; otherwise record it `skipped (optional)`. The notes
below about S3b, S6b to S6d and S9 apply only when those steps run.

**S6 then S6b changes the design**, so save `plan.md` and `tasks.md` only after S6b to S6d, and run `speckit.analyze` and the handoff after them. Budget 45 minutes for S9 when #1062 is exercised (run 8: 20 minutes and $0.35, and one Continue added 23 minutes and $0.41). In S3b, `developer` is a member from setup (Setup order 3): log out and in as `developer`.

**Sources:**
- API: `server/src/routes/spec-kit.ts`, mounted at `/api/projects/:projectId/spec-kit`.
- Library: `server/src/lib/spec-kit/**`.
- UI: `ui/src/app/(authed)/projects/[id]/spec-kit/page.tsx` (`/projects/:id/spec-kit`).
- Shared types: `packages/shared/src/spec-kit.ts`.

**Artifacts (`SPEC_KIT_ARTIFACT_NAMES`):** `spec.md`, `plan.md`, `tasks.md`, `constitution.md`, `clarify.md`, `analysis.md`.

**Legacy commands (`SPEC_KIT_COMMANDS`):** `specify`, `plan`, `tasks`, `clarify`, `analyze`, `implement`. Still accepted by the API with a `Deprecation` header; the palette maps a typed legacy name to its `speckit.*` successor.

**Namespaced commands (`SPECKIT_COMMANDS`, the palette's commands since #931):** `speckit.constitution`, `speckit.specify`, `speckit.clarify`, `speckit.plan`, `speckit.checklist`, `speckit.tasks`, `speckit.analyze`, `speckit.implement`, `speckit.taskstoissues`.

**Drive the UI first.** Since #931 the Spec Kit page has a **Features** panel, a `speckit.*` command palette that runs on the selected feature, **Generate checklists**, issue export after a dry run, artifact **Delete** and **Start analysis** after `speckit.implement`. Chat no longer runs or suggests Spec Kit commands. Use in-page `fetch('/api/projects/:id/spec-kit/…', {credentials:'include', …})` **only** for the checks marked *API only*: each has no UI caller in `ui/src`, and anything else that needs `fetch` is a finding. `x-speckit-force: 1` (gate bypass) is a header, so it is *API only* too.

**Contracts worth knowing.** Feature slugs match `^\d{3}-…`. A feature-artifact `PUT` takes `{content}`. `tasksGate` needs both `spec.md` and `plan.md`.

Feature for this run: **"Mark all entries as read older than N days"** (Miniflux #4478).

| # | Step | Drive it with | Works | Useful |
|---|---|---|---|---|
| S1 | *(Optional)* **Disabled state** | UI: the page before enabling. *API only:* `POST …/commands/speckit.specify` | `spec-kit-disabled-banner` shows and the palette is disabled; the API call returns **409 `SPEC_KIT_DISABLED`** | — |
| S2 | **Enable toggle** | UI: `spec-kit-toggle` (`PUT …/enabled {enabled:true}`) | Persists across a reload; the onboarding card shows | — |
| S3 | *(Optional)* **Constitution** | UI: **Generate constitution.md** (`POST …/constitution`) | The success toast, not a warning; `constitution.md` v1 is selected in the viewer | **Grounded (#928):** principles name their sources (README, `go.mod`, contributing guide) and reflect Go stdlib-first, Postgres only, minimalism, no JS frameworks. A skeleton with a "nothing relevant ingested" warning is a FAIL, because Phase 3 ingested the README |
| S3b | *(Optional)* **Read-only for non-editors** | UI: open the page as `developer` in a second context. *API only:* `POST …/commands/speckit.constitution` as `developer`, then `admin` | Every write control is disabled with the tooltip "Requires project.update" (#931); the API returns **403** for `developer` and 200 for `admin`. `speckit.constitution.write` no longer exists (#928) | — |
| S4 | **Specify** | UI: select **Project**, run `speckit.specify mark all entries as read older than N days` | Creates a feature and its `spec.md`; the toast reads `Generated spec.md (vN) for <slug> in T tokens — grounded on …` with **K > 0**, and job progress streams | The spec mentions the existing `Storage.MarkAllAsReadBeforeDate` (`internal/storage/entry.go:523`) and the Google Reader path that already uses it (`internal/googlereader/handler.go:1225`). A spec that says **"ungrounded (no project knowledge retrieved)"** is a FAIL |
| S5 | *(Optional)* **Clarify** | UI: select the feature, run `speckit.clarify` | `clarify.md` appears under `specs/<slug>/` (`spec-kit-feature-tree`) | Its questions are real ambiguities: user-configurable N vs fixed presets, starred entries, per-feed/category scope, timezone |
| S6 | **Plan** | UI: `speckit.plan` | Writes 5 plan artifacts and says it is grounded, citing real `path:start-end` spans (#853); before `spec.md` exists there is a clear precondition error | It names `internal/api/entry_handlers.go`, `internal/ui/*` and `internal/storage/entry.go`, and states **no schema migration needed** |
| S7 | **Tasks** | UI: `speckit.tasks` | `tasks.md` is written; without `spec.md` and `plan.md` there is a precondition error | Tasks are ordered, testable and include Go tests |
| S6b | *(Optional)* **Background job: progress and reload** (#1059) | UI: run `speckit.plan` on the S4 feature again. While it runs: read the progress text, reload the page, open another page and come back | The progress bar names the command, the feature and the artifact being generated ("Generating research.md (2 of 5)"). After the reload and after coming back the progress is there again, with no second run. The result card and toast appear as in S6. **No "Internal Server Error", however long the plan takes** (record the duration; run 7 failed at 5.0 minutes) | — |
| S6c | *(Optional)* **Background job: cancel** (#1059) | UI: note the versions in the feature tree, run `speckit.plan`, press **Cancel** during the second or third artifact | The page says the command was cancelled. Every artifact keeps the version it had; no new artifact appears. The usage page shows the finished calls under `spec-kit.plan` and the cancelled one under `spec-kit.plan.aborted` | — |
| S6d | *(Optional)* **Background job: one command per feature** (#1059) | *API only:* `POST /api/projects/:id/spec-kit/commands/speckit.tasks/jobs` with `{featureSlug}` twice in a row, then `GET /api/projects/:id/spec-kit/jobs/:jobId` until it ends; `GET /api/projects/:id/spec-kit/jobs`; `POST /api/projects/:id/spec-kit/jobs/:jobId/cancel` on the finished job | The first answers **202** with a `jobId`, the second **409 `SPEC_KIT_JOB_RUNNING`** naming that job. Two `POST …/commands/speckit.specify/jobs` with different briefs and no `featureSlug`, sent together, both answer **202**, each with its own new `featureSlug`. The job ends `succeeded` with the same payload S7 returned. The list is empty afterwards. Cancelling a finished job returns it unchanged. `POST …/commands/speckit.implement/jobs` answers **400 `SPEC_KIT_COMMAND_NOT_A_JOB`** | — |
| S8 | *(Optional)* **Analyze** | UI: `speckit.analyze` | `analysis.md` is written | It flags any spec/plan/tasks inconsistency |
| S9 | *(Optional)* **Implement handoff** | UI: `speckit.implement`, then **Start analysis with these artifacts**, once | `tokensUsed: 0`; the **handoff** card lists the artifacts; a missing artifact gives `Cannot /implement: missing …`. Starting the analysis creates a new run (never the Phase 7 run): record its ID and cost, with test custom agents disabled first. On the analysis page the handoff notice lists the requirements sent from `spec.md` and, in a separate line, the plan components and tasks sent as context; no plan component or task appears among the run's requirements | The handoff reaches the analysis orchestrator (`orchestratorRoute: /api/projects/:id/analyses`) |
| S10 | *(Optional)* **Edit and save** | UI: **Edit** / **Save** / **Cancel** on `constitution.md` (project `.specify/` files only). *API only:* a body over 200,000 chars | The version increments; cancel changes nothing; the oversized body gets 400. Feature artifacts have no Edit button, by design | — |
| S11 | *(Optional)* **Delete** | UI: **Delete** `clarify.md` in the feature, confirm | It leaves the feature tree; the toast names the file | — |
| S12 | *(Optional)* **Comments and presence** | UI: **Comments** on `constitution.md` (`/api/projects/:id/spec-kit/artifacts/:artifactName/comments`), mention `coordinator`; presence in a second context | Comments and presence exist on project `.specify/` artifacts only. The mention notifies and opens the artifact's comments (#735) | — |
| S13 | *(Optional)* **Suggestions** | UI: type `/` in the palette; type `/` in `/chat` | The palette suggests the **nine `speckit.*` commands**, not the six legacy names. `/chat` suggests no Spec Kit command (#931) | — |
| S14 | *(Optional)* **Legacy alias deprecation** | *API only:* `POST …/commands/specify` | `Deprecation: true` and `Link: <…/commands/speckit.specify>; rel="successor-version"`. The palette maps a typed legacy name to `speckit.specify`, so the header is unreachable from the UI | — |
| S15 | *(Optional)* **Feature list** | UI (S4 created it) | `GET …/features` and the Features selector list the feature | — |
| S16 | *(Optional)* **Feature required** | UI: `speckit.plan` with **Project** selected. *API only:* the 400 | The page refuses before sending ("Select a feature first"); the API returns **400 `SPECKIT_FEATURE_REQUIRED`** without `featureSlug`, then 200 with it | It has the expanded plan sections |
| S17 | *(Optional)* **Feature artifacts** | UI: list and read in the feature tree. *API only:* `PUT …/features/:slug/artifacts/*key` with `{content}`, and an unknown slug | Round trip OK; an unknown slug returns 404 `SPECKIT_FEATURE_NOT_FOUND` | — |
| S18 | *(Optional)* **Status gates** | UI: the gate list in the Features panel (`spec-kit-feature-gates`); `GET …/features/:slug/status` | `spec`, `plan`, `tasks` and `implement` gates match what exists | — |
| S19 | *(Optional)* **Checklists** | UI: **Generate checklists** right after S4, before `speckit.plan`, and again after it. *API only:* adding a reviewer line to a checklist (feature artifacts have no Edit) | Before `plan.md`: a **failed job** with `SPECKIT_GATE_UNMET`, its message shown in `spec-kit-error` (no longer an HTTP 412). After: five domain checklists (security, performance, accessibility, observability, testability). Re-run (merge is the default): the reviewer's line and its tick survive below the regenerated items (#925) | The items are specific to this feature, for example a bounded `UPDATE` on `entries` or an index on `published_at` |
| S20 | *(Optional)* **Namespaced commands** | UI (S5–S9 already ran them) | Same results as the legacy commands, with no `Deprecation` header | — |
| S21 | **Issue export** | UI: **Preview issue export (dry run)**, then **Publish issues to the saved target** (`openzigs/flux-v2` only) | The dry run lists the issue titles and the target repo (`openzigs/flux-v2`). #953 has landed, so **Publish is enabled after the dry run**, and its confirm names the repo and the issue count. **Dry-run only in a normal run:** J1.8 publishes 2 issues, the whole cap, so open the confirm and **Cancel** (run 10). If the operator gives S21 a slot, publish within the 2-issue cap, to `openzigs/flux-v2` only: the UI publishes one issue per selected task, so publish from a **throwaway feature**, never the run's main feature: tick **one task in the export picker** (`spec-kit-export-tasks`, #993, shown when the dry run lists more than one task) and run the dry run again, or cut `tasks.md` to 1 task. Created issues match the dry run's titles. Publish disabled with "Publishing issues to GitHub is not available on this server yet" means the server has no live issue client: a FAIL | Issue bodies map one-to-one to tasks |
| S22 | *(Optional)* **Archive and restore** | UI: **Archive**, tick **Show archived**, **Restore** (`POST …/features/:slug/archive`, then `…/restore`) | Hidden from `GET …/features`, shown with `?includeArchived=1`, then back | — |
| S23 | *(Optional)* **Install** | *API only:* `POST …/spec-kit/install` | **501 `SPECKIT_ATTACHED_WORKSPACE_NOT_IMPLEMENTED`**. This is expected; do not file it | — |
| S24 | *(Optional; needs a **real** S21 publish and a public webhook tunnel)* **Issue sync**. Since J1.8 publishes 2 issues, the whole sandbox cap, S24 can run only when the operator gives S21 one of the 2 slots for that run (and J1.8 publishes 1); otherwise record it 🚫 with that reason (run 10) | Close a sandbox issue made by S21 (`routes/webhooks-github.ts` → `syncIssueEvent`, #433), then reopen it. Expose only the webhook receivers through a tunnel: a proxy that forwards `POST /api/webhooks/github/pr|issues` (and `/c/<connector id>` under each) and nothing else, never the whole server. If the sandbox connector has its own webhook secret (#1475), set the issue hook's Payload URL to the card's **Issue events payload URL path** (`/api/webhooks/github/issues/c/<connector id>`) with that secret: since #1483 a project with its own secret gets no shared-secret issue deliveries | A **bullet** task is ticked on close and unticked on reopen, with no marker. A **table-form** row is never ticked: close writes `<!-- closed via #N -->` and reopen replaces it with `<!-- open -->` (`toggleCheckbox`, `server/src/lib/spec-kit/issue-sync.ts`) | — |

## Persona scenarios

### Business Analyst: questions METIS should answer, with citations

Ground truth is at `miniflux/v2@v2.3.3`. Ask each question in `/chat` (project scope) **and** check it against the BRD from Phase 9. **Pass** = correct answer **and** at least one correct `file:line` citation.

Over the chat API (the BA re-ask), `inspect_schema` and `query_database` are **not offered to the model at all** since #1139: the response's `data.toolsWithheld` names them (`server/src/routes/ai.ts`, `awaitToolApproval`), and there is no `no_interactive_approver` refusal any more. Database-backed answers fall back to source; record `toolsWithheld` per question, it is not a failure. `search_code_graph` does not index string-literal config keys, so a question about an option such as `POLLING_SCHEDULER` is answered from retrieval, not the graph.

1. **What are the rules for creating a user account (username and password)?** Expect: password at least 6 characters (`internal/validator/user.go:163-164`), username rules in `validateUsername` (`:176`), and uniqueness of `username` (`internal/database/migrations.go:25`).
2. **How does Miniflux decide when to refresh a feed next, and what can an admin configure?** Expect: `Feed.ScheduleNextCheck` (`internal/model/feed.go:123`) and the `POLLING_SCHEDULER` option, round_robin vs entry_frequency (`internal/config/options.go:511`).
3. **When are old articles removed, and what controls it?** Expect: `runCleanupTasks` (`internal/cli/cleanup_tasks.go:16`) calling `ArchiveEntries` for read and unread entries (`internal/storage/entry.go:368`), and `CLEANUP_ARCHIVE_READ_DAYS` / `CLEANUP_ARCHIVE_BATCH_SIZE` (`options.go:126,134`). The answer must say that starred entries are exempt (`starred is false` in the SQL of `ArchiveEntries`, verified in run 2).
4. **What happens to a feed that keeps failing?** Expect: `parsing_error_count` and `POLLING_PARSING_ERROR_LIMIT` (`options.go:503`), counted in `internal/storage/feed.go:117`.
5. **Can a user subscribe to the same feed twice, or have two categories with the same name?** Expect: no; `unique (user_id, feed_url)` and `unique (user_id, title)` (`migrations.go:69,52`).
6. **Which ways can users and third-party apps sign in or authenticate?** Expect: password sessions, OAuth2/OIDC (`internal/oauth2`), WebAuthn/passkeys (`internal/storage/webauthn.go`), API keys (`internal/storage/api_key.go`), and the Fever and Google Reader APIs (`internal/fever`, `internal/googlereader`).
7. **Which third-party services can saved articles be sent to?** Expect: the services `SendEntry` sends a saved entry to (`internal/integration/integration.go:41`): **21 targets** at the tag (Wallabag, Pinboard, Instapaper, Readwise, Linkding, Notion, Webhook and the rest), configured in `internal/model/integration.go`. `PushEntries` (`integration.go:511`) also pushes new entries to **9 targets** on feed refresh (Apprise, Discord, Matrix, ntfy, Pushover, Readeck, Slack, Telegram, Webhook); an answer may name them as a second list. Do not score against the directory: `internal/integration/` has 31 entries at the tag, which are 29 packages (one, `rssbridge`, is not a send target) plus `integration.go` and its test (run 10).
8. **Draw the core data model.** Expect: an ER diagram with users → categories → feeds → entries → enclosures, plus icons and api_keys, that matches the DB connector's inspect output.

### Developer: real Miniflux change requests

Six real requests a developer would paste into impact analysis. The first three (#4478, #4511,
#4336) are feature requests, open on 2026-10-02 and all storage-heavy. The last three (#4479,
#4386, #4456, added by #1044) are bug reports **closed upstream by a merged fix**, chosen to
cover the Google Reader API, the web UI and the fetcher, and to be scored against what upstream
actually changed. All six are asked against the pinned `v2.3.3`, which still has each bug.

**Wave E runs two of them (#1177): #4478 and #4386.** #4478 is the feature request every run since
run 3 has scored (and wave D's Spec Kit feature); #4386 is a bug fixed upstream, so it is scored
against what upstream actually changed. #4511, #4336, #4479 and #4456 are *(optional)*: run one
when a fix in wave E's list names it, or on a full pass. Journey 2 covers #4336 through the UI.
For each request wave E runs:
1. Ask chat "where would I implement this?".
2. Run **impact analysis** (Phase 16).
3. Run Spec Kit `speckit.specify` → `speckit.plan` (#4478 is done in the Spec Kit section; repeat it briefly for #4386 and any optional request run).
4. Draft an issue or PR into the **sandbox** (Phase 12), only if the run's cap of 2 is not used up.

**Cost.** Snapshot the ledger before and after each request's chat, impact and plan, and record
the **per-request ledger delta** (tokens and cost) in wave E's return. Runs 8 and 9 ran all six;
two requests cost about a third of that, and the delta per request stays comparable.

| Issue | What METIS must surface (Useful) |
|---|---|
| [#4478 "Mark all as read older than X"](https://github.com/miniflux/v2/issues/4478) | **That the storage method already exists:** `Storage.MarkAllAsReadBeforeDate` (`internal/storage/entry.go:523`), reached today only through the Google Reader API (`internal/googlereader/handler.go:1225`). So the plan is to expose it through the web UI and, optionally, the REST API (`internal/api/user_handlers.go`, where `markUserAsReadHandler` lives; earlier runs named `entry_handlers.go`, which has no mark-all handler). **No migration.** If METIS proposes new SQL or a new column, mark it **weak** (runs 3 and 4 still proposed a `users` column, #791). |
| [#4511 "Last successful refresh in feed API"](https://github.com/miniflux/v2/issues/4511) | Needs a **new migration** appended in `internal/database/migrations.go`, a field on `model.Feed` (`internal/model/feed.go`), a write in `UpdateFeed` (`internal/storage/feed.go:331`, beside `checked_at` and `parsing_error_count` at :342-344) and **not** in the error path (`UpdateFeedError`, :431; both upstream candidate PRs leave it alone, so a *successful* refresh time does not move on a failure), plus the API JSON. Impact must name table `feeds`, the new column, and the API and Google Reader/Fever consumers. |
| [#4336 "Add read_at timestamp to entries"](https://github.com/miniflux/v2/issues/4336) | A migration on `entries`, and **every status-change path**: `SetEntriesStatus` (`entry.go:412`), `SetEntriesStatusAndCountVisible` (`:431`), `MarkAllAsRead` (`:506`), `MarkAllAsReadBeforeDate` (`:523`), and the Fever and Google Reader handlers. Impact must list all of them; **missing two or more counts as weak**. |
| [#4479 "Reader API `stream/items/ids` count is always 1000 on 2.3.3"](https://github.com/miniflux/v2/issues/4479) (Google Reader API) | **That the cap is `WithLimit`:** it clamps to `model.MaxEntryLimit`, 1000 (`internal/storage/entry_query_builder.go:204`; `internal/model/entry.go:20`), and the four Google Reader stream handlers pass `rm.Count` through it (`internal/googlereader/handler.go:1015`, `:1052`, `:1076`, `:1128`). The ID-list maximum `model.MaxEntryIDsLimit` (10000, `internal/model/entry.go:24`) and `WithLimitAndMaximum` (`entry_query_builder.go:210`) already exist. **No migration.** A plan that changes only `streamItemIDsHandler` (:952), or proposes any schema change, is **weak**. |
| [#4386 "After 'Mark this page as read' the feed shows 0 entries"](https://github.com/miniflux/v2/issues/4386) (web UI) | **That the unread page already handles this:** `showUnreadPage` restarts at offset 0 when `offset >= countUnread` (`internal/ui/unread_entries.go:38`), and `showFeedEntriesPage` (`internal/ui/feed_entries.go:15`) and `showCategoryEntriesPage` (`internal/ui/category_entries.go:15`) do not. `markPageAsReadAction` (`internal/ui/static/js/app.js:577`) reloads the same `?offset=` URL. **No migration and no storage change**; a plan that edits `EntryQueryBuilder` or the status writers is **weak**. |
| [#4456 "Request gets blocked when using private address proxy"](https://github.com/miniflux/v2/issues/4456) (fetcher) | **That only an explicit proxy is a trusted hop:** in `RequestBuilder.ExecuteRequest` (`internal/reader/fetcher/request_builder.go:152`) the exemption at :210-220 compares against `proxyDialAddress` (:178), built from the feed, application or rotator proxy only; a proxy from the environment (`http.ProxyFromEnvironment`, :202) is dialled through `directDialer`, whose `Control` (:186) rejects a private IP. A plan that turns the private-network check off (`FETCHER_ALLOW_PRIVATE_NETWORKS`, or dropping `Control`) is **weak**: it removes the SSRF guard instead of trusting the proxy. |

The "must surface" column stays as the continuity verdict for runs 3 to 6. It cannot tell a plan
that names the right four functions from one that names them among forty wrong ones, so each
output is also **scored on precision and recall** against a reference change set (#1042); an
impact analysis's blast radius is scored on recall only (#1073, "Scoring a change plan").

### Upstream state of the six requests (checked 2026-10-10; re-checked 2026-10-15)

Update 2026-10-15 (run 8): miniflux/v2 PR [#4453](https://github.com/miniflux/v2/pull/4453) ("feat(rewrite): validate rewrite rules at save time with helpful error messages", merged 2026-10-12 as `6333ca10`, no linked issue) is a genuine feature merged after `v2.3.3`. **Decision:** it is recorded as an alternate with its own reference change set (below) and does **not** replace a bug-fix entry yet, because #4386, #4456 and #4479 are upstream-truth fixes tied to issues; swap it in for #4479 only if run 9 wants a third `upstream` feature. #4547 and #4552 were still open on 2026-10-15, so #4511 stays `candidate`.

Read-only `gh` against `miniflux/v2`, as first checked 2026-10-10: `main` at `899fe04c`, and `v2.3.3` (2026-07-24) still the
latest release. No feature PR has merged since `v2.3.3` (the only `feat` title merged since is a
Polish translation, #4527), so none of the three feature change sets is "what upstream actually
did". Re-check before each run: if a candidate PR has merged, switch that request's change set to
the merged diff and its source to `upstream`. A genuine feature request with a merged
implementation after `v2.3.3`, including any of the first three, **replaces** a bug-fix entry
when one appears; #4494 (passkey login loses `redirect_url`, fixed by
[#4500](https://github.com/miniflux/v2/pull/4500), `106cdd09`, UI and JS) and
[#4526](https://github.com/miniflux/v2/pull/4526) (enforce `DISABLE_LOCAL_AUTH` on the REST API
and password changes, `76889f08`, no linked issue: the PR description is the request) are the
alternates.

**Open question (run 10, not decided).** Wave E found upstream feature PRs merged since the
last check (#4596, #4566, #4554, #4556, #4557, #4510, #4453). By the rule above, a genuine
feature request with a merged implementation **replaces** a bug-fix entry, which would give
the developer requests an `upstream` feature set to score against. Run 10 kept the six
requests unchanged so its numbers stay comparable with runs 7 to 9. The owner decides before
run 11 whether to swap one in (and which bug-fix entry it replaces), or to keep the six and
record the merged PRs as alternates; until then, keep the six.

**Gap: integrations.** None of the six touches `internal/integration/` (Wallabag and the other
third-party services). No change merged there since `v2.3.3` closes an issue; add one when it
appears. **Option: a second pin.** A genuine feature merged *before* `v2.3.3` (for example #4372,
REST endpoints for unread and starred entry IDs) is already in the pinned code, so METIS would
find it implemented. Scoring one needs a second Miniflux project pinned at that PR's parent
commit, which is a second full ingest; it is out of scope for now.

| Feature request | Upstream state | Change set source |
|---|---|---|
| [#4478](https://github.com/miniflux/v2/issues/4478) Mark all as read older than X | Issue open; no PR references or implements it | `curated` (from `v2.3.3`, no upstream) |
| [#4511](https://github.com/miniflux/v2/issues/4511) Last successful refresh in feed API | Issue open; two open, unmerged PRs, [#4547](https://github.com/miniflux/v2/pull/4547) (head `d6c8e393`) and [#4552](https://github.com/miniflux/v2/pull/4552) (head `b257374f`) | `candidate` (what both PRs change) |
| [#4336](https://github.com/miniflux/v2/issues/4336) Add `read_at` timestamp to entries | Issue open; no PR references or implements it | `curated` (from `v2.3.3`, no upstream) |
| [#4479](https://github.com/miniflux/v2/issues/4479) Reader API `stream/items/ids` count is always 1000 | Closed 2026-08-09 by [#4497](https://github.com/miniflux/v2/pull/4497), merged as `2f9e07bd` | `upstream` |
| [#4386](https://github.com/miniflux/v2/issues/4386) "Mark this page as read" leaves 0 entries | Closed 2026-10-03 by [#4519](https://github.com/miniflux/v2/pull/4519), merged as `c52bdef6` | `upstream` |
| [#4456](https://github.com/miniflux/v2/issues/4456) Request blocked with a private-address proxy | Closed 2026-10-03 by [#4513](https://github.com/miniflux/v2/pull/4513), merged as `b683d3b4` | `upstream` |

### Reference change sets

Lines are at `v2.3.3`. **Scored** items make up the set. **Neutral** items are reasonable to
name (a caller that needs no change, an optional extra) and count neither way. Anything else a
plan names is a false positive, and the **must not** items are the known wrong answers to list
by name.

#### #4478: Mark all as read older than X

- **Source:** `curated from v2.3.3`. Curated, no upstream: not upstream truth.
- **Files (3):** `internal/ui/unread_mark_all_read.go`; `internal/template/templates/views/unread_entries.html` (the age choice next to "Mark all as read"); `internal/storage/entry.go`.
- **Functions (2):**
  - `ui.(*handler).markAllAsRead` (`internal/ui/unread_mark_all_read.go:13`): takes the age and calls a dated storage method.
  - One slot, either answer scores it: reuse `storage.(*Storage).MarkAllAsReadBeforeDate` (`internal/storage/entry.go:523`), or give `storage.(*Storage).MarkGloballyVisibleFeedsAsRead` (`internal/storage/entry.go:549`, what the UI calls today, which also honours "hide globally") a `before` parameter. Naming both still scores one.
- **Migration:** no.
- **Neutral:** `internal/api/user_handlers.go` `markUserAsReadHandler` (:109) and `internal/api/api.go` (a REST equivalent); `internal/googlereader/handler.go` `markAllAsReadHandler` (:1155, the only caller of `MarkAllAsReadBeforeDate` today, cited as evidence); `client/client.go`; `internal/ui/static/js/app.js`; user settings for the offered ages (`internal/model/user.go`).
- **Must not:** a new column on `users` (#791); any new migration in `internal/database/migrations.go`; a new storage method that duplicates `MarkAllAsReadBeforeDate`.
- **Test files (not scored):** `internal/storage/entry_test.go`, `internal/api/api_integration_test.go`.

#### #4511: Last successful refresh in feed API

- **Source:** `upstream candidate PRs #4547/#4552 (unmerged)`. The set is what **both** change (`gh pr view <n> -R miniflux/v2 --json files`).
- **Files (6):** `internal/database/migrations.go`, `internal/model/feed.go`, `internal/storage/feed.go`, `internal/storage/feed_query_builder.go`, `internal/reader/handler/handler.go`, `client/model.go`.
- **Functions (9):**
  - `database.migrations` (`internal/database/migrations.go:16`): one entry appended.
  - `model.Feed` (`internal/model/feed.go:24`) and `client.Feed` (`client/model.go:143`): a nullable `LastSuccessfulRefreshAt`.
  - `handler.CreateFeedFromSubscriptionDiscovery` (`internal/reader/handler/handler.go:40`), `handler.CreateFeed` (:104), `handler.RefreshFeed` (:196): set it on success.
  - `storage.(*Storage).CreateFeed` (`internal/storage/feed.go:216`) and `storage.(*Storage).UpdateFeed` (:331): write the column.
  - `storage.(*feedQueryBuilder).GetFeeds` (`internal/storage/feed_query_builder.go:139`): read it.
- **Migration:** yes, `feeds.last_successful_refresh_at` (`timestamp with time zone`, nullable).
- **Neutral:** `model.(*Feed).MarkRefreshSuccessful` (added by #4552 only); `storage.(*Storage).UpdateFeedError` (`internal/storage/feed.go:431`) named as the path that must **not** write it; the REST, Fever and Google Reader feed handlers, which serialise `model.Feed` and need no change.
- **Must not:** writing the column in the error path (`UpdateFeedError`); a new table; any change to `entries`.
- **Test files (not scored):** `internal/api/feed_successful_refresh_integration_test.go` (#4547), `internal/api/api_integration_test.go` (#4552).

#### #4336: Add `read_at` timestamp to entries

- **Source:** `curated from v2.3.3`. Curated, no upstream: not upstream truth.
- **Files (5):** `internal/database/migrations.go`, `internal/model/entry.go`, `internal/storage/entry.go`, `internal/storage/entry_query_builder.go`, `client/model.go`.
- **Functions (11):**
  - `database.migrations` (`internal/database/migrations.go:16`).
  - `model.Entry` (`internal/model/entry.go:27`) and `client.Entry` (`client/model.go:262`): a `ReadAt` field.
  - `storage.(*EntryQueryBuilder).GetEntries` (`internal/storage/entry_query_builder.go:270`): read it.
  - Every writer that sets `status` to read, in `internal/storage/entry.go`: `SetEntriesStatus` (:412), `SetEntriesStatusAndCountVisible` (:431), `MarkAllAsRead` (:506), `MarkAllAsReadBeforeDate` (:523), `MarkGloballyVisibleFeedsAsRead` (:549), `MarkFeedAsRead` (:581), `MarkCategoryAsRead` (:608). The must-surface row lists four; the last three also write `status = read` and are in the set.
- **Migration:** yes, `entries.read_at` (`timestamptz`, nullable; the request also proposes an index on it).
- **Neutral:** the `read_at_after` / `read_at_before` filters the request proposes (`api.configureFilters`, `internal/api/entry_handlers.go:560`, new `EntryQueryBuilder` methods, `client/client.go`); the handlers that reach the writers: Fever `handleWriteItems` (`internal/fever/handler.go:401`) and `handleWriteGroups` (:510), Google Reader `editTagHandler` (`internal/googlereader/handler.go:187`) and `markAllAsReadHandler` (:1155), REST `setEntryStatusAndStarredHandler` (`internal/api/entry_handlers.go:198`), UI `updateEntriesStatus` (`internal/ui/entry_update_status.go:16`); `ArchiveEntries` (`internal/storage/entry.go:368`, sets `removed`, not `read`).
- **Must not:** reusing `changed_at` as the read time instead of a new column; a new table for read events.
- **Test files (not scored):** `internal/storage/entry_test.go`, `internal/api/api_integration_test.go`.

The next three sets are upstream truth: their files are the merged PR's non-test files
(`gh pr view <n> -R miniflux/v2 --json files`), and their functions are the ones the merge diff
changes, cited at `v2.3.3`.

#### #4479: Reader API `stream/items/ids` count is always 1000

- **Source:** `upstream PR #4497 (merged 2f9e07bd)`.
- **Files (2):** `internal/googlereader/handler.go`; `internal/googlereader/README.md` (the `n` parameter, :420 and :440, now documents the 10000 cap and `continuation`).
- **Functions (4):** in `internal/googlereader/handler.go`, each swaps `WithLimit(rm.Count)` for `WithLimitAndMaximum(rm.Count, model.MaxEntryIDsLimit)`:
  - `googlereader.(*greaderHandler).handleReadingListStreamHandler` (:1005, call at :1015).
  - `googlereader.(*greaderHandler).handleStarredStreamHandler` (:1049, call at :1052).
  - `googlereader.(*greaderHandler).handleReadStreamHandler` (:1073, call at :1076).
  - `googlereader.(*greaderHandler).handleFeedStreamHandler` (:1119, call at :1128).
- **Migration:** no.
- **Neutral:** `storage.(*EntryQueryBuilder).WithLimit` (`internal/storage/entry_query_builder.go:204`, the cause) and `WithLimitAndMaximum` (:210), both unchanged; `model.MaxEntryLimit` and `model.MaxEntryIDsLimit` (`internal/model/entry.go:20`, `:24`), unchanged; `googlereader.(*greaderHandler).streamItemIDsHandler` (:952, which dispatches to the four) and `getItemRefsAndContinuation` (:1097).
- **Must not:** raising `model.MaxEntryLimit` (it is also the REST API's `limit` cap and the `entries_per_page` maximum; upstream used the separate ID-list maximum); any migration.
- **Test files (not scored):** none in the PR.

#### Alternate: miniflux/v2 #4453, rewrite rules validated at save time

- **Source:** `upstream` (merged PR `6333ca10`, no linked issue: the PR description is the request, like #4526).
- **Files (scored, 8):** `internal/reader/rewrite/content_rewrite.go`; `internal/reader/rewrite/content_rewrite_validation.go` (new); `internal/reader/rewrite/url_rewrite.go`; `internal/validator/rewrite.go` (new); `internal/validator/feed.go`; `internal/ui/form/subscription.go`; `internal/ui/feed_update.go`; `internal/locale/translations/en_US.json`.
- **Neutral:** the other 22 locale files, the templates `add_subscription.html`, `edit_feed.html` and `settings.html` (textarea and monospace change), `internal/ui/static/css/common.css`, and the tests.
- **Behaviour:** malformed content, URL and entry rewrite rules block saving with a message on the add-feed and edit-feed screens and on feed create and update through the REST API (`internal/validator/feed.go`); existing malformed rules are logged at apply time. Scoring uses the same rules as the other sets; a plan that only logs at apply time misses the save-time half.

#### #4386: After "Mark this page as read" the feed shows 0 entries

- **Source:** `upstream PR #4519 (merged c52bdef6)`.
- **Files (2):** `internal/ui/feed_entries.go`, `internal/ui/category_entries.go`.
- **Functions (2):** each wraps its unread query (lines 36-44 in both files) in a closure and re-runs it at offset 0 when `offset >= count && count > 0`:
  - `ui.(*handler).showFeedEntriesPage` (`internal/ui/feed_entries.go:15`).
  - `ui.(*handler).showCategoryEntriesPage` (`internal/ui/category_entries.go:15`).
- **Migration:** no.
- **Neutral:** `ui.(*handler).showUnreadPage` (`internal/ui/unread_entries.go:15`, the existing restart at :38, cited as the pattern); `ui.getPagination` (`internal/ui/pagination.go:23`); `markPageAsReadAction` (`internal/ui/static/js/app.js:577`) and the `markPageAsRead` buttons in `internal/template/templates/views/feed_entries.html` and `category_entries.html` (:22); `ui.(*handler).updateEntriesStatus` (`internal/ui/entry_update_status.go:16`).
- **Must not:** any change to `internal/storage/` (the query builder or the status writers); any migration.
- **Test files (not scored):** none in the PR.

#### #4456: Request gets blocked when using a private-address proxy

- **Source:** `upstream PR #4513 (merged b683d3b4)`.
- **Files (1):** `internal/reader/fetcher/request_builder.go`. (`go.mod` is unchanged: the new `golang.org/x/net/http/httpproxy` import comes from `golang.org/x/net`, already required at `go.mod:18`.)
- **Functions (1):** `fetcher.(*RequestBuilder).ExecuteRequest` (:152): resolves the environment proxy with `httpproxy.FromEnvironment().ProxyFunc()` in place of `http.ProxyFromEnvironment` (:202), records every proxy it routes through as trusted, and drops the `proxyDialAddress != ""` condition (:210) so the trusted-hop dialer is always installed.
- **Migration:** no.
- **Neutral:** a new helper holding the trusted proxy addresses (upstream's `trustedProxyAddresses`, with `add` and `contains`; any name, since it is new); `fetcher.normalizeDialAddress` (:295) and `fetcher.normalizeProxyDialAddress` (:304), unchanged; `urllib.IsNonPublicIP` (`internal/urllib/url.go:183`); `config.(*configOptions).FetcherAllowPrivateNetworks` (`internal/config/options.go:806`).
- **Must not:** turning the private-network check off, by default or for every dial (`FETCHER_ALLOW_PRIVATE_NETWORKS`, or removing the `Control` callback at :186); exempting every private address rather than the proxy's.
- **Test files (not scored):** `internal/reader/fetcher/request_builder_test.go`.

### Scoring a change plan

Score each output on its own: wave E's impact analysis, its chat answer to "where would I
implement this?", its Spec Kit plan, and wave F's J2.1 impact and J2.4 plan. A chat answer and a
plan are each one list, scored on precision and recall. **An impact analysis is two lists,
scored differently** (#1073, owner decision of 2026-10-10 in #1068):

| List | On the page | In the API item | Scored on | `run.json` row |
|---|---|---|---|---|
| **Edit candidates** | the **Files to edit** group (`[data-testid=edit-candidates]`) | `editCandidateFiles`; the `affectedSymbols` at `depth` 0 | file and function **precision and recall** | `"scope": "edit"`, counts `tp` / `fp` / `fn` |
| **Blast radius** | **Files to edit and the Blast radius group together** (`[data-testid=blast-radius-impacts]`, collapsed: open it) | `blastRadiusFiles`; every `affectedSymbols` entry | file and function **recall only** | `"scope": "blast"`, counts `tp` / `fn`, no `fp`; plus `listed`, the list's size |

- **The blast radius includes the edit candidates.** A file to edit is inside the blast radius by
  definition, and `blastRadiusFiles` lists it, but the page's Blast radius group shows only what
  lies beyond the files to edit. So count the blast row over **both groups**; its `tp` is never
  below the edit row's.
- **Why recall only.** A blast radius is the code to review, kept wide on purpose. Scored on
  precision it reads as a failure for doing its job (run 7: impact file precision 1 to 3%). Do
  not count its false positives and do not record an `fp`: `run.json` rejects one on a blast
  row, and the deck shows "not scored" in its precision cells.
- **Record how much the blast radius listed** (`listed`, PR #1125). Recall alone has no cost
  side: a blast radius that names the whole repository recalls everything, and two runs at 60%
  recall that list 12 files and 400 files would read the same. So on every blast row record
  `listed` on `files` and on `functions`: the number of **distinct** files, and of distinct
  functions, in the blast radius (both groups together, as for `tp`), **after the neutral and
  excluded items are removed** (the reference set's Neutral list, test files and generated
  files: the same exclusions as every other count). It needs no judgement on any entry beyond
  those exclusions; from the API it is `blastRadiusFiles.length` less the excluded and neutral
  files. `listed` is **a count, not a score**: the deck prints it as a plain number in its own
  "Listed" column and never as a ratio or a precision, and nobody should turn it into one.
  `listed - tp` is what the rule before #1073 called `fp`, which is how a new run is restated
  for comparison with runs 1 to 7. `listed` is never below `tp`, is allowed on a blast row
  only, and is optional in `run.json` so that a pair re-scored from an old run's saved output
  can omit it when the list was not kept.
- **An impact output is always the pair**, one `edit` row and one `blast` row, with the same
  migration verdict on both (the verdict is the output's, not a list's).
- **A page with no Files to edit group has two causes; tell them apart by the old wording being
  present, never by the new group being absent.** The page hides a group whose list is empty
  (`ui/src/components/impact/changed-requirement-group.tsx`: `editCandidates.length > 0`), so
  an absent group does not say which METIS you are on.
  - **METIS before #1036**: the card's headline (`[data-testid=impact-headline]`, always shown)
    reads "N directly affected across M files · K callers", and the first group is headed
    **Directly affected** (`[data-testid=direct-impacts]`). Score **Directly affected as the
    edit candidates**, and Directly affected plus that page's Blast radius group (summarised
    "callers/importers") as the blast radius. That is the same
    split: #1036's edit candidates are the `depth` 0 symbols, which is what "directly affected"
    listed.
  - **Current METIS with an empty edit list**: the headline reads "0 files to edit · K more to
    review" and there is no "directly affected" wording anywhere on the card. This happens with
    a blast radius that is not empty, for example when every search hit is a schema or test
    symbol (only production, non-schema hits can be files to edit). It is a result, not an old
    page: record the **edit row as `tp` 0, `fp` 0, `fn` = the set's size** (precision reads
    "–", recall 0%), for files and for functions, and score the **blast row from the Blast
    radius group** as usual. Say in the results that the edit list was empty.
- **A result with one undivided list** (an export or a saved answer that does not say which
  entries were direct): do not guess a split. Score it by the rule before #1073, both lists
  together on precision and recall, as **one row with no `scope`**, and say so in the results.
- **Runs 1 to 7** scored both lists together, so their impact rows have no `scope`. They stay as
  they are: the deck labels such a row "both lists together (rule before #1073)". Never add a
  `scope` to an old row: its `fp` was counted over both lists. Its **recall** is comparable with
  a later run's blast-radius recall (the same lists, counted the same way); its **precision** is
  comparable with neither new row. To compare precision with an old run, re-count that run's
  saved impact output by the rule above and replace the row with the pair, saying in the
  results that it was re-scored.

A column listed under **Optional: settings
persistence** or **Not proposed** (#791, #1051) is **not** a proposed column and not a
migration: for #4478 the owner decision in #1068 accepts an optional, labelled settings column
and rejects only a column among the proposed changes. A column listed under **Proposed, not
checked** IS among the proposed changes (the gate had no write path to check it against): count
it as proposed, and record that it was unchecked.

- **A Spec Kit plan is scored on `plan.md` alone.** `plan-context.md` (#1060) lists every file
  the planner was given, not the files the plan changes: it is never scored as a plan, and a
  file named only there is not "named". Use it to tell a retrieval miss (the set file is not
  listed) from a planning miss (it is listed and the plan does not name it).
- **Files.** `tp` = set files the output names; `fp` = files it names that are neither in the
  set nor neutral; `fn` = set files it does not name. **Precision** = `tp / (tp + fp)`;
  **recall** = `tp / (tp + fn)`. A file named twice counts once. For an impact row, "the output"
  is the list the row scores; `tp + fn` is the size of the set on every row.
- **Functions**, the same way at symbol level. A slot with alternatives (#4478's storage method)
  is one set item.
- **Excluded from both sides:** test files (`*_test.go`, anything under a `tests` directory) and
  generated files (a `Code generated … DO NOT EDIT.` header; none of the six sets has one).
  Naming one is neither `tp` nor `fp`.
- **A symbol counts as named** when the output gives (a) its identifier together with its file,
  in the same bullet, sentence or table row; or (b) a `file:line` that falls inside its body at
  `v2.3.3`; or (c) the bare identifier, when only one non-test declaration in `v2.3.3` has that
  name (`SetEntriesStatusAndCountVisible` qualifies; `CreateFeed`, declared in both
  `internal/reader/handler` and `internal/storage`, does not). An identifier given with the
  wrong file is not named, and counts as a false positive.
- **Migration correct:** `yes` when the output proposes a migration exactly when the set has one,
  on the set's table, with the set's column or an unambiguous synonym. Saying nothing about a
  migration is correct only where the set has none.
- **Must-surface**: still record the table's verdict alongside, for continuity with runs 3 to 6.

**Worked example.** J2.1's impact for #4336 shows:

- **Files to edit:** `internal/storage/entry.go` (with `SetEntriesStatus` and `MarkAllAsRead`),
  `internal/database/migrations.go` (with `migrations`) and `internal/model/feed.go` (with
  `model.Feed`).
- **Blast radius** (opened): `SetEntriesStatusAndCountVisible`, also in
  `internal/storage/entry.go`; `internal/storage/entry_query_builder.go` and
  `internal/reader/handler/handler.go`, each with two symbols the set does not name;
  `internal/fever/handler.go` with `handleWriteItems`; and `internal/storage/entry_test.go`.
- It proposes `ALTER TABLE entries ADD COLUMN read_at timestamptz`.

The test file is excluded and the Fever handler and `handleWriteItems` are neutral, on both rows.

**Edit candidates** (the Files to edit group alone), on precision and recall:

- Files: `entry.go` and `migrations.go` are `tp` (2), `model/feed.go` is `fp` (1), and
  `model/entry.go`, `entry_query_builder.go` and `client/model.go` are `fn` (3). Precision
  2/3 = 67%, recall 2/5 = 40%.
- Functions: `SetEntriesStatus`, `MarkAllAsRead` and `migrations`, each given with its file
  (rule a), are `tp` (3); `model.Feed` is `fp` (1); the other 8 set items are `fn`. Precision
  3/4 = 75%, recall 3/11 = 27%.

**Blast radius** (both groups together), on recall only:

- Files: `entry.go`, `migrations.go` and `entry_query_builder.go` are `tp` (3); `model/entry.go`
  and `client/model.go` are `fn` (2). Recall 3/5 = 60%. `model/feed.go` and
  `reader/handler/handler.go` are in neither count: a blast radius has no `fp`.
- Functions: the three above and `SetEntriesStatusAndCountVisible` are `tp` (4); the other 7
  set items are `fn`. Recall 4/11 = 36%. The symbols listed under `entry_query_builder.go` and
  `reader/handler/handler.go` are in neither count.
- Listed, a count and not a score. Files: `entry.go`, `migrations.go`, `model/feed.go`,
  `entry_query_builder.go` and `reader/handler/handler.go`, so `listed` is 5; the Fever handler
  (neutral) and the test file (excluded) are left out. Functions: `SetEntriesStatus`,
  `MarkAllAsRead`, `migrations`, `model.Feed`, `SetEntriesStatusAndCountVisible`, and the two
  symbols under each of `entry_query_builder.go` and `reader/handler/handler.go`, so `listed`
  is 9; `handleWriteItems` (neutral) is left out.

Migration correct: yes, on both rows. Must-surface: weak (it misses `MarkAllAsReadBeforeDate` and
the Google Reader handlers: two or more).

Recorded in `run.json` as two rows:

```json
{ "issue": 4336, "output": "j2-impact", "scope": "edit", "source": "curated",
  "files": { "tp": 2, "fp": 1, "fn": 3 }, "functions": { "tp": 3, "fp": 1, "fn": 8 },
  "migrationCorrect": true },
{ "issue": 4336, "output": "j2-impact", "scope": "blast", "source": "curated",
  "files": { "tp": 3, "fn": 2, "listed": 5 }, "functions": { "tp": 4, "fn": 7, "listed": 9 },
  "migrationCorrect": true }
```

The report deck computes the ratios from these counts, and prints the blast row's Listed cell as
"5 files · 9 functions". By the rule before #1073 the same output was one row with no `scope`,
`"files": { "tp": 3, "fp": 2, "fn": 2 }`: the recall the blast row has (60%), and a precision
(60%) that neither new row reports. Its `fp` of 2 is the blast row's `listed - tp` (5 - 3), and
its function `fp` would have been 9 - 4 = 5: that subtraction is how a new run is compared with
runs 1 to 7, without the deck ever showing a blast-radius precision.

## Journeys (wave F)

The phases above test METIS **feature by feature**, often through API shortcuts and IDs handed
from one wave to the next. Nothing there checks that a real person can take their own work from a
starting point to an outcome in the UI, and that is where run 4's worst bugs were: at the handoffs
between features (#939 approval, #940 a dropped label, #943 cost lost between run and run page,
#941 no invite UI). The journeys run as **wave F**, after wave E (`briefs/wave-f.md` in the skill).

### Rules for a journey

- **Persona and goal**, stated as the outcome the person wants.
- **Starting state**: what exists, and what the persona knows. The persona knows names, URLs of
  pages a user would bookmark and the sandbox repo; **not** internal IDs or the API.
- **UI only.** No `fetch()`, no SQL, no IDs from earlier waves. A step that cannot be done in the
  UI is a finding, recorded `works: "blocked"` with the missing control named. The one exception
  is measurement: the ledger snapshots before and after each journey (the skill, section 5) are
  the operator's, not the persona's.
- **Handoff checks** after every step: what the persona created must survive into the next step
  (same title, same edited text, same links, same labels). A handoff that loses data fails the
  step, even if each feature works on its own.
- **Journey-level pass bars**: completed in the UI; no data lost between steps; within the time
  and cost budget. A journey that finishes over budget passes "completed" and fails "budget".
- **Step logging**: every screenshot goes into `steps.jsonl` with `wave: "F"`, `phase: "J1.4"`
  (journey 1, step 4) and `chapter: "Journey: Business analyst"` or `"Journey: Developer"`, so
  both decks show each journey as one chapter.

### Journey 1: Business analyst ("Priya")

**This is the core of the run (#1177).** Give it the time; the developer side is a smoke test.

**Decide up front whether to approve all.** Run 8's 5 items became about 34 requirements and the harness refuses a scripted bulk rejection. The journey ran 43 of its 45 minutes with no idle time. Take viewport screenshots on analysis pages: a full-page capture of the Traceability tab crashes Chrome.

**Goal:** turn open Miniflux feature requests into reviewed, signed-off, traceable requirements,
a BRD a stakeholder could sign, and sandbox issues for a sprint.
**Budget:** ≤ 60 min, ≤ $1.50 of Priya's own steps. The clock stops while J1.4a to J1.4c are
operator-run; record their wall time on its own line.

**People.** Priya is `admin` (the user wave F signs in as). The reviewer is `coordinator`; the
second analyst, Sam, is `developer`, who can comment, mention, discuss and review but not edit a
requirement (`developer` lacks `project.update`). The operator made both workspace members
before wave B (Setup order 3). Their steps are **[2nd user]** steps ("Second-user steps").

**Starting state.** Priya is a member of the run's workspace and knows its name. She creates a
fresh project inside it from `/projects`, connects `https://github.com/miniflux/v2` at `v2.3.3`
in `/projects/:id/connections` (vault picker for the token) and waits for the ingest. That setup
is outside the budget; the clock starts at step 1. She knows the sandbox repo `openzigs/flux-v2`,
the reviewer's name (`coordinator`) and her colleague's (`developer`).

| # | Priya does | Must hold |
|---|---|---|
| J1.1 | In `/projects/:id/import`, imports open GitHub feature requests from `miniflux/v2`. Miniflux marks them with a `[Feature]:` title prefix, not a label, so she uses "Title starts with" (#1006) | Titles and bodies kept, without the `[Feature]:` prefix. Types sensible ("[Bug]" not typed as a feature). `[Feed Issue]` and `[Proposal]` items are not imported |
| J1.2 | Picks 5 imported items in "Analyze imported requirements" and runs requirements analysis in `/projects/:id/analysis` | Each item is analysed as its own `NR-*` requirement and listed on the Summary tab with a link back to its issue (#1006). The analysis cites real code for each. It is clear which agents ran |
| J1.3 | Answers the clarifying questions on the run's Questions tab | Her answers land in the requirements she approves. The questions about her five ticked items come first, ahead of any about requirements the analysis added (#1129). Record how many questions were asked |
| J1.4 | Checks on `/settings/workspaces/:id` that `coordinator` and `developer` are members, and invites `reader@metis.local` from the page's invite card (nobody accepts it). Approves the checkpoint (leaving out what the analysis added), requests review on `/projects/:id/requirements` of her five only from `coordinator`, edits one requirement's acceptance criteria. If she withdraws the review for the **Withdraw review** check, she sends it again so J1.4a has a review to decide | Both members are listed (**Test Coordinator**, **Test Developer**), and the invite card confirms the invite for `reader@metis.local` and shows its link, once, right after it is created (#941; there is no list of pending invites). The Approvals checkpoint lists "From your ticked items" apart from "Added by the analysis"; **Leave out the N added by the analysis** (`POST …/approvals/reject-added`, asks for confirmation) rejects the added ones in one action, and **Approve all** then approves the five (#1129). Record the clicks needed to end with the five. The Request review form's **Only the N from ticked items** limits the review, and the form says "This review covers 5 of N requirements" before it is sent (#1129). Approval flows through to the requirements (#939). The edit keeps links, labels and version history (#940). The review appears on `/reviews`. **Withdraw review** is offered on the review page and on its `/reviews` row while it is in review; after confirming, the review is a draft and every requirement shows the status it had before the request (#1032, #989) |
| J1.4a | **[2nd user: `coordinator`]** The reviewer opens the review from the notification bell or `/reviews`, reads the five, and on the requirement J1.4 did not edit leaves a requirement comment that @mentions Priya and asks for one concrete change to its acceptance criteria. Then **Reject**s the review with a note naming that requirement: rejecting with a note is how a reviewer requests changes | The review lists exactly the five, at the versions J1.4 left. The @mention picker offers Priya and `developer`, and only users who can open the project (#870). Priya, on her own screen (the observer window, in `operator-run`) and with no reload: the comment appears in the requirement's panel (#997), a notification names the reviewer and opens the comment (#735, #104), and the review reads **Rejected** with the reviewer's note |
| J1.4b | **[2nd user: `developer`, the second analyst]** Sam replies to the reviewer's comment, then on `/projects/:id/discussions` starts a thread about the same requirement that @mentions Priya. Priya's window (the observer, in `operator-run`) has the requirement's comment panel open for the reply, then `/projects/:id/discussions`; once the thread appears she opens it, and Sam posts one more message in it | Every author shows a display name, never a raw user id (#734). Sam's reply appears in Priya's comment panel with no reload (#997). Priya gets the mention as a notification that opens the thread (#104); the thread appears in her list, and Sam's follow-up in the open thread, live. Both users' presence avatars show on the thread (`components/presence/PresenceAvatars`). Sam has no **Edit** on the requirement (`developer` lacks `project.update`) |
| J1.4c | Priya answers. **[2nd user: `developer`]** Sam has the discussion thread open first. Priya replies in the requirement's comment thread and in Sam's discussion, then makes the reviewer's change in the requirement's acceptance criteria. After the rejection the five read **Rejected**, and no control revises a rejected review (the state machine's `rejected → revise` has no route or UI), so she asks again with a **new** review: **Request review** on `/projects/:id/requirements`, **Only the N from ticked items**, reviewer `coordinator`. **[2nd user: `developer`]** Sam looks at Priya's discussion message for **Edit** and **Delete**. **[2nd user: `coordinator`]** The reviewer approves the new review | Her reply appears in Sam's open thread with no reload (observer: Sam's window in `operator-run`, the agent's second context in `operator-approved`). Priya's message offers Sam no **Edit** or **Delete** (#734). That is a UI check: the server's 403 for another member's edit is covered by `server/src/routes/discussions.multi-member.test.ts`, so nobody calls the API as Sam. Her edit is a new version under her name in History, and the new review pins that version. The first review stays **Rejected**; the new one reads **Approved**, and all five requirements read **Approved** on `/projects/:id/requirements`. Record how many notifications Priya got across J1.4a to J1.4c, and that each opened the right place |
| J1.5 | Opens traceability for her 5 requirements | Each links to code. "Tested by" shows real tests or says untested (#905) |
| J1.6 | Asks `/chat`, scoped to her project, "which of these touch the database?" | The answer cites her requirements and the schema, with valid `file:line` |
| J1.7 | Generates a BRD scoped to her requirements in `/projects/:id/documentation` (scope "Requirements", her run, then **Only the N from ticked items**). It is the deliverable she would send for sign-off, so it is checked as a file: its Word and PDF exports are fetched by URL and opened (Phase 9's method; a Download click crashes the browser, so fetching the URL is the harness's stand-in for her click, not a persona action) | The form says it will cover 5; the document's title and introduction state 5 requirements (#1129). It covers only those 5, with citations, inside the cap, and carries J1.4c's approved criteria. It passes the Phase 9 sign-off rubric (SO1–SO4, with the J1.7 readings): report its sign-off line (#1175). The `.docx` and `.pdf` open, carry the same title and the same five requirement headings as the markdown export, and end with its last heading. A file that fails to open, is empty, or loses a requirement fails the step |
| J1.8 | Dry-runs, then publishes 2 issues to `openzigs/flux-v2` from `/projects/:id/publish` | Bodies carry her edited criteria and a **Related code** section with her requirement's code links, or a line saying none were recorded (#1064). Because `openzigs/flux-v2` is not the analysed repository, the paths and symbols are plain code: no link, no `miniflux/v2`, no commit SHA, and the section's last line says so (#1064). No internal IDs appear as labels (#744) or in the visible body of either issue, the epic included: the footer reads `Generated by METIS`, the epic names its analysis by start time and lists sub-issues by title, and the ids are in a hidden `metis-source` comment on the last lines of the published issue's source (#1064). The dry-run plan shows every `issue.create` title even when it stops at 25 rows, and its "not shown" line counts what is left out (#1064). The epic is not named after one of her five requirements (#1064). Counts against the run's cap of 2 |
| J1.8a | *(Conditional on #1176.)* Once the sandbox Jira from #1176 exists, publishes the same two requirements to it: dry run first, then at most 2 issues, by #1176's Jira variant of J1.8. Until it exists, skip the step and record it `skipped: no sandbox Jira (#1176)` | The Jira issues carry the same edited criteria as J1.8's; nothing is published to any other Jira project. Its cap is separate from the GitHub sandbox's |
| J1.9 | Checks what it cost on `/projects/:id/usage` | The usage page shows the journey's spend, and it matches the ledger delta |

**Handoffs to check:** J1.1's titles are the requirement titles in J1.4; J1.3's answers are in
the text J1.4 approves; the change the reviewer asked for in J1.4a is the version J1.4c's review
approves; J1.4's and J1.4c's edited criteria are in J1.7's BRD and J1.8's issue bodies; J1.5's
code links are in J1.8's bodies; J1.7's BRD names exactly J1.2's five items, in all three export
formats.

### Journey 2: Developer ("Dev")

**Goal:** pick up a real Miniflux issue ([#4336](https://github.com/miniflux/v2/issues/4336),
"track `read_at`") and come away with a correct change plan.
**Budget:** ≤ 30 min, ≤ $1.00.

**Starting state.** Dev is a workspace member and knows the run's project by name (the wave A
project, already ingested at `v2.3.3`) and the issue's URL. He knows nothing else.

| # | Dev does | Must hold |
|---|---|---|
| J2.1 | Pastes the issue into `/impact-analyses/new` | Names every writer of `entries.read_at`, including `SetEntriesStatusAndCountVisible` (#935) |
| J2.2 | Opens the code graph or a symbol from the result on `/impact-analyses/:id` | Navigates to the real definition at the pinned commit |
| J2.3 | Asks `/chat` a follow-up ("what about Fever and Google Reader?") | Earlier citations are kept (#773). New handlers are named with valid lines |
| J2.4 | Runs Spec Kit specify, plan and tasks for the change on `/projects/:id/spec-kit` | The plan reuses existing functions and proposes no duplicates (#944, #785) |
| J2.5 | Exports tasks to the sandbox if #953 has landed, otherwise dry-runs | Dry-run titles equal created titles. Sandbox only, within the cap of 2 |

**Handoffs to check:** every writer J2.1 names is in J2.4's plan; J2.3's answer keeps J2.1's
citations; J2.5's titles are J2.4's tasks.

### Later journeys (not yet in the plan)

- Admin onboarding a team: workspace, members, budgets, model preferences.

## Wave G — implement the plan (conditional)

Waves D and F show that METIS writes a Spec Kit `tasks.md`; nothing there shows the tasks can be
implemented or that the result compiles. Wave G hands one feature request's `tasks.md` to an
implementing agent, which builds it on a branch of the sandbox fork and proves whether it builds
and its tests pass. That turns "the plan looks right" into "the plan produced working code", and
scores the diff against the reference change set. It runs from `briefs/wave-g.md` in the skill,
dispatched to an implementing agent, not `ui-vision`: no browser and no METIS calls.

- **When (#1177): only when the release under test touches Spec Kit or impact analysis.** Before
  wave A, list the METIS changes since the previous run's `metisSha` in those areas:

  ```bash
  git diff --name-only <previous metisSha>..<this run's metisSha> -- \
    server/src/lib/spec-kit server/src/routes/spec-kit.ts ui/src/components/spec-kit \
    'ui/src/app/(authed)/projects/[id]/spec-kit' \
    server/src/lib/impact-analysis server/src/routes/impact-analysis.ts ui/src/components/impact \
    'ui/src/app/(authed)/impact-analyses'
  ```

  Any path printed: run wave G after wave D, or after journey J2 if wave F ran. Nothing printed:
  skip it and record `skipped: no Spec Kit or impact change since <sha>` in the results. A fix in
  `fixes.json` placed in wave G also makes it run.
- **Input:** one feature request's `tasks.md` and `plan.md`, exported from METIS (the feature
  tree's artifact viewer on the Spec Kit page). Default request: **#4478**, wave D's feature, whose
  tasks S7 already wrote. If wave F ran, J2.4's tasks for **#4336** are the alternative. #4511 has
  the most trustworthy change set (the two upstream candidate PRs), but no wave writes tasks for
  it.
- **Steps:**
  1. Clone `openzigs/flux-v2` and check out `c4d54f87` (= `v2.3.3`; the fork has the commit but
     **not the `v2.3.3` tag**, so branch from the SHA). Miniflux `v2.3.3` declares `go 1.26.0`.
     `gh repo clone` adds an `upstream` remote and makes `miniflux/v2` gh's default: run
     `git remote remove upstream && gh repo set-default openzigs/flux-v2` before anything else.
  2. Create the branch `walkthrough/run-<N>-<issue>`, for example `walkthrough/run-7-4478`.
  3. Implement the tasks in order, **one commit per task**.
  4. Run `go build ./...`, `go vet ./...` and `go test ./...`, all with `CGO_ENABLED=0`, as
     Miniflux's own `Makefile` does (a macOS host without the SDK headers fails otherwise). The
     API integration tests (`internal/api/api_integration_test.go`) skip unless the
     `TEST_MINIFLUX_*` variables are set, so no running Miniflux or database is needed. Storage,
     web UI and Fever/Google Reader tests also **skip without a Miniflux Postgres harness**
     (13 of 15 new tests skipped in run 9): report new tests as written / ran / skipped, and do
     not count a skip as a pass.
  5. Score the diff (`git diff c4d54f87..HEAD`) against the request's reference change set, by
     the "Scoring a change plan" rules above. Test files are excluded there, so the new tests
     are counted on their own row.
  6. Push the branch to `openzigs/flux-v2`, and nothing else (the skill, section 4).
- **Human-correction rule:** the agent implements each task **as written**. Where a task is
  wrong, missing or ambiguous, the agent still finishes the change but records the task as
  **needed correction**, with a one-line reason (for example "task adds a `users` column; the
  storage method already exists"). A task the agent had to add counts as one.
- **Budget:** stop at about **$3** of the agent's LLM spend or **45 minutes**, whichever comes
  first, and score what exists. A stop before the build is "builds: not reached", not a fail of
  METIS. Target: $1 to $3 and 30 to 45 minutes.

### Score

| Measure | Value |
|---|---|
| Builds | yes / no (`go build ./...`) |
| Tests pass | yes / no, with failing package names (`go test ./...`) |
| New tests written | count, and how many of them skipped (no Postgres harness) |
| Tasks needing correction | N of M, each with its reason |
| Diff vs reference change set | file and function precision and recall, by "Scoring a change plan" |
| Agent cost | the implementing agent's own tokens and dollars, reported **separately** from METIS spend |
| Wall time | minutes |

The agent's spend is not in METIS's `token_usages` ledger. Report it from the agent's own usage
and keep it out of the run's METIS totals. The score goes into `run.json` as `buildProof` (the
skill, section 7), and the report deck shows it on a "Build proof" slide.

## Evidence to capture (per phase)

- A screenshot at each step's end state, with one line per screenshot in the run's `steps.jsonl` (the skill, section 7).
- `browser_console_messages` for errors and warnings, and failed network requests from `browser_network_requests` (status ≥ 400 that was not expected).
- Wall-clock time from click to terminal state (ingest, analysis, each doc, each Spec Kit command, impact, PR review).
- **Token and cost per phase**: the delta from the `token_usages` ledger before and after each phase (queries in the skill, section 5), recorded in a table:

| Phase | Wall time | Input tok | Output tok | Cache-read tok | Cost (USD) | Console errors | Verdict (Works / Useful) |
|---|---|---|---|---|---|---|---|

- For each "Useful" check, the exact METIS output quoted, next to the ground-truth `file:line` at `v2.3.3`.

## Output

- **One GitHub issue in `openzigs/metis` per failure or weak result.** Each one includes:
  - the phase and step;
  - the route and page;
  - "Works" or "Useful" failure;
  - expected vs actual output;
  - a screenshot and console excerpt;
  - token cost.
- Link each one back to #706 with a task-list line `- [ ] #NNN <title>`.
- Label each finding `e2e-walkthrough` plus its area. Known limitations (see Environment) and S23's 501 are **not** findings.
- Post a final comment on #706 with the evidence table and the pass/fail tally, broken down by feature × {Works, Useful}.
- A step that turns out to be wrong — a dead route, a renamed page, a changed pass bar — is fixed **in this file** in a PR, not in the results comment.

## Acceptance criteria

- [ ] The Playwright MCP connected headed; screenshot of `/dashboard` attached.
- [ ] DeepSeek config confirmed: `GET /api/ai/models` shows `deepseek-flash`, `jsonSchema: false`; no Unpriced usage once `MODEL_PRICES` is set.
- [ ] Miniflux pinned at `v2.3.3` (`c4d54f87`) and fully ingested; embeddings backend is not the offline hash stub.
- [ ] Phases 1–20 were each run, with a Works and Useful verdict and evidence recorded.
- [ ] Spec Kit smoke set S2, S4, S6, S7 and S21 each have a verdict (#1177). Every other S-step has a verdict or reads `skipped (optional)`; one a fix in wave D's list named has a verdict.
- [ ] `speckit.specify` and `speckit.plan` report **grounded on K > 0 retrieved chunks**.
- [ ] 8/8 BA questions answered. Pass bar: **at least 6 correct with valid citations**.
- [ ] 2/2 developer requests (#4478 and #4386; #1177) have an impact analysis, a plan, and a sandbox draft, with a per-request ledger delta. For #4478, METIS surfaces `MarkAllAsReadBeforeDate`. Any optional request run has the same.
- [ ] Every developer-issue output (impact, chat, plan, J2.1, J2.4) has file and function precision and recall and a migration verdict against its reference change set, recorded in `run.json` `changePlanAccuracy`. Each impact output (impact, J2.1) is two rows: its edit candidates on precision and recall, and its blast radius on recall only (#1073).
- [ ] Journeys 1 and 2 each have a verdict on the three journey pass bars (completed in the UI, no data lost between steps, within budget), with the step where any of them broke.
- [ ] Journey 1's two-user steps (J1.4a to J1.4c) each have a verdict and say how the second user ran (`operator-run`, `operator-approved` or `agent`): a rejection with a note, the analyst's change, a second review approved, and a mention, comment and discussion seen live by the other user.
- [ ] The BRD's Word and PDF exports were fetched by URL and opened (Phase 9 and J1.7), and both BRDs have a sign-off line (#1175). J1.8a is published to the sandbox Jira, or recorded `skipped: no sandbox Jira (#1176)`.
- [ ] Wave G ran, or is recorded as skipped with the empty Spec Kit and impact diff since the previous run.
- [ ] Nothing was published, commented or reviewed on `miniflux/v2`; verify with `gh` and attach the output.
- [ ] Per-phase token/cost table posted; total spend within the project budget.
- [ ] Every failure or weak result filed as its own issue and linked to #706.

## Out of scope

- Bedrock: **#282** (closed) and **#376** (live gateway cache-write recording). There is no gateway on this machine.
- **Scala, Rust, C and C++** parsing and lineage (#318).
- Flipping `ANALYSIS_NATIVE_TOOL_CALLS` (#214) and capturing the DeepSeek `AI_RECORD` fixtures (#197). Note any evidence that is relevant to them, but don't solve them here.
- Live Jira, Confluence, Azure DevOps, Linear, Slack, Teams and PagerDuty. Check their "not configured" states only, unless credentials exist.
- `POST /api/projects/:id/spec-kit/install` (deliberately 501 until the AttachedWorkspace model lands).

## Unverified items (check during the run)

- The Go file count used in Phase 2's "Useful" check.
- Line counts were measured on default-branch HEAD (`703fe826` / `e566e1c`), not on the pinned tags.
- The cost estimate: 5–20M tokens, about $2–$25 at peak (runs 3 and 4 measured $9.84 and $4.32).

Resolved since #706 was written: the Miniflux `-migrate` recipe (the skill's setup step 2), whether `/chat` dispatches Spec Kit commands (it does not, #931), and whether `ArchiveEntries` exempts starred entries (it does).
