-- Reverse of server/prisma/postgres/migrations/20261111001725_issue1725_portfolio_host_product
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261111001725_issue1725_portfolio_host_product.sql
--
-- Drops the column and forgets the migration, so a later `prisma migrate
-- deploy` applies it again. Every other column of every row is left as it was;
-- which product each assessment was hosted on is lost. Idempotent, like the
-- forward migration (#556). The SQLite twin's up -> reverse -> up is tested in
-- server/tests/portfolio-host-migration-1725.sqlite.test.ts.

ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "hostProductId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261111001725_issue1725_portfolio_host_product';
