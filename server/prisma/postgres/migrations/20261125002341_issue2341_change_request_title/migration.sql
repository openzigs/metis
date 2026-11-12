-- Issue #2341 (epic #2328) — the change request gets a name
-- (Postgres twin of server/prisma/migrations/20261125002341_issue2341_change_request_title;
-- see that file for the rationale). Nothing backfilled. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261125002341_issue2341_change_request_title.sql

ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "title" TEXT;
