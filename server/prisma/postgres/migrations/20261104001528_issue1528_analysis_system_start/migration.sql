-- Issue #1528 — make `analyses.startedById` NULLABLE (Postgres mirror), so a
-- scheduled analysis re-run, which has no user, can start. See the SQLite
-- migration of the same name
-- (server/prisma/migrations/20261104001528_issue1528_analysis_system_start) for the full rationale.
--
-- `DROP NOT NULL` is inherently idempotent (a no-op when the column is already
-- nullable), so replaying the whole chain never collides (#556). The foreign
-- key, ON DELETE RESTRICT, is unchanged.
--
-- Rollback (documentation): delete or re-attribute every row whose
-- "startedById" IS NULL, then
--   ALTER TABLE "analyses" ALTER COLUMN "startedById" SET NOT NULL;

ALTER TABLE "analyses" ALTER COLUMN "startedById" DROP NOT NULL;
