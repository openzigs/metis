-- Reverse of server/prisma/migrations/20261112001754_issue1754_impact_stored_link_seeds
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261112001754_issue1754_impact_stored_link_seeds.sql
--
-- It drops both columns (SQLite 3.35+; neither is indexed nor constrained) and
-- forgets the migration, so a later `prisma migrate deploy` applies it again.
-- Every other column of every row is left as it was. What is lost: which stored
-- requirements a run was asked about (so a re-run of such a run has no source
-- left), and how each item was seeded. server/tests/impact-stored-link-migration-1754.sqlite.test.ts
-- runs up, this, and up again over seeded rows.

-- One transaction: if the DELETE failed, the columns would be gone while the
-- migration still read as applied, and `migrate deploy` would not re-add them.
BEGIN;
ALTER TABLE "impact_analyses" DROP COLUMN "requirementIds";
ALTER TABLE "impact_items" DROP COLUMN "seedEvidence";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261112001754_issue1754_impact_stored_link_seeds';
COMMIT;
