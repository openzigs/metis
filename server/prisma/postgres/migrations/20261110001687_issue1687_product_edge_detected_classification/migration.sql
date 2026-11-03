-- Issue #1687 — detection's classification of an overridden product edge, so
-- a revert can restore it. Postgres twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261110001687_issue1687_product_edge_detected_classification)
-- for the full rationale. Nullable TEXT, not backfilled.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261110001687_issue1687_product_edge_detected_classification.sql

-- AlterTable
ALTER TABLE "product_edges" ADD COLUMN IF NOT EXISTS "detectedIntegrationKind" TEXT;
ALTER TABLE "product_edges" ADD COLUMN IF NOT EXISTS "detectedStrength" TEXT;
ALTER TABLE "product_edges" ADD COLUMN IF NOT EXISTS "detectedDirection" TEXT;
