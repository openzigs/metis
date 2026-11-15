---
issue: 2171
section: Security
---

- The window of the per-card approval review limit can be set with
  `ANALYSIS_APPROVAL_REVIEW_RATE_LIMIT_WINDOW_MS` (default 15 minutes), as for the
  checkpoint's other limits. Each approval limit counts separately: using up the review
  limit does not stop the same reviewer from reopening, editing or promoting.
