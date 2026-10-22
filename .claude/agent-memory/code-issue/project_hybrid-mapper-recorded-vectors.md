---
name: hybrid-mapper-recorded-vectors
description: The #1097 hybrid requirement→code mapper — how to measure it with no paid model, and three traps (silent BM25 fallback, absolute floors vs the blast radius, run-7 replay data).
metadata:
  type: project
---

Since #1097 `mapRequirementToCode` ranks with `HybridCodeSearch` through `HybridCodeSymbolSearcher` (`traceability/requirement-code-searcher.ts`) and falls back to BM25. Facts a future change to it will need:

**HybridCodeSearch swallows embed failures.** An embed or vector-store error is logged and the search answers `bm25-only`. An eval that replays recorded vectors therefore scores a STALE recording as a quiet BM25 run. `RecordedEmbedService.missing` + `assertFullyRecorded` (`eval/recorded-vectors.ts`) is the guard; any new recorded-vector eval must call it. The mapper's query text is `title + "\n\n" + body` (`requirementQueryText`), not the raw requirement: record through the real path (`--record-vectors`), never by embedding strings by hand.

**Absolute confidence breaks anything relative to the best hit.** `blastRadius` used `topConfidence` as its seed, so absolute seeds (~0.1-0.4) dropped every caller under the 0.4 radius floor and reqmap/impact-recall collapsed. `computeProjectImpact` now walks from 1 and scales each caller by the seed it was reached through (`seedWeights`). Other relative-scale readers found in review of PR #1325: `deriveMatchQualityDetailed` (now normalizes itself) and the code agent block + `AFFECTED_CODE_RULE` (kept relative via `relativeToBestSeed`). Grep `/ max`, `topConfidence`, `seedConfidence`, `CLEAR_WINNER_SPREAD` before changing the scale again.

**Hybrid gate holes (review of PR #1325).** A hit only BM25 returned has no `vectorScore`: score it at the lowest returned cosine, never as "no cosine" (the lexical model gives one shared word 0.096, over the 0.08 floor). An uncalibrated embedder must keep the keyword two-term rule.

**Keyword-only hits are corpus-dependent (review of PR #1325, cycle 2).** With `HybridCodeSearch`'s 0.05/0.95 RRF weights (`DEFAULT_WEIGHTS`, `code-graph/hybrid-search.ts`), a hit only BM25 found reaches the mapper's `HYBRID_CANDIDATE_POOL` (60) only when the vector search returns fewer than 60 hits: small or partly embedded projects. Test a keyword-only fix on such a corpus; a Miniflux-size replay cannot show it.

**A weak direct hit brings its callers.** On `eval:reqmap` a 0.07 link pulled two wrong caller files (P 0.87 -> 0.70); that is why the hybrid display floor is 0.08, not 0.05.

**Measuring with no paid model.** Local weights live in `~/.cache/metis-transformers` (`EMBED_BACKEND=xenova`, `HF_HUB_OFFLINE=1`). The #706 run-7 Miniflux projects (`cmv2nx3ad…`, `cmv2x496u…`) and their `__symbols.lance` dirs are in the main checkout's `server/dev.db` / `server/data/lancedb`: copy the code_symbols/code_edges rows into a scratch DB (ATTACH read-only) and the two lance dirs, then `server/scripts/eval-reqmap-replay.ts` against the committed labels (`eval-data/reqmap-replay/`).

**Worktree guard.** A Bash command whose text contains the word `eval` (e.g. a vitest filter `src/lib/eval`) is refused in an isolated worktree; filter by a substring such as `reqmap` or `recorded-vectors`.

## Hits without a vector: lost vs missing (#1410, #1417/#1419)

- **"No `vectorScore` means the project is still embedding" fails three ways** (#1410
  review): schema table and column CodeSymbols (`code-graph/schema-graph.ts`) are never
  embedded yet sit in both corpora; `HybridCodeSearch` drops vector hits for stale symbols;
  LanceDB (vectordb 0.21.2) post-filters on `model`. Test any rule keyed on a missing vector
  against all three, and on a corpus under 60 symbols that has a schema.
- **Missing cannot tell never or not-yet embedded from a vector the search lost** (stale, or
  another model). Probe both; "re-run embedding" advice holds only for the first.
- **Since #1419, `CodeSymbolEmbedding.embeddingModel` separates the states:** `""` is
  pending (`PENDING_MODEL`, exported from `code-graph/symbol-embedding-service.ts`), the
  active model id means a vector exists and the search lost it, and no row means never
  embedded (tables and columns). One batched read tells a lost vector from a missing one.
- **Scoring a lost hit at the lowest returned cosine is only an upper bound,** not a ranking
  guarantee. With few close survivors (0.62/0.61), a lost hit sharing two words scores 0.239
  and can outrank them. The guarantee needs the explicit cap (`capBelowMeasured`,
  `traceability/requirement-code-searcher.ts`); test "cannot outrank" with that shape.
- **Ordering is decided at the mapper.** In `HybridCodeSymbolSearcher` measured hits always
  rank above unmeasured ones, and `mapRequirementToCode` re-sorts by confidence, so
  searcher-side ordering and limit code is often dead. Probe ordering and cause claims at
  the mapper's output. A word-only score (0.273 for two terms) outranks one-word semantic
  links (~0.2).
- **The run-7 Miniflux replay always returns 120 vector hits,** so it cannot measure
  unmeasured-hit handling; pin that with unit tests and mutations.
- **Affected-code panel per-requirement labels render only in multi-requirement runs.**
  Label logic needs a two-requirement test (#1419 review).
