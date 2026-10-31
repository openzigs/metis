-- Issue #1612 — a functional / non-functional "kind" on Requirement, and the
-- NFR category of a non-functional one. Postgres twin of the SQLite migration;
-- see that file (server/prisma/migrations/20261105001612_issue1612_requirement_kind)
-- for the full rationale. Nullable TEXT, not backfilled: NULL means unknown.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261105001612_issue1612_requirement_kind.sql

-- AlterTable
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "kind" TEXT;
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "nfrCategory" TEXT;
