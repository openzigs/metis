-- Reverse of server/prisma/migrations/20261111001725_issue1725_portfolio_host_product
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261111001725_issue1725_portfolio_host_product.sql
--
-- It drops the column (SQLite 3.35+; it is neither indexed nor constrained) and
-- forgets the migration, so a later `prisma migrate deploy` applies it again.
-- Every other column of every row is left as it was. What is lost: which
-- product each assessment was hosted on (its impact rows, already stored, keep
-- the host as a direct change). server/tests/portfolio-host-migration-1725.sqlite.test.ts
-- runs up, this, and up again over seeded rows.

-- One transaction: if the DELETE failed, the column would be gone while the
-- migration still read as applied, and `migrate deploy` would not re-add it.
BEGIN;
ALTER TABLE "portfolio_assessments" DROP COLUMN "hostProductId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261111001725_issue1725_portfolio_host_product';
COMMIT;
