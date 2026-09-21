-- Issue #736 (epic #726) — per-requirement coverage classification.
--
-- Adds `requirements.coverage` (nullable): a deterministic enum computed at
-- synthesis time from the requirement's linked-finding evidence —
-- `grounded_in_code` | `grounded_in_docs_only` | `no_evidence`. Requirements are
-- delete+recreated on every analysis re-run, so the column is repopulated each
-- run; a plain nullable column (no backfill) is therefore sufficient — existing
-- rows read as `null` and the UI renders a neutral state. ADDITIVE: only a new
-- nullable column is added, so this is non-destructive and reversible.
ALTER TABLE "requirements" ADD COLUMN "coverage" TEXT;
