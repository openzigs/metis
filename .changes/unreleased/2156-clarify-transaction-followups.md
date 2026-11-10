---
issue: 2156
section: Changed
---

- No change in behaviour. Internal only: the clarify submit transaction's code comment now states
  its lock order correctly, and six server test suites share one in-memory fake of the dialog
  store's compare-and-set writers, with its own test, so the copies cannot drift apart.
