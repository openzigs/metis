---
issue: 593
section: Security
---

- A Jira or test-management connection update that rotates the connection's own credential in
  place and then fails part-way — a later vault write, a concurrent edit of the same connection,
  or the row write itself — now puts the previous credential back. The request reported failure,
  but the stored API token, Xray client id/secret, Zephyr or TestRail key, or TLS CA certificate
  had already changed. Each restore is audited as `vault.rotate` with
  `source: update_not_applied`, and it never overwrites a value written after the rotation.
- Known limit: the undo is per request. When two updates by the same owner both rotate the same
  secret and both fail, the second's undo can restore the first failed request's value. The
  row-level concurrency guard makes this rare.
- A rotation that keeps losing a race to other writers now returns 409 `CONCURRENT_UPDATE`
  instead of 500, and the rotations it already made in that request are undone.
