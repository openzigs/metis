-- Issue #1311 — the label names METIS sent each published GitHub issue (a JSON
-- array). Postgres twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261103001311_issue1311_published_issue_sent_labels)
-- for the full rationale. Not backfilled: a NULL keeps the earlier comparison.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback (documentation):
--   ALTER TABLE "published_issues" DROP COLUMN "sentLabels";

-- AlterTable
ALTER TABLE "published_issues" ADD COLUMN IF NOT EXISTS "sentLabels" TEXT;
