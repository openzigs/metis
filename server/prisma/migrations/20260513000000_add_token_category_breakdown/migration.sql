-- Epic #511 / Issue #512 — Add category_breakdown JSON column to ai_token_usages
-- Stores per-category token count breakdown. NULL for pre-existing rows (backward compat).
ALTER TABLE "ai_token_usages" ADD COLUMN "category_breakdown" TEXT;
