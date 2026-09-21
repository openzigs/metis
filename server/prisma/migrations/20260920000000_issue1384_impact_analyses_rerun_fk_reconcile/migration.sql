-- Issue #1384 — reconcile `impact_analyses` with `schema.prisma`. NO-OP at runtime.
--
-- #965 added `rerunOfId` with a hand-written
--
--   ALTER TABLE "impact_analyses" ADD COLUMN "rerunOfId" TEXT
--     REFERENCES "impact_analyses"("id") ON DELETE SET NULL;
--
-- rather than the `RedefineTables` block Prisma generates for SQLite. The
-- referential behaviour of the two is identical — what differs is the DDL SQLite
-- records in `sqlite_master`: an inline, unnamed column-level REFERENCES appended
-- last, where Prisma expects the column declared before `createdAt` and the key as
-- a named table-level `CONSTRAINT "impact_analyses_rerunOfId_fkey"`.
--
-- That stored DDL is exactly what `prisma migrate diff` compares, so since
-- 2026-07-20 every FRESH clone applied all 113 migrations correctly and was then
-- asked by `migrate dev` to author a migration during setup. `migrate status`
-- reported "up to date" throughout because it compares applied migration NAMES,
-- and CI never noticed because the postgres jobs run `migrate deploy`, which does
-- not compare structure at all.
--
-- This migration is the diff Prisma itself wanted, taken verbatim from
-- `prisma migrate diff --from-migrations prisma/migrations --to-schema
-- prisma/schema.prisma --script`. It rewrites the table into the expected shape and
-- copies every row across, so it changes no data and no behaviour — it only makes
-- the recorded DDL match. `server/tests/prisma-quickstart-config.test.ts` now fails
-- if the two diverge again.
--
-- Postgres needs no counterpart: its #965 migration used a named
-- `ADD CONSTRAINT "impact_analyses_rerunOfId_fkey"`, and postgres stores
-- constraints by name rather than as table DDL text, so that arm never drifted.
--
-- Rollback: none is needed. The pre- and post-states are equivalent schemas, so a
-- downgrade may simply leave this applied; `migrate resolve --rolled-back` plus the
-- inverse RedefineTables would restore the old DDL if one were ever wanted.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_impact_analyses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "documentId" TEXT,
    "sourceText" TEXT,
    "summary" TEXT,
    "startedById" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "errorMessage" TEXT,
    "totalImpactedSymbols" INTEGER NOT NULL DEFAULT 0,
    "rerunOfId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "impact_analyses_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "impact_analyses_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "impact_analyses_rerunOfId_fkey" FOREIGN KEY ("rerunOfId") REFERENCES "impact_analyses" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_impact_analyses" ("completedAt", "createdAt", "documentId", "errorMessage", "id", "rerunOfId", "sourceText", "startedAt", "startedById", "status", "summary", "totalImpactedSymbols", "updatedAt") SELECT "completedAt", "createdAt", "documentId", "errorMessage", "id", "rerunOfId", "sourceText", "startedAt", "startedById", "status", "summary", "totalImpactedSymbols", "updatedAt" FROM "impact_analyses";
DROP TABLE "impact_analyses";
ALTER TABLE "new_impact_analyses" RENAME TO "impact_analyses";
CREATE INDEX "impact_analyses_documentId_idx" ON "impact_analyses"("documentId");
CREATE INDEX "impact_analyses_startedById_idx" ON "impact_analyses"("startedById");
CREATE INDEX "impact_analyses_status_idx" ON "impact_analyses"("status");
CREATE INDEX "impact_analyses_rerunOfId_idx" ON "impact_analyses"("rerunOfId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

