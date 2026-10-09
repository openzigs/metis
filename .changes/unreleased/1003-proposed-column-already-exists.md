---
issue: 1003
section: Fixed
---

- An impact analysis no longer proposes `ADD COLUMN` for a column the table already has. Each
  proposed column is now checked against the live database schema and the indexed code, not only
  the columns the impacted code touches, so `entries.published_at` is no longer suggested as new.
  The proposal step is also told that a value a user supplies when running an action ("older
  than N days") is not data that needs its own column.
