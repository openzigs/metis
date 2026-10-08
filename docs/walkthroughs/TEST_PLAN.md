# METIS end-to-end walkthrough — test plan

This is the test plan for the end-to-end walkthrough tracked in
[#706](https://github.com/openzigs/metis/issues/706): phases 1–20, Spec Kit S1–S24, pass bars, the
Business Analyst questions and the developer issues. It moved here from #706's body in #948 so that
changes to it are reviewed, show up in PRs and are checked by CI. **Results still go on #706**, as
one comment per run built from [`RESULTS_TEMPLATE.md`](RESULTS_TEMPLATE.md).

The `e2e-walkthrough` skill (`.github/skills/e2e-walkthrough/`) holds the **mechanics**: fixtures,
setup order, waves, guard-rails and measurement. This file holds the **procedure**: what to do and
what passing looks like. The wave briefs point here for the steps; where a phase has a check that
only matters for one run, the brief carries it.

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
3. Set a project budget (`/projects/:id/settings` budget card, `PATCH /api/projects/:id/budget`). Suggested: **$25** for the whole walkthrough.

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
3. **Workspace membership has no invite UI** (#941). To add a member: `POST /api/workspaces/:id/invites`, then open `/invites/<token>` as that user, then log that user in afresh. Reviewers (Phase 8) must be workspace members.
4. **Add the repo connector pinned to `v2.3.3` before anything auto-ingests `main`.** Never click **Test** on it afterwards, because Test resets the branch to the default (#714).
5. **There is no `ChangeLog` at v2.3.3.** Phase 3 uploads `miniflux.1` (renamed `.txt`; `.1` is rejected) instead.
6. **Never reject an approval item on a run you still need.** One rejection permanently blocked promotion, Deep Dive and publishing for that run (#723); PR #902 changes that, and wave B re-verifies it on a throwaway run.
7. **API checks:** login is limited to 20 per 15 minutes. Use `fetch('/api/...')` from the logged-in page instead.
8. **Run the UI and server dev processes in a terminal you own**, not as a harness background task, which is killed after at most 2 h.

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
  3. Open `/repositories` and `/projects/:id/repositories`.
- **Works:**
  - The ingest job's progress (`components/realtime/job-progress`) reaches completion.
  - `GET /api/projects/:id/connectors/repos/:repoId` shows code-graph stats greater than 0.
  - The connector card reads `connected` with the commit as soon as the first ingest ends, with no reload, and its commit is the code graph's `commitSha` (#758, #762).
  - The Deep Ingest banner reports the graph's totals ("code graph of N files, …"), not the delta (#715).
  - No credential-scan quarantine for Miniflux. If one fires, record which file.
- **Useful:** the code graph stats name a file count on the order of Miniflux's roughly 400 Go files *(order of magnitude; confirm with `find . -name '*.go' | wc -l` at the tag)*. `internal/storage`, `internal/api` and `internal/validator` appear as modules.

### Phase 3 — Ingest, embeddings and RAG
- **Steps:**
  1. In `/projects/:id/documents`, upload `README.md` and `miniflux.1` (as `.txt`) from the checkout (`POST /api/projects/:id/documents`). Add the URL `https://miniflux.app/docs/api.html` (`POST …/documents/url`) and one text note (`POST …/documents/text`).
  2. Approve the documents (`POST …/documents/:id/approve`). Uploaded and URL documents land in quarantine (Project settings → Quarantine) until approved.
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
  2. Open `/projects/:id/jira` (`/api/jira/connections`). *(The test-management connections page was removed with Test Coverage, #812 / #819.)*
- **Works:**
  - The preview shows a count roughly equal to Miniflux's open *issues* (fewer than the 287 issues + PRs).
  - The run completes.
  - Jira shows a clean "not configured" state. **Skip its live path unless credentials exist**, and record "skipped: no credentials".
- **Useful:** the imported items include #4511, #4336 and #4478 with their titles intact.

### Phase 7 — Analysis, deep dive and agents
- **Steps:**
  1. In `/projects/:id/analysis`, start an analysis: `POST /api/projects/:id/analyses`, after `GET …/analyses/capability` and `GET /api/analyses/personas`.
  2. Watch the agents (`code`, `database`, `document`, `synthesis`, `web`). An analysis shows "0 tok" until it ends, so poll `GET /api/analyses/:id`.
  3. Open one finding's **deep dive** (`POST …/analyses/:aid/findings/:fid/deep-dive`).
  4. Regenerate one agent (`POST /api/analyses/:id/agents/:agentKey/regenerate`).
  5. Run clarify (`GET/POST …/clarify`, `…/clarify/export`). **Clarification starts when the Questions tab opens**; don't switch away and back while it is starting, which starts it twice (#937).
  6. Run the gap report (`…/gap-report`), export (`…/export`) and approvals (`…/approvals`).
- **Custom and library agents:**
  1. In `/library?tab=agents`, enable a library agent for this project (`PUT /api/projects/:id/library/agents/:agentId`).
  2. In `/workspaces/:id/agents/new`, create a custom agent named "Go SQL reviewer" (`POST /api/custom-agents`). The **tools** step lists `search_code_graph`, `search_code_symbols` and `read_file_slice`; the **playground** says it runs on the prompt alone and every playground answer carries the "Ungrounded answer" notice.
  3. Enable it (`PUT /api/custom-agents/:id/enablement`) and invoke it (`POST /api/custom-agents/:id/invoke`).
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
  1. In `/projects/:id/requirements` (`components/requirements/requirements-hub`), review the requirements extracted from the analysis. Approve them in the Approvals checkpoint, editing one first.
  2. Approve, reject or edit one (`PATCH /api/analyses/:id/requirements/:reqId`, versioned: a stale `version` gets 409 `VERSION_CONFLICT`).
  3. Open the per-requirement traceability (`GET /api/projects/:id/requirements/:reqId/traceability`) and link a requirement (`POST /api/requirements/:reqId/links`).
  4. Open `/workspaces/:id/traceability` (`GET /api/workspaces/:wid/traceability/summary`) and `/projects/:id/baselines`. As an admin, **New baseline** pins every requirement; make a second after an edit and **compare** them. A subset still needs `POST /api/projects/:id/baselines` `{name, requirementIds}`.
  5. **Request review** on the Requirements page for `coordinator` (a workspace member; see Setup order 3). It is listed on `/reviews`.
- **Works:** links persist, the workspace roll-up counts match (the moved project from Phase 5 appears in it), the baseline compare shows the edit, and `request-review-done` confirms the review.
- **Useful:**
  - The requirement "a user cannot subscribe to the same feed URL twice" traces to `unique (user_id, feed_url)` (`internal/database/migrations.go:69`) and to the feed validator in `internal/validator/feed.go` or `subscription.go`.
  - Approved requirements keep their acceptance criteria and code links (#730, #909). Report how many promoted requirements have none of each (run 3: 29/29 without criteria; run 4: 3/37).

### Phase 9 — Docs generation
- **Steps:** in `/projects/:id/documentation`, generate three documents with `POST /api/projects/:id/docs/generate` (rate limit is 5 per 15 minutes):
  1. `docType: business-requirements`, scope `full`;
  2. `architecture`, scope `repository`;
  3. scope `database`, which produces a schema graph.

  Then view versions and provenance (`…/docs/:docId/versions/:vid/provenance`), export (`…/export?format=`), regenerate (`…/regenerate`), and open the schema graph (`…/schema-graph`).
  - **Cancel once on purpose** (#855): start a **new** document, and after its first section finishes click **Cancel generation** (`POST /api/projects/:id/docs/:docId/cancel`). Regenerate it; the second attempt lists the sections it reused (#857).
  - **Regenerate** only works on a failed, cancelled, or degraded-with-no-version document; on a ready one it is refused. Test cancel and resume on a new document, never on the BRD.
- **Works:**
  - Statuses move `pending → generating → ready`, or `degraded` with warnings shown; never stuck in `generating` (statuses per `server/prisma/schema.prisma`: `pending|generating|ready|degraded|failed`).
  - Phase-1 progress renders.
  - Export downloads.
  - No section exceeds `DOCS_GEN_SECTION_MAX_CHARS` (60,000) and no body exceeds `DOCS_GEN_DOCUMENT_MAX_CHARS` (250,000); text is never cut mid-sentence (#741). A cancelled document leaves `generating` within a minute and keeps its finished sections.
  - The database document's model calls appear in the ledger under `docs-gen` (#858).
- **Useful:**
  - The BRD explains feed refresh scheduling (round_robin vs entry_frequency), retention (`CLEANUP_ARCHIVE_READ_DAYS`) and the integrations.
  - The architecture doc names the storage/api/ui/worker split.
  - The DB doc's schema graph shows the `entries → feeds → users` foreign keys.
  - Provenance links resolve to real lines.
  - **Baseline:** run 4's full-scope BRD cost **$1.91, took 30 min and was 171 KB** under a 500¢ `DOCS_GEN_MAX_RUN_COST_CENTS`. Run 3's was $8.73, 2 h 51 min and 2.19 MB.

### Phase 10 — Chat with citations
- **Steps:**
  1. In `/chat`, pick the project scope (`components/chat/project-scope-selector`) and ask the BA questions below (`POST /api/ai/stream`, sessions via `/api/ai/sessions`).
  2. Also try `/workbench`.
  3. Resume, fork and compact a session (`/api/ai/sessions/:id/resume|fork|compact`), and check `/sessions`.
  4. In one project-scoped session, ask BA question 1, then follow up with `Show me the exact lines for the first citation`.
- **Works:** answers stream, tool activity renders, there is no scope-degradation notice (unless retrieval is genuinely empty), and fork and compact keep the history.
- **Useful:** each BA answer carries **at least one correct `file:line` citation** into `v2.3.3`. Example: "What's the minimum password length?" → `internal/validator/user.go:163-164` (`len(password) < 6`). The follow-up keeps the earlier verified `file:line` and does not say it "had not actually read" the file (#773).

### Phase 11 — Discussions, presence, comments and mentions
- **Steps:**
  1. In `/projects/:id/discussions`, create a thread (`POST /api/discussions/threads`), post a message that mentions a second user, and ask for an AI reply (`POST …/threads/:id/ai-respond`).
  2. Open `/projects/:id/discussions/:discussionId` in **two browser contexts** to check presence. The harness classifier refuses `browser_run_code_unsafe` on a second context; plan this check with the operator, or verify presence from the database.
  3. Comment on a requirement and reply to it (`POST /api/requirements/:reqId/comments`, then `POST /api/comments/:threadId/replies`).
- **Works:**
  - Both users see each other's presence avatars (`components/presence/PresenceAvatars`).
  - The @mention picker offers only users who can open the project (#870).
  - The mentioned user gets a notification (`/api/notifications`) that names the author and opens the comment (#735).
  - Edit and delete work.
- **Useful:** the AI reply cites project sources and answers the thread's question about Miniflux.

### Phase 12 — Publishing (issues, PRs, batches) — sandbox only
- **Steps:**
  1. Point the publish destination at the sandbox repo (`PATCH /api/projects/:id/publish-destination`).
  2. In `/projects/:id/publish`, generate drafts (`POST …/publishing/drafts/generate`) and review the draft diff. Drafts from an import of more than 25 requirements open the requirement picker (`draft-requirement-picker`); pick 3.
  3. Preview a batch with **dry-run** (`POST …/publishing/batches/preview`), then publish one batch to the sandbox (`POST …/batches`). Archive a settled batch from its row (`archive-batch-<id>`) with a reason, leaving **Also close the issues** unticked.
  4. Publish one finding from the analysis (`POST …/findings/:fid/publish`). **Finding-publish has no dry run**: it publishes at once, so it counts against the sandbox cap.
  5. Check the review gate (`/api/projects/:id/review-gate`) and `/reviews`.
- **Works:**
  - The dry-run plan lists exact targets.
  - After a batch publishes, its draft is no longer selected and the next preview does not fail with `DRAFT_INELIGIBLE` (#863).
  - No draft title reads `[Feature] [Feature]: …`.
  - Nothing is created in `miniflux/v2`. Verify with `gh issue list -R miniflux/v2 --author @me`.
  - Sandbox issues exist and their links resolve.
- **Useful:** a published issue body has a clear title, the affected files and acceptance criteria that a developer could act on without opening METIS. Drafts from the Phase 6 GitHub import carry the upstream issue's acceptance criteria when it has an "Acceptance criteria" heading.

### Phase 13 — Drift, scheduler and tasks
Run this phase only after Phase 9's documents finish: a repo refresh during docs generation fails the document at commit (#856).
- **Steps:**
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
- **Steps:**
  1. In `/projects/:id/pulls`, open a recent merged Miniflux PR at `/projects/:id/pulls/:prNumber` (`GET /api/projects/:id/pr-reviews/:prNumber`).
  2. Click **re-review** (`POST …/:prNumber/re-review`). Do not post the review to GitHub.
  3. In `/projects/:id/changes`, run a change analysis (`POST /api/projects/:id/change-analyses`).
- **Works:** the review renders inline comments in METIS only, and the change analysis completes. The PR review step needs a public webhook; record it as blocked without one (runs 3 and 4).
- **Useful:** at least one review comment points at a real changed line and makes a substantive point, such as a missing test, an SQL error-handling gap or a migration ordering issue.

### Phase 16 — Impact analysis
- **Steps:** in `/impact-analyses/new`, run an impact analysis for each developer task below (`POST /api/impact-analyses`). Then open `/impact-analyses/:id`, rerun it (`…/rerun`), view drift (`…/drift`) and export (`…/export.md`). Do not run `publish/jira`. Impact analyses have no draft path, so there is nothing to dry-run.
- **Works:** the requirement impact matrix, the shared-table impact section and the drift section all render, and the export downloads. A stage degraded for want of structured output or tool calls is a finding (#754). Open the collapsed **Blast radius** group (`blast-radius-toggle`) before screenshotting the "Writes affected data" rows.
- **Useful:** see the developer tasks for the expected files, tables and columns. Impact on #4478 names Go callers reached through a receiver or field (for example `h.store.UpdateFeed(...)`) as probable call sites with `file:line`, not only tests (#774).

### Phase 17 — "Tested by" in traceability
Replaces the Test Coverage page, whose imports and runs were removed in #818 and #819 (epic #812, [ADR 0019](../decisions/0019-replace-test-coverage-with-tested-by.md)).
- **Steps:**
  1. Open the completed analysis's **Requirements** tab and expand the requirement "password ≥ 6 chars". Read its **Tested by** section. To check through the API, use `GET /api/projects/:projectId/requirements/:requirementId/traceability`, field `testedBy`.
  2. Open the analysis's **Traceability** tab. Read the matrix's **Tests** column and the **Untested requirements** list below it (`GET /api/projects/:projectId/traceability/test-gaps?analysisId=:id`).
  3. Open the workspace traceability rollup and read the project's **Tested** column. Hover it to see the strict figure.
- **Works:** the Tested by section, the untested list and the Tested column render, and no model call is made (the ledger delta for this phase is 0).
- **Useful:** "password ≥ 6 chars" lists `internal/validator/user_test.go` › `TestValidatePassword` under **Tested by**, with its relation label. Requirements that have mapped code but no test (for example OIDC role mapping) appear in the untested list. Requirements with no mapped code are counted as "no code mapped", not as untested. No test is listed only because it reaches a config hub, or only for its licence header (#860).

### Phase 18 — Usage and cost
- **Steps:**
  1. Open `/settings/usage?project=:id`. `/projects/:id/usage` redirects there (`ui/src/lib/legacy-routes.ts`).
  2. Check `GET /api/projects/:id/usage`, `GET /api/projects/:id/usage-summary` and `GET /api/projects/:id/token-breakdown`, and download the CSV (`…/usage/csv`).
  3. Open `/workspaces/:id/finops` → `/api/workspaces/:wid/finops/budget|rules|events`.
  4. Compare the Usage page, its **All projects** view and `GET /api/admin/usage` with the ledger queries in the skill.
- **Works:**
  - Usage rows exist for every phase.
  - **No Unpriced card** once `MODEL_PRICES` is set.
  - The CSV has a cost for each row.
  - All three views agree with `token_usages` (#854), and the ledger cost with the token-computed cost (#761).
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
  3. Check the admin APIs: `/api/admin/usage`, `/api/admin/token-budgets`, `/api/admin/cache-telemetry` and `/api/admin/auth`.
  4. Sign out from the account menu.
- **Works:** every legacy `/admin/*` URL redirects (`legacy-routes.ts`), and the admin pages load for an admin while showing 403 for a non-admin. Signing out lands on the plain sign-in page, not `/login?reason=expired` (#720). `/settings/auth` loads with no console error.
- **Useful:** cache telemetry shows DeepSeek cache reads, if DeepSeek reports them (#796).

## Spec Kit (Phase 14, in full)

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
| S1 | **Disabled state** | UI: the page before enabling. *API only:* `POST …/commands/speckit.specify` | `spec-kit-disabled-banner` shows and the palette is disabled; the API call returns **409 `SPEC_KIT_DISABLED`** | — |
| S2 | **Enable toggle** | UI: `spec-kit-toggle` (`PUT …/enabled {enabled:true}`) | Persists across a reload; the onboarding card shows | — |
| S3 | **Constitution** | UI: **Generate constitution.md** (`POST …/constitution`) | The success toast, not a warning; `constitution.md` v1 is selected in the viewer | **Grounded (#928):** principles name their sources (README, `go.mod`, contributing guide) and reflect Go stdlib-first, Postgres only, minimalism, no JS frameworks. A skeleton with a "nothing relevant ingested" warning is a FAIL, because Phase 3 ingested the README |
| S3b | **Read-only for non-editors** | UI: open the page as `developer` in a second context. *API only:* `POST …/commands/speckit.constitution` as `developer`, then `admin` | Every write control is disabled with the tooltip "Requires project.update" (#931); the API returns **403** for `developer` and 200 for `admin`. `speckit.constitution.write` no longer exists (#928) | — |
| S4 | **Specify** | UI: select **Project**, run `speckit.specify mark all entries as read older than N days` | Creates a feature and its `spec.md`; the toast reads `Generated spec.md (vN) for <slug> in T tokens — grounded on …` with **K > 0**, and job progress streams | The spec mentions the existing `Storage.MarkAllAsReadBeforeDate` (`internal/storage/entry.go:523`) and the Google Reader path that already uses it (`internal/googlereader/handler.go:1225`). A spec that says **"ungrounded (no project knowledge retrieved)"** is a FAIL |
| S5 | **Clarify** | UI: select the feature, run `speckit.clarify` | `clarify.md` appears under `specs/<slug>/` (`spec-kit-feature-tree`) | Its questions are real ambiguities: user-configurable N vs fixed presets, starred entries, per-feed/category scope, timezone |
| S6 | **Plan** | UI: `speckit.plan` | Writes 5 plan artifacts and says it is grounded, citing real `path:start-end` spans (#853); before `spec.md` exists there is a clear precondition error | It names `internal/api/entry_handlers.go`, `internal/ui/*` and `internal/storage/entry.go`, and states **no schema migration needed** |
| S7 | **Tasks** | UI: `speckit.tasks` | `tasks.md` is written; without `spec.md` and `plan.md` there is a precondition error | Tasks are ordered, testable and include Go tests |
| S8 | **Analyze** | UI: `speckit.analyze` | `analysis.md` is written | It flags any spec/plan/tasks inconsistency |
| S9 | **Implement handoff** | UI: `speckit.implement`, then **Start analysis with these artifacts**, once | `tokensUsed: 0`; the **handoff** card lists the artifacts; a missing artifact gives `Cannot /implement: missing …`. Starting the analysis creates a new run (never the Phase 7 run): record its ID and cost, with test custom agents disabled first | The handoff reaches the analysis orchestrator (`orchestratorRoute: /api/projects/:id/analyses`) |
| S10 | **Edit and save** | UI: **Edit** / **Save** / **Cancel** on `constitution.md` (project `.specify/` files only). *API only:* a body over 200,000 chars | The version increments; cancel changes nothing; the oversized body gets 400. Feature artifacts have no Edit button, by design | — |
| S11 | **Delete** | UI: **Delete** `clarify.md` in the feature, confirm | It leaves the feature tree; the toast names the file | — |
| S12 | **Comments and presence** | UI: **Comments** on `constitution.md` (`/api/projects/:id/spec-kit/artifacts/:artifactName/comments`), mention `coordinator`; presence in a second context | Comments and presence exist on project `.specify/` artifacts only. The mention notifies and opens the artifact's comments (#735) | — |
| S13 | **Suggestions** | UI: type `/` in the palette; type `/` in `/chat` | The palette suggests the **nine `speckit.*` commands**, not the six legacy names. `/chat` suggests no Spec Kit command (#931) | — |
| S14 | **Legacy alias deprecation** | *API only:* `POST …/commands/specify` | `Deprecation: true` and `Link: <…/commands/speckit.specify>; rel="successor-version"`. The palette maps a typed legacy name to `speckit.specify`, so the header is unreachable from the UI | — |
| S15 | **Feature list** | UI (S4 created it) | `GET …/features` and the Features selector list the feature | — |
| S16 | **Feature required** | UI: `speckit.plan` with **Project** selected. *API only:* the 400 | The page refuses before sending ("Select a feature first"); the API returns **400 `SPECKIT_FEATURE_REQUIRED`** without `featureSlug`, then 200 with it | It has the expanded plan sections |
| S17 | **Feature artifacts** | UI: list and read in the feature tree. *API only:* `PUT …/features/:slug/artifacts/*key` with `{content}`, and an unknown slug | Round trip OK; an unknown slug returns 404 `SPECKIT_FEATURE_NOT_FOUND` | — |
| S18 | **Status gates** | UI: the gate list in the Features panel (`spec-kit-feature-gates`); `GET …/features/:slug/status` | `spec`, `plan`, `tasks` and `implement` gates match what exists | — |
| S19 | **Checklists** | UI: **Generate checklists** right after S4, before `speckit.plan`, and again after it. *API only:* adding a reviewer line to a checklist (feature artifacts have no Edit) | **412** before `plan.md`, its message shown in `spec-kit-error`. After: five domain checklists (security, performance, accessibility, observability, testability). Re-run (merge is the default): the reviewer's line and its tick survive below the regenerated items (#925) | The items are specific to this feature, for example a bounded `UPDATE` on `entries` or an index on `published_at` |
| S20 | **Namespaced commands** | UI (S5–S9 already ran them) | Same results as the legacy commands, with no `Deprecation` header | — |
| S21 | **Issue export** | UI: **Preview issue export (dry run)**, then **Publish issues to the saved target** (`openzigs/flux-v2` only) | The dry run lists the issues it would create; the publish button stays disabled until a dry run of the current `tasks.md`. **The real export returns 501 until #936 lands**: don't spend sandbox slots on it, and record the 501 against #936 | Issue bodies map one-to-one to tasks |
| S22 | **Archive and restore** | UI: **Archive**, tick **Show archived**, **Restore** (`POST …/features/:slug/archive`, then `…/restore`) | Hidden from `GET …/features`, shown with `?includeArchived=1`, then back | — |
| S23 | **Install** | *API only:* `POST …/spec-kit/install` | **501 `SPECKIT_ATTACHED_WORKSPACE_NOT_IMPLEMENTED`**. This is expected; do not file it | — |
| S24 | *(Optional; needs a public webhook)* **Issue sync** | Close a sandbox issue made by S21 (`routes/webhooks-github.ts` → `syncIssueEvent`, #433) | The matching `tasks.md` item is ticked | — |

## Persona scenarios

### Business Analyst: questions METIS should answer, with citations

Ground truth is at `miniflux/v2@v2.3.3`. Ask each question in `/chat` (project scope) **and** check it against the BRD from Phase 9. **Pass** = correct answer **and** at least one correct `file:line` citation.

Over the chat API (the BA re-ask), `inspect_schema` and `query_database` are refused with `no_interactive_approver`, so database-backed answers fall back to source; record the refusals, they are not failures. `search_code_graph` does not index string-literal config keys, so a question about an option such as `POLLING_SCHEDULER` is answered from retrieval, not the graph.

1. **What are the rules for creating a user account (username and password)?** Expect: password at least 6 characters (`internal/validator/user.go:163-164`), username rules in `validateUsername` (`:176`), and uniqueness of `username` (`internal/database/migrations.go:25`).
2. **How does Miniflux decide when to refresh a feed next, and what can an admin configure?** Expect: `Feed.ScheduleNextCheck` (`internal/model/feed.go:123`) and the `POLLING_SCHEDULER` option, round_robin vs entry_frequency (`internal/config/options.go:511`).
3. **When are old articles removed, and what controls it?** Expect: `runCleanupTasks` (`internal/cli/cleanup_tasks.go:16`) calling `ArchiveEntries` for read and unread entries (`internal/storage/entry.go:368`), and `CLEANUP_ARCHIVE_READ_DAYS` / `CLEANUP_ARCHIVE_BATCH_SIZE` (`options.go:126,134`). The answer must say that starred entries are exempt (`starred is false` in the SQL of `ArchiveEntries`, verified in run 2).
4. **What happens to a feed that keeps failing?** Expect: `parsing_error_count` and `POLLING_PARSING_ERROR_LIMIT` (`options.go:503`), counted in `internal/storage/feed.go:117`.
5. **Can a user subscribe to the same feed twice, or have two categories with the same name?** Expect: no; `unique (user_id, feed_url)` and `unique (user_id, title)` (`migrations.go:69,52`).
6. **Which ways can users and third-party apps sign in or authenticate?** Expect: password sessions, OAuth2/OIDC (`internal/oauth2`), WebAuthn/passkeys (`internal/storage/webauthn.go`), API keys (`internal/storage/api_key.go`), and the Fever and Google Reader APIs (`internal/fever`, `internal/googlereader`).
7. **Which third-party services can saved articles be sent to?** Expect: an enumeration matching `internal/integration/*` (31 entries at the tag) and `internal/model/integration.go`.
8. **Draw the core data model.** Expect: an ER diagram with users → categories → feeds → entries → enclosures, plus icons and api_keys, that matches the DB connector's inspect output.

### Developer: real open Miniflux issues

These three issues were open on 2026-10-02. For each one:
1. Ask chat "where would I implement this?".
2. Run **impact analysis** (Phase 16).
3. Run Spec Kit `speckit.specify` → `speckit.plan` (#4478 is done in the Spec Kit section; repeat it briefly for the other two).
4. Draft an issue or PR into the **sandbox** (Phase 12), only if the run's cap of 2 is not used up.

| Issue | What METIS must surface (Useful) |
|---|---|
| [#4478 "Mark all as read older than X"](https://github.com/miniflux/v2/issues/4478) | **That the storage method already exists:** `Storage.MarkAllAsReadBeforeDate` (`internal/storage/entry.go:523`), reached today only through the Google Reader API (`internal/googlereader/handler.go:1225`). So the plan is to expose it through the REST API (`internal/api/entry_handlers.go`) and the web UI. **No migration.** If METIS proposes new SQL or a new column, mark it **weak** (runs 3 and 4 still proposed a `users` column, #791). |
| [#4511 "Last successful refresh in feed API"](https://github.com/miniflux/v2/issues/4511) | Needs a **new migration** appended in `internal/database/migrations.go`, a field on `model.Feed` (`internal/model/feed.go`), a write in `UpdateFeed` (`internal/storage/feed.go:331`, beside `checked_at` and `parsing_error_count` at :342-344) and in the error path (`:437-438`), plus the API JSON. Impact must name table `feeds`, the new column, and the API and Google Reader/Fever consumers. |
| [#4336 "Add read_at timestamp to entries"](https://github.com/miniflux/v2/issues/4336) | A migration on `entries`, and **every status-change path**: `SetEntriesStatus` (`entry.go:412`), `SetEntriesStatusAndCountVisible` (`:431`), `MarkAllAsRead` (`:506`), `MarkAllAsReadBeforeDate` (`:523`), and the Fever and Google Reader handlers. Impact must list all of them; **missing two or more counts as weak**. |

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
- [ ] Spec Kit S1–S23 each have a verdict (S24 optional). Every artifact in `SPEC_KIT_ARTIFACT_NAMES` was produced, edited and viewed. Every `SPECKIT_COMMANDS` entry was invoked at least once.
- [ ] `speckit.specify` and `speckit.plan` report **grounded on K > 0 retrieved chunks**.
- [ ] 8/8 BA questions answered. Pass bar: **at least 6 correct with valid citations**.
- [ ] 3/3 developer issues have an impact analysis, a plan, and a sandbox draft. For #4478, METIS surfaces `MarkAllAsReadBeforeDate`.
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
