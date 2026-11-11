-- Reverse of server/prisma/migrations/20261123002222_issue2222_governing_finding_requirement_versions
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261123002222_issue2222_governing_finding_requirement_versions.sql
--
-- Drops "governing_findings"."requirementVersions" and forgets the migration, so
-- a later `prisma migrate deploy` applies it again. What is lost: which
-- requirement versions a re-checked finding judged, so such a finding then reads
-- as judged at the analysed version. Every other column of every row is kept.
-- server/tests/governing-finding-requirement-versions-migration-2222.sqlite.test.ts
-- runs up, this, and up again over a seeded row.

BEGIN;
ALTER TABLE "governing_findings" DROP COLUMN "requirementVersions";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123002222_issue2222_governing_finding_requirement_versions';
COMMIT;
