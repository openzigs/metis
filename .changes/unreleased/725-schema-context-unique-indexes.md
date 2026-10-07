---
issue: 725
section: Fixed
---

- The live-schema summary the analysis database agent reads now lists each
  table's unique constraints and unique indexes (for example
  `unique: (user_id, feed_url)`). It used to show only columns and foreign keys,
  so the agent reported constraints that exist in the database as missing, as
  high-severity findings.
