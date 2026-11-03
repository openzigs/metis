-- Reverse of server/prisma/migrations/20261110001687_issue1687_product_edge_detected_classification
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261110001687_issue1687_product_edge_detected_classification.sql
--
-- It drops the three columns (SQLite 3.35+; none is indexed or constrained)
-- and forgets the migration, so a later `prisma migrate deploy` applies it
-- again. Every other column of every edge is left as it was, so an overridden
-- edge keeps the person's classification. What is lost: detection's
-- classification of each overridden edge, so reverting one after re-applying
-- the migration leaves it unclassified until the next detection run.
-- server/tests/product-edge-detected-classification-migration-1687.sqlite.test.ts
-- runs up, this, and up again over seeded rows.

-- One transaction: if the DELETE failed, the columns would be gone while the
-- migration still read as applied, and `migrate deploy` would not re-add them.
BEGIN;
ALTER TABLE "product_edges" DROP COLUMN "detectedDirection";
ALTER TABLE "product_edges" DROP COLUMN "detectedStrength";
ALTER TABLE "product_edges" DROP COLUMN "detectedIntegrationKind";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261110001687_issue1687_product_edge_detected_classification';
COMMIT;
