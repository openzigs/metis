---
name: check-set-read-timing
description: When a PR's check set is really complete — CodeQL is created late and finishes early; e2e-outcome can pass while a shard is pending; Check CLA skips on maintainer PRs.
metadata:
  type: project
---

Measured across PR heads, 2026-10-16/17 (#1217 re-review, then every PR from #1222 to #1234).

**CodeQL.**
- The `CodeQL` check-run is created after the Analyze jobs start, so a green read without `CodeQL` in it was taken too early.
- It finishes before `Analyze javascript-typescript` (6 of 6 heads), so a green `CodeQL` does not mean Analyze is done. Wait for all three.

**e2e.** `e2e-outcome` once read `pass` while `e2e (1/3)` was still pending. Don't trust `e2e-outcome` alone while any shard is pending.

**Expected skips.**
- `Check CLA signature` skips on every maintainer PR (`cla.yml:68`).
- `build` and `deploy` from the docs workflow also appear when a docs-site path changes, giving 23 rows. `build` should pass and `deploy` skip.

**Correcting a fact in one place.** When you correct a CI or tooling fact in one skill, `git grep` the old claim across every skill, agent and instruction file. Fixing one copy turns a consistent error into two contradicting skills.

- `generative-e2e` failing with the Chat page `h1` hidden and "disk full" in the runner log is infrastructure: confirm `main` passed at the base, then re-run once (#1260).

- **22 checks, not 21, when `real-model-worker` runs** (2026-10-20). It is path-filtered (`embed-real-model-nightly.yml:23-37`: `pnpm-lock.yaml`, `pnpm-workspace.yaml`, server/embeddings package manifests, the embed sources and tests), so any lockfile or workspace change adds it. `Check CLA signature` reads `skipping` on owner PRs (`cla.yml:68-73`, author `mgcronin`).

- **Waiting from an isolated worktree** (PR #1316): Bash there refuses `sleep N` chained before another command. Wait with `timeout 570 gh pr checks <pr> --watch` on its own, then re-read.

- **A PR whose base moved with conflicts gets zero `pull_request` workflow runs** (#1308): `gh pr checks` then shows only the CLA check, which reads like a queue. Check `gh pr view <pr> --json mergeable` before waiting on CI.

- **`postgres-adapter` ran at its timeout** (#1365): 13.5-14.8 min on `main` against
  `timeout-minutes: 15`. A `fail` whose job conclusion is `cancelled` at ~15m and with no
  `Test Files … failed` line was the timeout, not a test failure. #1400 raised it to 25 min
  (`ci.yml`, comment above the job); if it reads cancelled near 25 min, the same applies.
- **`repo-connector-followups-475.sqlite.test.ts`** once saw no `users` table in `beforeAll`
  under the full `pnpm test` fan-out and passed alone (#1359, #1364). A `beforeAll`
  `Test Files 1 failed` is real; never re-run it away.
- **Extra rows:** `ldap-harness.yml` runs only when `ldap-provider.ts` or the harness paths
  change (#1400); a `workflow_dispatch` of `ci.yml` on a PR branch attaches a Trivy check to
  the PR head (#1392).

## Folded here (retired from the index 2026-10-21; files unchanged)

- [[project_cancelled-no-runner-checks]] — a red check with 0 steps and a log 404 was cancelled in the queue, not failed: re-run; stuck `in_progress` for hours: `gh pr update-branch`.
- [[image-budget-rationale-lives-in-three-places]] — the server image-budget rationale lives in `docs/OPERATIONS.md` and two comments (`verify-image-size.mjs`, `ci.yml`); an instance of "Correcting a fact in one place" above.
