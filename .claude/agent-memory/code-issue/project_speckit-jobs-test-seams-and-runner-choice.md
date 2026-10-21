---
name: speckit-jobs-test-seams-and-runner-choice
description: Spec Kit commands that call the model run as jobs (#1059). What every test of the Spec Kit router now needs, how to make a "slow model" test deterministic, and why background_runs is the wrong home for user-triggered model work.
metadata:
  type: project
---

Since #1059 `POST /spec-kit/commands/:cmd` runs a model-backed command through `startSpecKitJob` and awaits it, so the route writes `spec_kit_jobs` rows even on the synchronous path.

**Why it matters:** three existing suites went red the moment the route changed, each for a different reason that looked like a product bug (a 500 where a 409 was expected).

**How to apply:**

- **The fake store is not evidence about the real one.** Since the review of PR #1105 the runner's rules live in `tests/helpers/spec-kit-job-rules.ts` and run on the fake AND on the real store over SQLite; the store's statements are held to `tests/helpers/spec-kit-job-store-contract.ts` on the fake, SQLite and Postgres. Add a rule or a predicate there, not in one suite. See [[project_heartbeat-sweep-tables-db-commit-and-one-clock]].
- **There is no `_resetSpecKitJobs` export.** Tests stop leftover jobs with `tests/helpers/spec-kit-jobs-reset.ts`, which reaches `job-registry.ts` directly.
- **`specKitJobCommitPoint()` is async** (it is a database transition): a command that forgets to `await` it writes before it is allowed to.
- **A suite that stubs Prisma and drives the Spec Kit router needs the job table.** Mock the store, not the runner: `vi.mock("../src/lib/spec-kit/job-store.js", async () => (await import("./helpers/spec-kit-job-store-fake.js")).fakeSpecKitJobStore)`. The fake keeps the two properties the runner relies on (unique `activeKey`, compare-and-set state changes). Suites that needed it: `tests/spec-kit-routes.test.ts`, `tests/project-provider-routing.test.ts`, `src/routes/spec-kit-route.test.ts`.
- **A whole-module `vi.mock` of `spec-kit/features.js` breaks the router import** as soon as the router reads a constant from it (`SPECKIT_FEATURE_SLUG_RE`): vitest throws on the missing export. Spread `importOriginal` first. Same family as [[project_whole-module-vi-mock-stubs-500-at-runtime]].
- **Do not sleep to simulate a slow model.** The SQLite suite's stub provider parks each `chat()` call in `state.pending` and the test answers it (`nextCall().resolve(...)`). "Mid-flight" is then a state, not a duration, and nothing bounds wall-clock time. `ignoreAbort` makes the stub answer after a cancel, which is how the late-reply cases are reached.
- **To prove "nothing happened afterwards", observe the refusal, not the silence.** The suite wraps `specKitJobCommitPoint` and `throwIfSpecKitJobStopped` (via `importOriginal`) to record each refusal, then waits for one. A fixed sleep followed by "no artifact was written" passes vacuously when the zombie command is merely slow; two mutations survived until the refusal was observed.
- **`pnpm --filter @metis/server db:gen-postgres` fails**: the script resolves `server/prisma/...` from the repo root. Run `bash scripts/gen-postgres-schema.sh` from the root.

**Why not `background_runs`:** its `recoverStaleRuns` sets a stale `running` row back to `queued` and the runner dispatches it again. For work a user triggered and pays for, a restart must fail the run, never repeat it (docs-gen made the same call in #50). `spec_kit_jobs` follows docs-gen: heartbeat, sweep, fail as interrupted.
- (#1308) A SQLite route test running several live Spec Kit exports passes `SPECKIT_EXPORT_LIVE_LIMIT_MAX` (10 per user) once retries start, and unrelated tests then get 429. Raise the limit in the test's hoisted env.

**Folded here (retired from the index 2026-10-21; files unchanged):**

- [[heartbeat-sweep-tables-db-commit-and-one-clock]] — Job tables: DB commit + one clock: in-memory stop misses replicas (#1059)
