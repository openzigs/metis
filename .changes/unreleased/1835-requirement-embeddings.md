---
issue: 1835
section: Added
---

- Requirements are now embedded into a project-scoped vector table and kept in
  step with edits, deletes and analysis re-runs, ready for duplicate detection
  and semantic search over requirements. A new `requirement_embeddings` table
  (SQLite and Postgres migrations, each with a rollback script) records what was
  embedded; `REQUIREMENT_EMBEDDINGS_SYNC_ON_WRITE=0` turns off the background
  warm-up after a requirement write.
