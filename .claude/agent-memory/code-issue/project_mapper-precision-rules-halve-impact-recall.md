---
name: mapper-precision-rules-halve-impact-recall
description: A precision rule put in the shared BM25 requirement→code scorer silently halves Impact Analysis recall; make it a searcher option set by the display path.
metadata:
  type: project
---

`mapRequirementToCode` and the two BM25 searchers in `server/src/lib/traceability/requirement-code-mapping.ts` are shared by the analysis "affected code" panel, Impact Analysis seeding, the schema-impact producer, the escalation context, the LLM seeder (#931) and the entity-seed union. For #1063 a "share two terms" filter applied in `scoreBm25Corpus` for everyone moved the two evals in opposite directions:

- `pnpm eval:reqmap`: macro precision 0.71 to 0.87, recall 1.00 to 0.90 (passes).
- `tsx scripts/eval-impact-recall.ts --no-filter`: table recall 0.91 to 0.50, code recall 0.73 to 0.27 (fails its floors).

**Why:** impact seeding is recall-first (its blast radius is scored on recall only) and its fixture's right answers are often one-shared-word matches on the entity noun. The same is true in real data: on the #706 run-7 Miniflux graph the rule dropped `flushSessions` and the two `*_sessions` tables along with the wrong `InlineKeyboardButton`.

**How to apply:** put a precision rule behind a searcher option (`Bm25SearcherOptions.minSharedTerms`) and set it only where a person reads the link (`computeAffectedCodeContext`). Run BOTH evals before and after any change to the scorer; `eval-impact-recall` needs `--no-filter` offline. Do not change `normalizeConfidence` to an absolute scale: `LlmCodeSymbolSearcher` and `EntitySeedUnionSearcher` place score bands relative to the best hit and `minConfidence`.
