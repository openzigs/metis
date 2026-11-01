---
issue: 1622
section: Added
---

- METIS can check one requirement against every product in scope (one product,
  or all you can access) and say which product covers it, covers part of it,
  or that nothing in the portfolio does, naming the repos and code that show it.
  A product you cannot read reads restricted, with nothing about it, and a repo
  that could not be checked reads "not checked", never "not covered". Cost caps
  and a concurrency limit bound each run (`PORTFOLIO_GAP_RUN_COST_CAP_CENTS`,
  `PORTFOLIO_GAP_PRODUCT_COST_CAP_CENTS`, `PORTFOLIO_GAP_CONCURRENCY`).
