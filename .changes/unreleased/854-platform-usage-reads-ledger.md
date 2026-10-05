---
issue: 854
section: Fixed
---

- The **All projects** usage view, its CSV export and `GET /api/admin/usage` now
  read the project usage ledger (`token_usages`), as the project view already
  did. They read `ai_token_usages`, which holds only chat and a few tool calls,
  so platform spend was understated by about 99%. The two tables are never
  summed, because chat writes each call to both.
- The monthly chargeback report's per-user lines read the same ledger, so they
  add up to the per-project total. Spend with no known user is listed as
  "Unattributed".
