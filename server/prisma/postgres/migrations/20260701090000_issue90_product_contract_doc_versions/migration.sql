-- Issue #90 (epic #86) — versioned, diffable product API-contract docs.
-- Postgres mirror of the SQLite migration.
--
-- Adds the `product_contract_docs` table. ADDITIVE — no existing table is
-- altered. All structural DDL is idempotent (`IF NOT EXISTS`; the FK is wrapped
-- in a pg_constraint existence DO-block) so the full migration history replays
-- cleanly over the cumulative `00000000000000_init` baseline on a fresh
-- Postgres (#556 guard).

-- CreateTable
CREATE TABLE IF NOT EXISTS "product_contract_docs" (
    "id" TEXT NOT NULL,
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
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_contract_docs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_contract_docs_productId_idx" ON "product_contract_docs"("productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_contract_docs_productId_repoId_idx" ON "product_contract_docs"("productId", "repoId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "product_contract_docs_productId_repoId_version_key" ON "product_contract_docs"("productId", "repoId", "version");

-- AddForeignKey (guarded — bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_contract_docs_productId_fkey') THEN
    ALTER TABLE "product_contract_docs" ADD CONSTRAINT "product_contract_docs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
