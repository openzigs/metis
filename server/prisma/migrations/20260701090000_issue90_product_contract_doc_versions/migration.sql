-- Issue #90 (epic #86) — versioned, diffable product API-contract docs.
--
-- Adds the `product_contract_docs` table: an append-only, monotonically-
-- versioned history of a repo's API-contract doc per (productId, repoId).
-- Regenerating an UNCHANGED contract is deduped by contentHash (no new row);
-- a CHANGED contract appends version N+1 with the semantic diff vs version N.
-- ADDITIVE — no existing table is altered — so it is non-destructive and
-- trivially reversible (DROP TABLE product_contract_docs).
--
-- JSON columns (specIdentity, itemsSnapshot, diff) are TEXT for sqlite/postgres
-- parity, serialised by the application via JSON.stringify / JSON.parse.

-- CreateTable
CREATE TABLE "product_contract_docs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "repoId" TEXT,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "specIdentity" TEXT NOT NULL DEFAULT '[]',
    "itemsSnapshot" TEXT NOT NULL DEFAULT '[]',
    "diff" TEXT,
    "diffSummary" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_contract_docs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "product_contract_docs_productId_idx" ON "product_contract_docs"("productId");

-- CreateIndex
CREATE INDEX "product_contract_docs_productId_repoId_idx" ON "product_contract_docs"("productId", "repoId");

-- CreateIndex
CREATE UNIQUE INDEX "product_contract_docs_productId_repoId_version_key" ON "product_contract_docs"("productId", "repoId", "version");
