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

**How to apply:** put a precision rule behind a searcher option (`Bm25SearcherOptions.minSharedTerms`) and set it only for the links that are PERSISTED AND SHOWN to a person. Run BOTH evals before and after any change to the scorer; `eval-impact-recall` needs `--no-filter` offline. Do not change `normalizeConfidence` to an absolute scale: `LlmCodeSymbolSearcher` and `EntitySeedUnionSearcher` place score bands relative to the best hit and `minConfidence`.

Two facts the first version of this note got wrong, both found in review of PR #1095:

- **`computeAffectedCodeContext` has two readers, not one.** Its result is the displayed "affected code" links AND the code agent's AFFECTED CODE seed block (`agentic-pass-context.ts`, `orchestrator.ts`) and citation-provenance file list. Setting the option on its one searcher withheld `flushSessions`, `user_sessions` and `web_sessions` from the very agent #1063 reports as "Could not verify", and seeded three of five imported items with nothing. It now maps each requirement twice from one corpus load (`MemoizingBm25CodeSymbolSearcher.withOptions`): with the rule for `result`, without it for `block` and `filePaths`. Before narrowing what an agent is seeded with, measure it with a model.
- **The BM25 document includes the file path.** It is `name + qualifiedName`, and `qualifiedName` is `<filePath>::<name>`, so a "shared name terms" rule must count NAME tokens only (`symbolNameTerms`: the name, its enclosing type or table, a module's base name; never a directory, the containing file or the extension). Counting document terms let `internal`, `client` or `go` be the second shared term, and one ordinary extra word ("in the web client") brought the wrong link back. Write the probe with a path word in the requirement.

Counting name terms only has its own cost, measured on the run-7 main project: a symbol whose second term was its file name is dropped (`markAllAsRead` in `unread_mark_all_read.go`, for criteria that say "unread" but not "mark").
