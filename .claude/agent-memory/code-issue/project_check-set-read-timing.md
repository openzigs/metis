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
