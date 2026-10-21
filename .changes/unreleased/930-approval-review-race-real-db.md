---
issue: 930
section: Changed
---

- Two reviewers deciding the same approval at once are now tested against real SQLite and
  Postgres databases, not only an in-memory stand-in: one decision is kept and the other is
  told the item was already reviewed.
