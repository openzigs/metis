-- Issue #1072 — what a symbol's own file says about it, stored on the symbol.
--
-- Until now a symbol row held its name, kind, path and line span. Its search
-- documents could carry nothing else, because nothing else was stored and the
-- source file is gone by the time a document is built. These four columns hold
-- the declaration, the doc comment, the type a method is declared on, and the
-- package. Each is one line and bounded by `code-graph/symbol-context.ts`.
--
-- NULL — every existing row — means "not extracted". No backfill here: the
-- values come from the repository's source, which a migration cannot read. The
-- next ingest of a graph fills them in (see "symbolContextVersion" below).
-- Nullable columns with no default are a metadata-only change.
--
-- Rollback (documentation):
--   ALTER TABLE "code_symbols" DROP COLUMN "signature";
--   ALTER TABLE "code_symbols" DROP COLUMN "docComment";
--   ALTER TABLE "code_symbols" DROP COLUMN "receiver";
--   ALTER TABLE "code_symbols" DROP COLUMN "package";
-- After it the BM25 document is name + qualified name again. Embedding texts
-- written since keep their `package:` / `doc:` lines until a full re-ingest.
ALTER TABLE "code_symbols" ADD COLUMN "signature" TEXT;
ALTER TABLE "code_symbols" ADD COLUMN "docComment" TEXT;
ALTER TABLE "code_symbols" ADD COLUMN "receiver" TEXT;
ALTER TABLE "code_symbols" ADD COLUMN "package" TEXT;

-- The `SYMBOL_CONTEXT_VERSION` (`server/src/lib/code-graph/ingest.ts`) a
-- graph's context columns and embedding texts were last written with. NULL —
-- every existing row — means "built before #1072" and reads as older than any
-- version: the graph's next incremental ingest fills the columns in for every
-- unchanged file, on the existing rows, and rewrites the embedding texts that
-- change, so those symbols are embedded again once.
--
-- Rollback: ALTER TABLE "code_graphs" DROP COLUMN "symbolContextVersion" —
-- an existing graph then gains the columns only file by file, as files change.
ALTER TABLE "code_graphs" ADD COLUMN "symbolContextVersion" INTEGER;
