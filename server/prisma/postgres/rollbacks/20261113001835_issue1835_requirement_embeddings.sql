-- Reverse of server/prisma/postgres/migrations/20261113001835_issue1835_requirement_embeddings
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261113001835_issue1835_requirement_embeddings.sql
--
-- Drops `requirement_embeddings` and forgets the migration, so a later `prisma
-- migrate deploy` applies it again. No other table is touched; only the hash
-- bookkeeping is lost, and the next reconcile re-embeds each requirement once.
-- Idempotent, like the forward migration (#556). The SQLite twin's
-- up -> reverse -> up is tested in
-- server/tests/requirement-embedding-migration-1835.sqlite.test.ts.

DROP TABLE IF EXISTS "requirement_embeddings";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113001835_issue1835_requirement_embeddings';
