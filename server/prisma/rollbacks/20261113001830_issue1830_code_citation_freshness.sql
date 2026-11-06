-- Reverse of server/prisma/migrations/20261113001830_issue1830_code_citation_freshness
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261113001830_issue1830_code_citation_freshness.sql
--
-- SQLite cannot drop a column that carries a foreign key, so the table is
-- rebuilt in its pre-#1830 shape: every pre-existing column of every row is
-- copied verbatim, the eight #1830 columns (and their index) are dropped, and
-- the migration is forgotten, so a later `prisma migrate deploy` applies it
-- again. What is lost: each citation's graph, commit and freshness verdict,
-- and the previous location of a moved one.
-- server/tests/code-citation-freshness-migration-1830.sqlite.test.ts runs up,
-- this, and up again over seeded rows.

-- One transaction: if the DELETE failed, the table would be in its old shape
-- while the migration still read as applied, and `migrate deploy` would not
-- re-add the columns. Foreign keys are off for the rebuild (SQLite ignores the
-- pragma inside a transaction, so it is set first).
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE "old_requirement_code_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "codeSymbolId" TEXT,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "confidence" REAL NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'semantic',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_code_mappings_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirement_code_mappings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirement_code_mappings_codeSymbolId_fkey" FOREIGN KEY ("codeSymbolId") REFERENCES "code_symbols" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "old_requirement_code_mappings" ("codeSymbolId", "confidence", "createdAt", "endLine", "filePath", "id", "projectId", "requirementId", "source", "startLine") SELECT "codeSymbolId", "confidence", "createdAt", "endLine", "filePath", "id", "projectId", "requirementId", "source", "startLine" FROM "requirement_code_mappings";
DROP TABLE "requirement_code_mappings";
ALTER TABLE "old_requirement_code_mappings" RENAME TO "requirement_code_mappings";
CREATE INDEX "requirement_code_mappings_requirementId_idx" ON "requirement_code_mappings"("requirementId");
CREATE INDEX "requirement_code_mappings_projectId_idx" ON "requirement_code_mappings"("projectId");
CREATE INDEX "requirement_code_mappings_codeSymbolId_idx" ON "requirement_code_mappings"("codeSymbolId");
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113001830_issue1830_code_citation_freshness';
COMMIT;
PRAGMA foreign_keys=ON;
