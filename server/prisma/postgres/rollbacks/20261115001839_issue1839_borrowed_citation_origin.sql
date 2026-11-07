-- Reverse of server/prisma/postgres/migrations/20261115001839_issue1839_borrowed_citation_origin
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261115001839_issue1839_borrowed_citation_origin.sql
--
-- Drops the column and forgets the migration, so a later `prisma migrate
-- deploy` applies it again. Every other column of every row is left as it was;
-- which requirement a borrowed link came from is lost. Idempotent, like the
-- forward migration (#556). The SQLite twin's up -> reverse -> up is tested in
-- server/tests/borrow-citations-1839.sqlite.test.ts.

ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "originRequirementId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261115001839_issue1839_borrowed_citation_origin';
