-- Epic #547 (Phase 2, #550) — DiscussionMessage origin / loop-guard column.
-- Postgres mirror of the SQLite migration.
--
-- Adds `discussion_messages.origin` (default 'metis'). ADDITIVE — no existing
-- table is altered structurally beyond this column. The ADD COLUMN is
-- `IF NOT EXISTS` (idempotent) so replaying the full migration history over the
-- cumulative `00000000000000_init` baseline on a fresh Postgres no-ops here
-- rather than colliding (issue #556 guard).
ALTER TABLE "discussion_messages" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'metis';
