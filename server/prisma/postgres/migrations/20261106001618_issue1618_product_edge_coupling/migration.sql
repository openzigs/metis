-- Issue #1618 — typed product edges and shared-resource nodes. Postgres twin of
-- the SQLite migration; see that file
-- (server/prisma/migrations/20261106001618_issue1618_product_edge_coupling) for
-- the full rationale. New edge columns are nullable TEXT except `origin`
-- (default 'detected'); nothing is backfilled. `targetRepoId` becomes nullable
-- for an edge through a resource.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261106001618_issue1618_product_edge_coupling.sql

-- AlterTable
ALTER TABLE "product_edges" ADD COLUMN IF NOT EXISTS "integrationKind" TEXT,
ADD COLUMN IF NOT EXISTS "strength" TEXT,
ADD COLUMN IF NOT EXISTS "direction" TEXT,
ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'detected',
ADD COLUMN IF NOT EXISTS "resourceId" TEXT,
ADD COLUMN IF NOT EXISTS "contractDocId" TEXT,
ADD COLUMN IF NOT EXISTS "declaredById" TEXT,
ALTER COLUMN "targetRepoId" DROP NOT NULL;

-- CreateTable
CREATE TABLE IF NOT EXISTS "product_resources" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locator" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'detected',
    "declaredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_resources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "product_resources_productId_kind_name_key" ON "product_resources"("productId", "kind", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_edges_resourceId_idx" ON "product_edges"("resourceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_edges_contractDocId_idx" ON "product_edges"("contractDocId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_resources_productId_fkey') THEN
    EXECUTE 'ALTER TABLE "product_resources" ADD CONSTRAINT "product_resources_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_edges_resourceId_fkey') THEN
    EXECUTE 'ALTER TABLE "product_edges" ADD CONSTRAINT "product_edges_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "product_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_edges_contractDocId_fkey') THEN
    EXECUTE 'ALTER TABLE "product_edges" ADD CONSTRAINT "product_edges_contractDocId_fkey" FOREIGN KEY ("contractDocId") REFERENCES "product_contract_docs"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;
