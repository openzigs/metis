-- Issue #1618 — typed product edges and shared-resource nodes.
--
-- A product edge said only `edgeType`. It now also says what crosses the
-- boundary (`integrationKind`: api | event | database | shared-library |
-- identity), how tightly the two sides are coupled (`strength`: contract |
-- model | functional | intrusive), in which `direction`, and whether detection
-- found it or a person declared it (`origin`, default `detected`). An edge may
-- go through a `product_resources` row (a table, a topic, an identity
-- provider), and then `targetRepoId` may be NULL (repo -> table); the service
-- layer refuses an edge with neither. `contractDocId` links an API edge to its
-- `product_contract_docs` version. Both new foreign keys are ON DELETE SET NULL.
--
-- Every existing edge keeps every value and reads `origin = 'detected'` with
-- the new columns NULL: nothing is backfilled, because a guessed coupling
-- would be published as a real one.
--
-- `targetRepoId` becomes nullable, which SQLite can only do by rebuilding the
-- table (Prisma's RedefineTables), copying every row.
--
-- Rollback: server/prisma/rollbacks/20261106001618_issue1618_product_edge_coupling.sql
-- (exercised by server/tests/product-edge-coupling-migration-1618.sqlite.test.ts).

-- CreateTable
CREATE TABLE "product_resources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locator" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'detected',
    "declaredById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "product_resources_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_product_edges" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "sourceRepoId" TEXT NOT NULL,
    "targetRepoId" TEXT,
    "edgeType" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "sourceFile" TEXT,
    "targetFile" TEXT,
    "commitSha" TEXT,
    "integrationKind" TEXT,
    "strength" TEXT,
    "direction" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'detected',
    "resourceId" TEXT,
    "contractDocId" TEXT,
    "declaredById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "product_edges_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "product_edges_sourceRepoId_fkey" FOREIGN KEY ("sourceRepoId") REFERENCES "repo_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "product_edges_targetRepoId_fkey" FOREIGN KEY ("targetRepoId") REFERENCES "repo_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "product_edges_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "product_resources" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "product_edges_contractDocId_fkey" FOREIGN KEY ("contractDocId") REFERENCES "product_contract_docs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_product_edges" ("commitSha", "confidence", "createdAt", "edgeType", "evidence", "id", "productId", "sourceFile", "sourceRepoId", "targetFile", "targetRepoId", "updatedAt") SELECT "commitSha", "confidence", "createdAt", "edgeType", "evidence", "id", "productId", "sourceFile", "sourceRepoId", "targetFile", "targetRepoId", "updatedAt" FROM "product_edges";
DROP TABLE "product_edges";
ALTER TABLE "new_product_edges" RENAME TO "product_edges";
CREATE INDEX "product_edges_productId_idx" ON "product_edges"("productId");
CREATE INDEX "product_edges_sourceRepoId_idx" ON "product_edges"("sourceRepoId");
CREATE INDEX "product_edges_targetRepoId_idx" ON "product_edges"("targetRepoId");
CREATE INDEX "product_edges_productId_edgeType_idx" ON "product_edges"("productId", "edgeType");
CREATE INDEX "product_edges_resourceId_idx" ON "product_edges"("resourceId");
CREATE INDEX "product_edges_contractDocId_idx" ON "product_edges"("contractDocId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "product_resources_productId_kind_name_key" ON "product_resources"("productId", "kind", "name");
