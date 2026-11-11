-- Reverse of server/prisma/postgres/migrations/20261123002222_issue2222_governing_finding_requirement_versions
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261123002222_issue2222_governing_finding_requirement_versions.sql
--
-- Drops "governing_findings"."requirementVersions" and forgets the migration, so
-- a later `prisma migrate deploy` applies it again. Idempotent, like the forward
-- migration (#556). The SQLite twin's up -> reverse -> up is tested in
-- server/tests/governing-finding-requirement-versions-migration-2222.sqlite.test.ts.

ALTER TABLE "governing_findings" DROP COLUMN IF EXISTS "requirementVersions";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123002222_issue2222_governing_finding_requirement_versions';
