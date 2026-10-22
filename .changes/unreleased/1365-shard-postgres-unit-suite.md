---
issue: 1365
section: Changed
---

- CI runs the server unit suite on the Postgres-generated client in three parallel
  `postgres-unit` shards instead of inside `postgres-adapter`, which now holds only the
  real-Postgres integration proofs. Neither job sits near its 15-minute timeout any more,
  so a pull request is no longer cancelled red with no test failing. Every file and proof
  still runs.
