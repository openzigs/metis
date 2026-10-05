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
