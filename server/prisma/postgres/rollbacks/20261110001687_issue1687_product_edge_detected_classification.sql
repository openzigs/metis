-- Reverse of server/prisma/postgres/migrations/20261110001687_issue1687_product_edge_detected_classification
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261110001687_issue1687_product_edge_detected_classification.sql
--
-- Drops the three columns and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. Every other column of every edge
-- is left as it was; detection's classification of each overridden edge is
-- lost. Idempotent, like the forward migration (#556). The SQLite twin's
-- up -> reverse -> up is tested in
-- server/tests/product-edge-detected-classification-migration-1687.sqlite.test.ts.

ALTER TABLE "product_edges" DROP COLUMN IF EXISTS "detectedDirection";
ALTER TABLE "product_edges" DROP COLUMN IF EXISTS "detectedStrength";
ALTER TABLE "product_edges" DROP COLUMN IF EXISTS "detectedIntegrationKind";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261110001687_issue1687_product_edge_detected_classification';
