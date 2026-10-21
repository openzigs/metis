---
issue: 1116
section: Security
---

- Every background-run, run-group and steering route under `/api/runs` is now
  rate limited per signed-in user. Reads share the Runs page's budget
  (`RUNS_LIMIT_MAX`, 3000 per 15 minutes); writes have a smaller one of their
  own (`RUNS_WRITE_LIMIT_MAX`, 300 per 15 minutes).
