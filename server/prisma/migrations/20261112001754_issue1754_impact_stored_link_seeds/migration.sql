-- Issue #1754 — impact analysis seeded from a requirement's stored code links.
--
--   impact_analyses.requirementIds  the stored requirements a run was asked
--                   about (`POST /api/impact-analyses` `requirementIds`), as a
--                   JSON array of ids. Each becomes one change carrying its
--                   `requirementId`, which is what lets the run read that
--                   requirement's `requirement_code_mappings`. A re-run reads
--                   it back. Soft-linked, like `productIds`: no foreign key, so
--                   the run outlives a deleted requirement.
--   impact_items.seedEvidence  JSON: how the change was seeded into the
--                   project, when a channel beyond the default one ran
--                   (`IMPACT_STORED_LINK_SEEDS`): stored links used and
--                   dropped as stale, and the channels of each edit candidate.
--
-- Both nullable TEXT: every existing row reads as "not asked about a stored
-- requirement" and "seeded by the default channel only". Nothing is backfilled.
--
-- Rollback: server/prisma/rollbacks/20261112001754_issue1754_impact_stored_link_seeds.sql
-- (exercised by server/tests/impact-stored-link-migration-1754.sqlite.test.ts).

-- AlterTable
ALTER TABLE "impact_analyses" ADD COLUMN "requirementIds" TEXT;

-- AlterTable
ALTER TABLE "impact_items" ADD COLUMN "seedEvidence" TEXT;
