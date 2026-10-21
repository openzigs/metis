---
name: gh-checks-shard-stuck-pending
description: An e2e shard check can read pending for 15+ min after every step succeeded (GitHub job-status desync); read the job's steps (#1347).
metadata:
  type: project
---

On PR #1347, `gh pr checks` showed `e2e (1/3)` and `e2e (3/3)` as `pending` (job `status: in_progress`, no `completed_at`) for 15+ minutes, while the run was `completed/success`, `e2e-outcome` had passed and every step of both jobs, including "Run Playwright e2e suite" and "Complete job", read `success`.

**Why:** GitHub's job status lagged its steps. It resolved by itself, and a later `gh pr checks --watch` re-read showed both shards as `pass`.

**How to apply:**

- Before re-running a "pending" shard, read `gh api repos/<o>/<r>/actions/jobs/<id> --jq '[.steps[]|.name+"="+(.conclusion//"null")]'`.
- If every step succeeded, wait and re-read. Do not re-run, and do not report green until the plain re-read shows zero pending.
