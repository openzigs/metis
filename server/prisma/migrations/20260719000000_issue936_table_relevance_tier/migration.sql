-- Issue #936 (Epic #929) — persist the LLM output-relevance tier + rationale.
--
-- The #936 relevance filter judges each crossed table `likely | possible |
-- unlikely`. Until now the tier + rationale lived only in memory (and were
-- folded into the TEXT-ONLY `suggestedDdl` comment), so the read/API/UI path
-- could not tell primary from secondary and the pruned `unlikely` tables
-- leaked back into the primary response.
--
-- These columns give the read path a PERSISTED discriminator. Both are
-- NULLABLE: legacy rows and flag-off / passthrough runs write NULL and are read
-- into the PRIMARY set exactly as before (deterministic passthrough). The read
-- path splits `unlikely` into a low-confidence SECONDARY bucket — retained for
-- recall, never dropped.
ALTER TABLE "impact_affected_tables" ADD COLUMN "relevanceTier" TEXT;
ALTER TABLE "impact_affected_tables" ADD COLUMN "relevanceRationale" TEXT;
