-- Issue #457 — at most one live primary repository per project.
--
-- `createRepoConnector` decides `isPrimary` by counting the project's live
-- repositories and then inserting: check-then-act, so two concurrent creates on
-- a project with no repositories could both read 0 and both be written primary.
-- This partial unique index makes the loser's insert fail (P2002), and the
-- service retries it as a non-primary row. Partial so any number of non-primary
-- or soft-deleted rows may share a project.
-- Declared in schema.prisma as `@@unique([projectId], where: { isPrimary: true,
-- deletedAt: null })` (Prisma `partialIndexes` preview), so `migrate diff` sees
-- no drift.
--
-- Rollback: DROP INDEX "repo_connections_projectId_primary_key"; the demoted
-- rows stay non-primary (re-mark one with setPrimaryRepo if needed).

-- Demote extra live primaries first, or the unique index cannot be built. Per
-- project the oldest live primary (ties broken by id) keeps the flag. The
-- survivor is never itself updated, so every other row sees it whatever order
-- the rows are visited in.
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
CREATE UNIQUE INDEX "repo_connections_projectId_primary_key" ON "repo_connections"("projectId") WHERE "isPrimary" = true AND "deletedAt" IS NULL;
