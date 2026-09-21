-- Issue #957 (Epic #954) — surface the deterministic DDL RISK CLASS on every
-- affected table so the schema-impact section is decision-ready.
--
-- `impact_affected_tables.riskClass` records the pure `classifyDdlRisk` verdict
-- for the row's suggested change: `breaking` (destructive / needs-review),
-- `expanding` (additive / safe), or `neutral` (verify-only reference). Computed
-- at crossing time from the TEXT-ONLY suggested DDL — advisory triage only, it
-- NEVER gates any execution path (none exists). NULLABLE — null ⇒ a legacy row
-- written before this field existed, read back exactly as before (no badge).
ALTER TABLE "impact_affected_tables" ADD COLUMN "riskClass" TEXT;
