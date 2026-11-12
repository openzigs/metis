-- Reverse of server/prisma/postgres/migrations/20261124002272_issue2272_portfolio_document_check
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261124002272_issue2272_portfolio_document_check.sql
--
-- Drops "portfolio_assessments"."notChecked" and "sourceDocumentId" and forgets
-- the migration, so a later `prisma migrate deploy` applies it again. What is
-- lost: which document each document check read, and every check's
-- not-checked list. Idempotent, like the forward migration (#556). The SQLite
-- twin's up -> reverse -> up is tested in
-- server/tests/portfolio-document-check-migration-2272.sqlite.test.ts.

ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "notChecked";
ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "sourceDocumentId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261124002272_issue2272_portfolio_document_check';
