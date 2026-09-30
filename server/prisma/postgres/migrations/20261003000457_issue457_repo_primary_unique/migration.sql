-- Issue #457 — at most one live primary repository per project (Postgres mirror).
-- See the SQLite migration of the same name for the full rationale.
-- `IF NOT EXISTS` keeps the full chain idempotent (issue #556); the demote
-- UPDATE is a no-op on a second run.
--
-- Rollback: DROP INDEX IF EXISTS "repo_connections_projectId_primary_key";

-- Demote extra live primaries first, or the unique index cannot be built. Per
-- project the oldest live primary (ties broken by id) keeps the flag.
UPDATE "repo_connections"
SET "isPrimary" = false
WHERE "isPrimary" = true
  AND "deletedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "repo_connections" AS "k"
    WHERE "k"."projectId" = "repo_connections"."projectId"
      AND "k"."isPrimary" = true
      AND "k"."deletedAt" IS NULL
      AND "k"."id" <> "repo_connections"."id"
      AND (
        "k"."createdAt" < "repo_connections"."createdAt"
        OR ("k"."createdAt" = "repo_connections"."createdAt" AND "k"."id" < "repo_connections"."id")
      )
  );

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "repo_connections_projectId_primary_key" ON "repo_connections"("projectId") WHERE "isPrimary" = true AND "deletedAt" IS NULL;
