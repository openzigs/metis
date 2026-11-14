---
name: ci-signals-2026-11-14
description: CI reading traps - api-outcome green on a cancelled api, --watch exiting early, conflicting PRs get no CI, POSTGRES_PATTERNS, e2e flake traces (#2483, #2486, #2496, #2502).
metadata:
  type: project
---

Adds to CLAUDE.md's "three ways the signal lies"; does not repeat it.

- **api-outcome is green for ANY cancelled api** (#2502), including a 40-minute timeout, not only a supersede. Beside a red/cancelled `api` check, run `gh run list --branch <b>` for a newer run and read the api job's duration and steps.
- **Confirm api really passed** (#2502): `gh run watch <run-id>`, then read the api job conclusion. `gh pr checks --watch` exited 0 twice with api mid-build.
- **A PR conflicting with main gets no `pull_request` CI** (#2486), only the `pull_request_target` CLA check. An empty or one-check `gh pr checks` after a push means check mergeability first.
- **New `*-postgres.integration.test.ts`** (#2496): every `server/src` file it imports must be in `POSTGRES_PATTERNS` (`scripts/lib/ci-changes-core.mjs`), or `ci-changes-repo.test.mjs` fails the api job.
- **e2e flakes leave no first-attempt trace** (#2483: `trace: on-first-retry` under `--fail-on-flaky-tests`; a re-run hides attempt 1). Read it with `gh api .../actions/runs/<id>/attempts/1/jobs`, then `actions/jobs/<id>/logs`. A short `expect` running to the whole-test timeout means a wedged renderer.
