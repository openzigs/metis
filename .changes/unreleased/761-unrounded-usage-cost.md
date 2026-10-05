---
issue: 761
section: Fixed
---

- Usage cost no longer rounds each model call to a whole cent. A new
  `token_usages.costUsd` column stores every call's exact cost. Usage pages,
  budgets, forecasts, the chargeback report and exports add up the exact costs
  and round only the total. `costCents` is still written for compatibility.
- The migration fills `costUsd` for existing rows from `costCents / 100`, so
  calls recorded before the upgrade keep their per-call rounding.
- The chargeback report and the workspace daily rollup also count rows that have `costCents` but no `costUsd`, such as rows an older server writes during a rolling upgrade.
- A cost projection no longer rounds float noise up into an extra cent, which could trip an autopilot cost ceiling set one cent above the real projection.
- Upgrading a large Postgres deployment: see OPERATIONS.md §6.3 to run the `costUsd` backfill in batches first.
