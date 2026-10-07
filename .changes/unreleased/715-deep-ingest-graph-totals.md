---
issue: 715
section: Fixed
---

- The Deep Ingest banner and the Sync panel now report the code graph's size
  (files, symbols, edges) and label this run's incremental re-parse as changed
  files, instead of showing the delta as if it were the total. A second ingest
  of an unchanged repository read "0 of 655 files parsed, 0 symbols"; it now
  reads "code graph of 421 files, 4252 symbols, 28636 edges (0 changed files
  re-parsed, 421 unchanged)".
