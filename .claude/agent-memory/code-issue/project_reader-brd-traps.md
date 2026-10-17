---
name: reader-brd-traps
description: Reader BRD (#1175/#1223/#1218) and docs-gen cost traps — prompt overrides, regex timing, per-run requirement rows, deterministic sections and #857 reuse, cost caps.
metadata:
  type: project
---

Collected from #1214, #1226 (#1223), #1228 (#1218) and the #1074 Sonnet run (2026-10-16/17).

**Prompts.** The shared section system prompt in `holistic-synthesizer.ts` (verbose rules 3 and 6: "Inline code for entity names…", "quote actual entity names verbatim") pushes every section toward code names. A section written for business readers must override it explicitly in its own instructions (`MAIN_PART_LANGUAGE_RULES`). Keep an explicit exception for Mermaid diagrams that a section asks for.

**Regex timing in markdown scanners.**
- A "linear" claim usually covers only the flagging regexes, not the ones that skip spans first.
- A pattern whose scanned character class includes its own opener (`\([^)]*\)`, `\[\^[^\]]+\]`) goes quadratic on repeated unclosed openers. So does a lazy `open[\s\S]*?close`.
- Time each pattern on `opener.repeat(n)` at two sizes, and check that the time doubles rather than quadruples.
- A timing test must fail against the pre-fix regex. A pattern whose opener is also its closer (`$$…$$`) can never go quadratic, so a test built from that shape guards nothing.

**Requirement rows belong to a run.** A re-run deletes and recreates rows per `analysisId`. A project-wide `reviewStatus: "approved"` query therefore returns duplicates and superseded copies. Pick one run first, as `defaultHubRunId` and `approved-requirements-section.ts` do.

**Deterministic (no-model) sections.**
- These must still push a `SectionSynthesisRecord`. `reusableSectionRecords` and the `synthesisRecords.length === groups.length` gate drop #857 reuse for the whole document if any group has no record, so every regeneration pays for every section.
- A deterministic section that reuses a main section's id must opt out of `findCodeIdentifiers` via `checkedForCode`.
- When a section is exempted from a check by index, keep a test in the other feature that pins the case that is not exempt (#1226's `count: 0`).

**Budgets.** A "floor of N each" constant passed to `fitDocumentToPlan` is pooled. Probe per-section floors with unequal section sizes (#1214).

**Cost caps and models (#1074).**
- A dollar stop enforced by polling the ledger between calls overshoots by up to one call: $12.46 against a $12 cap. Set `DOCS_GEN_MAX_RUN_COST_CENTS` itself to the hard limit.
- `DOCS_GEN_PHASE1_REASONING=off` sends `thinking:{type:"disabled"}`, which Sonnet 5.5 rejects with a 400 (#1224).
- `DOCS_GEN_ANTHROPIC_CLAIM_MODEL` and `_JUDGE_MODEL` pin model names and must be swapped along with the provider.
- A cancelled document cannot be exported.

Related: [[docs-gen-drop-retry-and-ledger]], [[redos-fix-ships-beside-new-pattern-fuzz-all]].
