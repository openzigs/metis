---
issue: 838
section: Security
---

- The workspace traceability summary computes at most four projects at a time
  (`TRACEABILITY_ROLLUP_CONCURRENCY`) instead of all of them at once.
- The analysis traceability matrix and the analysis report export are rate-limited:
  300 requests per user per 15 minutes by default (`ANALYSIS_MATRIX_RATE_LIMIT_MAX`).
