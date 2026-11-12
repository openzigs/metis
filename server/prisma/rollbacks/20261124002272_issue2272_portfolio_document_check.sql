-- Reverse of server/prisma/migrations/20261124002272_issue2272_portfolio_document_check
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261124002272_issue2272_portfolio_document_check.sql
--
-- Drops "portfolio_assessments"."notChecked" and "sourceDocumentId" and forgets
-- the migration, so a later `prisma migrate deploy` applies it again. What is
-- lost: which document each document check read, and every check's
-- not-checked list. Those checks keep their statement, verdict and products.
-- Every other column of every row is untouched.
-- server/tests/portfolio-document-check-migration-2272.sqlite.test.ts runs up,
-- this, and up again over a seeded row.

BEGIN;
ALTER TABLE "portfolio_assessments" DROP COLUMN "notChecked";
ALTER TABLE "portfolio_assessments" DROP COLUMN "sourceDocumentId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261124002272_issue2272_portfolio_document_check';
COMMIT;
