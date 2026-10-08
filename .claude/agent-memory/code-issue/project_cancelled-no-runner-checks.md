---
name: project_cancelled-no-runner-checks
description: Red checks on cloud PRs are often jobs cancelled before a runner — 0 steps, log 404; re-run, esp. postgres-adapter
metadata:
  type: project
---

On the 2026-10-05 cloud-session PRs (#877–#902), 9 of 13 red non-CLA checks in one group were jobs cancelled before any runner was assigned: `runner_name` empty, 0 steps, logs API 404 BlobNotFound, annotation "job was not acquired by Runner". Not code failures.

**Why:** hosted-runner queue starvation; the job hits its timeout in the queue.

**How to apply:** check `gh run view <id> --json jobs` steps length before reading logs, then re-run (or `gh pr update-branch`). Treat a never-run `postgres-adapter` as unproven, not green — a PR's own Postgres test may never have executed.
