-- Reverse of server/prisma/postgres/migrations/20261106001618_issue1618_product_edge_coupling
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261106001618_issue1618_product_edge_coupling.sql
--
-- Deletes every edge with no target repo (an edge through a resource, which the
-- old shape cannot hold), restores `targetRepoId` NOT NULL, drops the coupling
-- columns and `product_resources`, and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. Every pre-existing column of every
-- other edge is left as it was; the coupling values and resources are lost.
-- Idempotent, like the forward migration (#556). The SQLite twin's
-- up -> reverse -> up is tested in
-- server/tests/product-edge-coupling-migration-1618.sqlite.test.ts.

DELETE FROM "product_edges" WHERE "targetRepoId" IS NULL;
ALTER TABLE "product_edges" ALTER COLUMN "targetRepoId" SET NOT NULL;
ALTER TABLE "product_edges" DROP CONSTRAINT IF EXISTS "product_edges_resourceId_fkey";
ALTER TABLE "product_edges" DROP CONSTRAINT IF EXISTS "product_edges_contractDocId_fkey";
DROP INDEX IF EXISTS "product_edges_resourceId_idx";
DROP INDEX IF EXISTS "product_edges_contractDocId_idx";
ALTER TABLE "product_edges" DROP COLUMN IF EXISTS "integrationKind";
ALTER TABLE "product_edges" DROP COLUMN IF EXISTS "strength";
ALTER TABLE "product_edges" DROP COLUMN IF EXISTS "direction";
ALTER TABLE "product_edges" DROP COLUMN IF EXISTS "origin";
ALTER TABLE "product_edges" DROP COLUMN IF EXISTS "resourceId";
ALTER TABLE "product_edges" DROP COLUMN IF EXISTS "contractDocId";
ALTER TABLE "product_edges" DROP COLUMN IF EXISTS "declaredById";
DROP TABLE IF EXISTS "product_resources";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106001618_issue1618_product_edge_coupling';
