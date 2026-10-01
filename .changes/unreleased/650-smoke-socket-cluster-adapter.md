---
issue: 650
section: Changed
---

- CI's server-image smoke test now fails when a production boot on Postgres does
  not attach the Socket.IO cluster adapter: it asks Postgres whether the adapter's
  `LISTEN` connection exists, instead of trusting the unit suite, which never
  selects the adapter.
