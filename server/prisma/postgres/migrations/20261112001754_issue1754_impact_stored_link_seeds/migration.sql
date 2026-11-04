-- Issue #1754 — impact analysis seeded from a requirement's stored code links
-- (Postgres twin of server/prisma/migrations/20261112001754_issue1754_impact_stored_link_seeds).
--
-- Two nullable TEXT columns holding JSON, no foreign key: every existing row
-- reads as "not asked about a stored requirement" and "seeded by the default
-- channel only". Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261112001754_issue1754_impact_stored_link_seeds.sql

ALTER TABLE "impact_analyses" ADD COLUMN IF NOT EXISTS "requirementIds" TEXT;
ALTER TABLE "impact_items" ADD COLUMN IF NOT EXISTS "seedEvidence" TEXT;
