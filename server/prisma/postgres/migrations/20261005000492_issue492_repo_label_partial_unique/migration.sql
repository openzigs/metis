-- Issue #492 — a soft-deleted repository connector frees its label (Postgres
-- mirror). See the SQLite migration of the same name for the full rationale.
-- `IF EXISTS` / `IF NOT EXISTS` keep the full chain idempotent (issue #556):
-- a second run drops the partial index and builds it again.
--
-- Rollback: rename deleted rows that share a live row's label, then rebuild
-- the full index:
--   UPDATE "repo_connections" SET "label" = "label" || ' (deleted ' || "id" || ')'
--   WHERE "deletedAt" IS NOT NULL AND EXISTS (
--     SELECT 1 FROM "repo_connections" AS "k"
--     WHERE "k"."projectId" = "repo_connections"."projectId"
--       AND "k"."label" = "repo_connections"."label"
--       AND "k"."id" <> "repo_connections"."id");
--   DROP INDEX IF EXISTS "repo_connections_projectId_label_key";
--   CREATE UNIQUE INDEX "repo_connections_projectId_label_key" ON "repo_connections"("projectId", "label");

-- DropIndex
DROP INDEX IF EXISTS "repo_connections_projectId_label_key";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "repo_connections_projectId_label_key" ON "repo_connections"("projectId", "label") WHERE "deletedAt" IS NULL;
