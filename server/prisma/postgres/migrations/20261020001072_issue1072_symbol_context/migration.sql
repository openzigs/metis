-- Issue #1072 — what a symbol's own file says about it, stored on the symbol.
-- Postgres twin of `server/prisma/migrations/20261020001072_issue1072_symbol_context`;
-- the reasoning and the rollback are written there. Idempotent.
--
-- Four nullable TEXT columns with no default: a metadata-only change on
-- Postgres, with no table rewrite and no long lock on "code_symbols".
ALTER TABLE "code_symbols" ADD COLUMN IF NOT EXISTS "signature" TEXT;

ALTER TABLE "code_symbols" ADD COLUMN IF NOT EXISTS "docComment" TEXT;

ALTER TABLE "code_symbols" ADD COLUMN IF NOT EXISTS "receiver" TEXT;

ALTER TABLE "code_symbols" ADD COLUMN IF NOT EXISTS "package" TEXT;

-- The `SYMBOL_CONTEXT_VERSION` a graph's context columns and embedding texts
-- were last written with. NULL — every existing row — reads as older than any
-- version, so the graph's next incremental ingest fills the columns in.
ALTER TABLE "code_graphs" ADD COLUMN IF NOT EXISTS "symbolContextVersion" INTEGER;
