---
name: stuck-ci-run-update-branch
description: A CI run whose jobs read in_progress with zero steps for hours cannot be cancelled or re-run; gh pr update-branch starts a fresh run.
metadata:
  type: project
---

On PR #619 (2026-10-01), run 36802739278 showed `api`, `server` and `e2e` as `in_progress` for two hours with no steps at all. Both `gh run cancel` and the force-cancel API answered "not in progress", and `gh run rerun` answered "already running".

**Why:** GitHub's run state was inconsistent, and the run could not be cancelled or re-run through any API.

**How to apply:** if a job has no steps long after `startedAt`, run `gh pr update-branch <pr>`. That makes a new head and a fresh CI run. Re-gate on the new SHA.
