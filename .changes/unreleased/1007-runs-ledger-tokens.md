---
issue: 1007
section: Fixed
---

- A run's tokens now read the usage ledger everywhere they are shown (the analysis run list and
  header, `/runs` and a run's page) as two named figures, with and without cache. A run that is
  going shows its total so far, or "in progress", instead of "0 tok".
- A run's cost is one figure on `/runs`, the run's page and the analysis header: the cost the
  ledger recorded, headed "Cost (as recorded)", with unpriced tokens named, not re-priced.
- `/runs` lists your own chat turns from the usage ledger (owner only, administrators too), with
  a "Session totals" table that adds each session's sub-agent, apply-diff and summary calls.
- `/api/runs` is rate limited per signed-in user (`RUNS_LIMIT_MAX`); `?limit=abc` is no longer
  a 500.
