# `@metis/e2e` — Playwright suite

End-to-end browser tests for METIS: ~590 specs across `tests/`, driving the real
API + Next.js UI. Two are worth naming as the entry points:

| Spec                      | Coverage                                                            |
| ------------------------- | ------------------------------------------------------------------- |
| `tests/smoke.spec.ts`     | `/healthz` reachability + bare login/project plumbing (smoke)        |
| `tests/full-flow.spec.ts` | project → upload → analyze → publish-dry-run → schedule → cancel     |

**The whole suite runs on every pull request** (the `e2e` job in
`.github/workflows/ci.yml`). It used to be gated behind an `E2E_ENABLED` repo
variable that was never set; by the time anyone looked, ~150 specs were failing
on `main` (#62).

## What the harness can and cannot do

The suite is deterministic and makes **no outbound network calls**. Two
consequences bite when writing a spec:

- **The `offline-stub` AI provider returns hash-derived PROSE, never JSON.**
  Every analysis specialist agent rejects it, so a live analysis run always ends
  `failed` — and anything downstream of a *completed* analysis (draft
  generation, change analysis, the capability banner) cannot be reached by
  running the pipeline. Seed a completed snapshot instead:
  `seedGroundedAnalysisViaCli` / `seedCompletedAnalysis`
  (`fixtures/seed-helpers.ts`, `fixtures/review-helpers.ts`).
- **A spec that truly needs a live model must say so.** Use
  `test.skip(isOfflineAiStub(), OFFLINE_AI_SKIP_REASON)` from
  `fixtures/ai-mode.ts` — the report then shows the test as skipped *with the
  reason*. Point `AI_PROVIDER` at a real provider to run those specs. Never
  call a bare `test.skip()` at runtime for a missing surface: that reports as a
  pass. Use `test.fixme("…")` with an issue number instead.

## Run locally

```bash
# From the repo root
pnpm install --frozen-lockfile
pnpm --filter @metis/e2e exec playwright install chromium  # first time only
pnpm --filter @metis/e2e test
```

The first run takes ~2–3 minutes because it boots the API + UI from scratch
and applies all Prisma migrations to a fresh SQLite database.

### What gets started

`playwright.config.ts` boots two servers via the `webServer` block:

| Server | Port | Command |
| ------ | ---- | ------- |
| API    | 4101 | `pnpm --filter @metis/server exec tsx src/index.ts` |
| UI     | 3101 | `pnpm --filter @metis/ui exec next dev -p 3101` |

These ports are intentionally separate from the dev stack on `:4000` / `:3000`
(see `scripts/restart.sh --detached`) so `pnpm --filter @metis/e2e test` is
safe to run while a developer has the dev stack running.

### Test database + data dirs

`global-setup.ts` runs once before any test:

1. Wipes `e2e/test-results/stack-data/` (or `$E2E_DATA_DIR`).
2. Creates fresh `uploads/` and `lancedb/` subdirs.
3. Runs `prisma migrate deploy` against the fresh SQLite file.

The Express server is then started with:

- `DATABASE_URL=file:.../metis-e2e.db`
- `UPLOAD_DIR=...` and `LANCEDB_PATH=...` pointing at the isolated dirs

so each test run starts from a known-clean state and never touches the dev
SQLite file in `server/prisma/dev.db`.

## Stubbing strategy

### AI provider — `offline-stub` (in-process)

The webServer block exports `AI_PROVIDER=offline-stub` and `AI_OFFLINE=1`,
which routes every chat/embed call through
`server/src/lib/ai/providers/offline-stub-provider.ts`. The stub returns
deterministic, hash-derived responses so:

- analysis runs complete in O(ms) per agent
- the embedder (`server/src/lib/rag/embedder.ts`) uses `HashEmbedder`
  instead of downloading a Xenova model
- no outbound network call to OpenAI / Anthropic / Bedrock can possibly fire

There is no Playwright `route()` interception for AI traffic — we don't need
it because the stub lives in-process. The only `route()` interception in the
suite is a sentinel on `api.github.com` during the publish dry-run step, used
to *prove* the dry-run path made no GitHub calls.

### GitHub — never called

The publish step uses `dryRun: true`. The publisher
(`server/src/lib/publishing/publisher.ts`) explicitly short-circuits before
any external resolution (DNS, allow-list, Octokit) when `dryRun` is set, so
no Octokit instance is even constructed. The test asserts this by routing
all `api.github.com` traffic to `route.abort()` and asserting zero hits.

### Auth — real `POST /api/auth/login`

Login is driven through the real Next.js login form. The mock auth provider
(`server/src/lib/auth/mock-provider.ts`) accepts `admin / password` and the
`/api/auth/login` route upserts the matching `User` row on first login.
`fixtures/seed-user.ts` documents the credential contract and primes the
row before the test body runs.

## Useful flags

```bash
# Run a single spec
pnpm --filter @metis/e2e test tests/full-flow.spec.ts

# Headed mode while debugging
pnpm --filter @metis/e2e e2e:headed

# Open the Playwright UI runner
pnpm --filter @metis/e2e e2e:ui

# Reuse an already-running stack (skip `webServer` boot)
E2E_SKIP_WEBSERVER=1 \
  E2E_API_BASE=http://127.0.0.1:4101 \
  E2E_BASE_URL=http://127.0.0.1:3101 \
  pnpm --filter @metis/e2e test

# Surface quarantined specs (default run skips them)
pnpm --filter @metis/e2e test --grep @quarantine

# Run the specs that need a live model too (they self-skip by default)
AI_PROVIDER=anthropic pnpm --filter @metis/e2e test   # any real provider
```

## Canonical API + UI base URLs (#183)

The suite uses **4101 (API) / 3101 (UI)** as the canonical default port pair —
deliberately distinct from the dev stack (`4000/3000`) and the older smoke
ports (`4100/3100`) so a developer can run `pnpm dev` and the e2e suite
side-by-side without a port collision.

Every spec resolves its base URL through `e2e/fixtures/api-base.ts`:

```ts
import { apiBase, uiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();   // → http://127.0.0.1:4101
const UI_BASE = uiBase();     // → http://127.0.0.1:3101
```

Env var contract (highest precedence first):

| Helper     | Full URL env var | Port-only env var | Default                  |
|------------|------------------|-------------------|--------------------------|
| `apiBase()`| `E2E_API_BASE`   | `E2E_API_PORT`    | `http://127.0.0.1:4101`  |
| `uiBase()` | `E2E_BASE_URL`   | `E2E_UI_PORT`     | `http://127.0.0.1:3101`  |

Do **not** read `process.env.E2E_API_BASE_URL` — that variable name is dead.
The helper exists to prevent the kind of port + env-var-name drift fixed in
issue [#183](https://github.com/openzigs/metis-private/issues/183).

## Layout

```
e2e/
├── fixtures/
│   ├── api-base.ts       # apiBase() / uiBase() helpers (#183)
│   ├── sample.md         # Markdown upload fixture
│   ├── sample.pdf        # Minimal valid PDF (~600 bytes) — committed binary
│   └── seed-user.ts      # Mock-admin credentials + prime helper
├── pages/                # Page Object Model — one file per UI surface
│   ├── login.page.ts
│   ├── project.page.ts
│   └── scheduler.page.ts
├── tests/
│   ├── smoke.spec.ts
│   └── full-flow.spec.ts # Issue #144
├── global-setup.ts       # Wipes + migrates the test SQLite database
├── playwright.config.ts
└── README.md             # ← you are here
```
