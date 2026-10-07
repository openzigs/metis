---
issue: 593
section: Security
---

- A Jira update that rotates the connection's own credential in place and
  then fails (a later vault write, a concurrent edit, or the row write) now restores the previous
  credential, audited as `vault.rotate` with `source: update_not_applied`. A restore never
  overwrites a value written after the rotation. A rotation that keeps losing a race now returns
  409 `CONCURRENT_UPDATE` instead of 500.
- Known limit: the undo is per request. When two same-owner updates both rotate and both fail, the
  second's undo can restore the first failed request's value; the row-level concurrency guard
  makes this rare.
