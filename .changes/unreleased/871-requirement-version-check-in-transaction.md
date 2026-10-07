---
issue: 871
section: Fixed
---

- Two concurrent edits to the same requirement carrying the same `version` can
  no longer both succeed: the version is now checked inside the write
  transaction with a version-conditional write, so the loser gets
  `409 VERSION_CONFLICT` with the usual field diff (`PUT /api/requirements/:id`,
  `PATCH /api/analyses/:id/requirements/:reqId`, SQLite and Postgres). Edits
  without a `version` stay last-writer-wins with a gap-free history; no-op edits
  still succeed. Restoring a version uses the same conditional write, so it no
  longer overwrites a concurrent edit from a stale snapshot.
