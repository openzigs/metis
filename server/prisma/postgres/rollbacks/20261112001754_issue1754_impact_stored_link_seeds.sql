-- Reverse of server/prisma/postgres/migrations/20261112001754_issue1754_impact_stored_link_seeds
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261112001754_issue1754_impact_stored_link_seeds.sql
--
-- Drops both columns and forgets the migration, so a later `prisma migrate
-- deploy` applies it again. Every other column of every row is left as it was;
-- which stored requirements a run was asked about, and how each item was
-- seeded, are lost. Idempotent, like the forward migration (#556). The SQLite
-- twin's up -> reverse -> up is tested in
-- server/tests/impact-stored-link-migration-1754.sqlite.test.ts.

ALTER TABLE "impact_analyses" DROP COLUMN IF EXISTS "requirementIds";
ALTER TABLE "impact_items" DROP COLUMN IF EXISTS "seedEvidence";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261112001754_issue1754_impact_stored_link_seeds';
