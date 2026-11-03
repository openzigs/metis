-- Issue #1687 — return an overridden product edge to `detected`.
--
-- Overriding a detected edge (#1647) wrote the person's integrationKind /
-- strength / direction over detection's, in place, so nothing could restore
-- detection's values. These three columns keep detection's classification of
-- an `overridden` edge: written when a detected edge is first overridden,
-- refreshed by every detection run that finds it again, and cleared when the
-- edge is reverted (`POST /api/products/:id/edges/:edgeId/revert`).
--
-- All nullable TEXT, like the classification columns they shadow. Nothing is
-- backfilled: an edge overridden before this migration has no record of what
-- detection said, so it reverts unclassified until the next detection run.
--
-- Rollback: server/prisma/rollbacks/20261110001687_issue1687_product_edge_detected_classification.sql
-- (exercised by server/tests/product-edge-detected-classification-migration-1687.sqlite.test.ts).

-- AlterTable
ALTER TABLE "product_edges" ADD COLUMN "detectedIntegrationKind" TEXT;
ALTER TABLE "product_edges" ADD COLUMN "detectedStrength" TEXT;
ALTER TABLE "product_edges" ADD COLUMN "detectedDirection" TEXT;
