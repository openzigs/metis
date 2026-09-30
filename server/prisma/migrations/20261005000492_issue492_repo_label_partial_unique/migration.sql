-- Issue #492 — a soft-deleted repository connector frees its label.
--
-- `@@unique([projectId, label])` covered soft-deleted rows too, so deleting a
-- connector and re-adding the same repository under the same label was always
-- answered `409 REPO_LABEL_TAKEN`. The index becomes partial — live rows only —
-- as #457 did for `isPrimary`. Declared in schema.prisma as
-- `@@unique([projectId, label], where: { deletedAt: null }, map: ...)`
-- (Prisma `partialIndexes` preview), so `migrate diff` sees no drift. The name
-- is kept, so the service's P2002 classification is unchanged.
--
-- No data change: every row that satisfied the full index satisfies the
-- partial one.
--
-- Rollback: a live and a deleted row may now share a label, which the full
-- index rejects, so rename the deleted duplicates first, then rebuild it:
--   UPDATE "repo_connections" SET "label" = "label" || ' (deleted ' || "id" || ')'
--   WHERE "deletedAt" IS NOT NULL AND EXISTS (
--     SELECT 1 FROM "repo_connections" AS "k"
--     WHERE "k"."projectId" = "repo_connections"."projectId"
--       AND "k"."label" = "repo_connections"."label"
--       AND "k"."id" <> "repo_connections"."id");
--   DROP INDEX "repo_connections_projectId_label_key";
--   CREATE UNIQUE INDEX "repo_connections_projectId_label_key" ON "repo_connections"("projectId", "label");

-- DropIndex
DROP INDEX "repo_connections_projectId_label_key";

-- CreateIndex
CREATE UNIQUE INDEX "repo_connections_projectId_label_key" ON "repo_connections"("projectId", "label") WHERE "deletedAt" IS NULL;
