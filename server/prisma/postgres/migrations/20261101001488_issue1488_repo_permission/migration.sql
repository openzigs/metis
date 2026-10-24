-- Issue #1488 — the repository permission a connector's credential had at its
-- last successful Test (admin | push | read | none). Postgres twin of the SQLite
-- migration; see that file
-- (server/prisma/migrations/20261101001488_issue1488_repo_permission)
-- for the full rationale. Not backfilled: existing connectors are ineligible for
-- shared-secret webhook routing until tested again.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback (documentation):
--   ALTER TABLE "repo_connections" DROP COLUMN "repoPermission";

-- AlterTable
ALTER TABLE "repo_connections" ADD COLUMN IF NOT EXISTS "repoPermission" TEXT;
