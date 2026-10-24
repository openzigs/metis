---
issue: 1497
section: Security
---

- `GET /api/run-reviews/:runId`, readable by every role since #1472, is now
  rate-limited. It uses the same limits as the project PR-review pages, before
  and after sign-in, and shares one per-user budget with them
  (`PR_REVIEWS_LIMIT_MAX`, default 600 per 15 minutes).
