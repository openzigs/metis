-- Issue #965 (Epic #960) — impact re-run + drift lineage.
--
-- `impact_analyses.rerunOfId` is a NULLABLE self-relation: when set, THIS run is a
-- re-execution of the referenced original run against the CURRENT code graph
-- (reusing the original's `sourceText`/`documentId` verbatim). Null ⇒ an original
-- (first) run and the row reads exactly as before this feature. Original runs are
-- immutable — a re-run only points BACK at its parent so the drift differ can
-- render "what changed since"; it never mutates the parent's rows. The FK is
-- ON DELETE SET NULL so deleting an original ORPHANS (does not cascade-delete) its
-- re-runs. SQLite supports an inline column-level REFERENCES in ADD COLUMN (a bare
-- ADD CONSTRAINT is NOT supported), so the FK is declared on the new column.
ALTER TABLE "impact_analyses" ADD COLUMN "rerunOfId" TEXT REFERENCES "impact_analyses"("id") ON DELETE SET NULL;

CREATE INDEX "impact_analyses_rerunOfId_idx" ON "impact_analyses"("rerunOfId");
