---
issue: 871
section: Fixed
---

- Two concurrent edits to the same requirement that carry the same `version`
  can no longer both succeed. The version check used to run before the write
  transaction opened, so the second edit silently overwrote the first. It is now
  checked again inside the transaction with a write conditional on the version,
  so the losing edit gets `409 VERSION_CONFLICT` with the usual field diff.
  This applies to `PUT /api/requirements/:id` and
  `PATCH /api/analyses/:id/requirements/:reqId`, on SQLite and Postgres. Edits
  sent without a `version` still apply last-writer-wins, now with a gap-free
  version history instead of an occasional 500 on Postgres.
