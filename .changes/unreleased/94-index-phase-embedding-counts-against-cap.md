---
issue: 94
section: Changed
---

- Documented that a test-coverage run's **indexing** pass is charged to the same budget cap as its
  judge and suggestion phases. On a large cold corpus with a priced cloud embedder that pass alone
  can reach the cap, so the run stops before judging with almost nothing judged. Raise
  `TESTCOVERAGE_BUDGET_CENTS` for the first run over a large corpus, or use a built-in local
  embedder, which costs nothing.
