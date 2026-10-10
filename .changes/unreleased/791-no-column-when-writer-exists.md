---
issue: 791
section: Fixed
---

- An impact analysis no longer proposes a new column that only restates an operation the code
  already performs. "Mark all as read older than X days" sometimes drew
  `ALTER TABLE users ADD COLUMN mark_read_older_than_days` even though `MarkAllAsReadBeforeDate`
  already does it. Each proposed column is now checked against the functions that write the
  affected data. The column is dropped when its name says nothing beyond one of those functions
  and that function matches the request. This check does not depend on how the model answered.
