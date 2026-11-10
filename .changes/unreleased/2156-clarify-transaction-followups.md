---
issue: 2156
section: Changed
---

- No change in behaviour. The clarify submit transaction's code comment now states its lock order
  correctly: deleting an analysis or its project takes the two locks the other way round, so a
  submit racing a delete can deadlock, and Postgres aborts one of them whole. Six server test
  suites now share one in-memory fake of the dialog store's compare-and-set writers, with its own
  test, so the copies cannot drift apart.
