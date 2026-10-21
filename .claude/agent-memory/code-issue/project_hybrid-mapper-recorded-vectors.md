---
name: hybrid-mapper-recorded-vectors
description: The #1097 hybrid requirement→code mapper — how to measure it with no paid model, and three traps (silent BM25 fallback, absolute floors vs the blast radius, run-7 replay data).
metadata:
  type: project
---

Since #1097 `mapRequirementToCode` ranks with `HybridCodeSearch` through `HybridCodeSymbolSearcher` (`traceability/requirement-code-searcher.ts`) and falls back to BM25. Facts a future change to it will need:

**HybridCodeSearch swallows embed failures.** An embed or vector-store error is logged and the search answers `bm25-only`. An eval that replays recorded vectors therefore scores a STALE recording as a quiet BM25 run. `RecordedEmbedService.missing` + `assertFullyRecorded` (`eval/recorded-vectors.ts`) is the guard; any new recorded-vector eval must call it. The mapper's query text is `title + "\n\n" + body` (`requirementQueryText`), not the raw requirement: record through the real path (`--record-vectors`), never by embedding strings by hand.

**Absolute confidence breaks anything relative to the best hit.** `blastRadius` used `topConfidence` as its seed, so absolute seeds (~0.1-0.4) dropped every caller under the 0.4 radius floor and reqmap/impact-recall collapsed. `computeProjectImpact` now walks from 1 and scales the reported caller confidence. Look for other `/ max`, `topConfidence`, `seedConfidence` uses before changing the scale again.

**A weak direct hit brings its callers.** On `eval:reqmap` a 0.07 link pulled two wrong caller files (P 0.87 -> 0.70); that is why the hybrid display floor is 0.08, not 0.05.

**Measuring with no paid model.** Local weights live in `~/.cache/metis-transformers` (`EMBED_BACKEND=xenova`, `HF_HUB_OFFLINE=1`). The #706 run-7 Miniflux projects (`cmv2nx3ad…`, `cmv2x496u…`) and their `__symbols.lance` dirs are in the main checkout's `server/dev.db` / `server/data/lancedb`: copy the code_symbols/code_edges rows into a scratch DB (ATTACH read-only) and the two lance dirs, then `server/scripts/eval-reqmap-replay.ts` against the committed labels (`eval-data/reqmap-replay/`).

**Worktree guard.** A Bash command whose text contains the word `eval` (e.g. a vitest filter `src/lib/eval`) is refused in an isolated worktree; filter by a substring such as `reqmap` or `recorded-vectors`.
