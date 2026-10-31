-- Reverse of server/prisma/migrations/20261106001618_issue1618_product_edge_coupling
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261106001618_issue1618_product_edge_coupling.sql
--
-- It rebuilds `product_edges` in its pre-#1618 shape (`targetRepoId` NOT NULL,
-- no coupling columns), drops `product_resources`, and forgets the migration, so
-- a later `prisma migrate deploy` applies it again. Every pre-existing column of
-- every edge that has a target repo is left as it was. What is lost:
--   - each edge's integrationKind / strength / direction / origin / resourceId /
--     contractDocId / declaredById (stored nowhere else); a declared edge that
--     has a target repo stays, as an unclassified edge;
--   - every edge with NO target repo (an edge through a resource), which the old
--     shape cannot hold;
--   - every product resource.
-- server/tests/product-edge-coupling-migration-1618.sqlite.test.ts runs up,
-- this, and up again over seeded rows.

-- Outside the transaction: SQLite ignores this pragma inside one.
PRAGMA foreign_keys=OFF;

-- One transaction: if the DELETE failed, the old shape would be back while the
-- migration still read as applied, and `migrate deploy` would not redo it.
BEGIN;
CREATE TABLE "old_product_edges" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "sourceRepoId" TEXT NOT NULL,
    "targetRepoId" TEXT NOT NULL,
    "edgeType" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "sourceFile" TEXT,
    "targetFile" TEXT,
    "commitSha" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "product_edges_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "product_edges_sourceRepoId_fkey" FOREIGN KEY ("sourceRepoId") REFERENCES "repo_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "product_edges_targetRepoId_fkey" FOREIGN KEY ("targetRepoId") REFERENCES "repo_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "old_product_edges" ("id", "productId", "sourceRepoId", "targetRepoId", "edgeType", "confidence", "evidence", "sourceFile", "targetFile", "commitSha", "createdAt", "updatedAt")
SELECT "id", "productId", "sourceRepoId", "targetRepoId", "edgeType", "confidence", "evidence", "sourceFile", "targetFile", "commitSha", "createdAt", "updatedAt"
FROM "product_edges" WHERE "targetRepoId" IS NOT NULL;
DROP TABLE "product_edges";
ALTER TABLE "old_product_edges" RENAME TO "product_edges";
CREATE INDEX "product_edges_productId_idx" ON "product_edges"("productId");
CREATE INDEX "product_edges_sourceRepoId_idx" ON "product_edges"("sourceRepoId");
CREATE INDEX "product_edges_targetRepoId_idx" ON "product_edges"("targetRepoId");
CREATE INDEX "product_edges_productId_edgeType_idx" ON "product_edges"("productId", "edgeType");
DROP TABLE "product_resources";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106001618_issue1618_product_edge_coupling';
COMMIT;

PRAGMA foreign_keys=ON;
