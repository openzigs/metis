---
issue: 2569
section: Added
---

- The analysis code pass now has a dollar limit, `ANALYSIS_CODE_PASS_MAX_USD` ($1.00 per
  requirement by default, `0` turns it off), in both the fast and the explore mode. A pass that
  reaches it stops, keeps what it found, and marks the requirements it did not settle "Could not
  verify", never as gaps; the run says so in its limitations banner and offers "Continue with a
  larger budget". A model METIS has no price for is never counted as free: the pass is held to its
  token budget and the run records that its cost could not be priced.
- An analysis, a regenerate, a Continue and a repository resume are now refused (HTTP 402
  `BUDGET_EXCEEDED`) while the project is over its own monthly token budget, as chat already is. A
  scheduled re-run of an over-budget project fails once and is not retried.
