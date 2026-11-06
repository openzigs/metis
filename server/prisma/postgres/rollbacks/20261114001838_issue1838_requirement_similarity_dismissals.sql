-- Reverse of server/prisma/postgres/migrations/20261114001838_issue1838_requirement_similarity_dismissals
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261114001838_issue1838_requirement_similarity_dismissals.sql
--
-- Drops `requirement_similarity_dismissals` and forgets the migration, so a
-- later `prisma migrate deploy` applies it again. No other table is touched;
-- every "Not a duplicate" answer is lost. Idempotent, like the forward
-- migration (#556). The SQLite twin's up -> reverse -> up is tested in
-- server/tests/requirement-similarity-dismissal-migration-1838.sqlite.test.ts.

DROP TABLE IF EXISTS "requirement_similarity_dismissals";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114001838_issue1838_requirement_similarity_dismissals';
