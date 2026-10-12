---
name: brd-plan-tests-and-docs-gen-offline-replay
description: How to replay a past run's docs-gen Phase 2 planning with no model call (fact cache rows, manifest records, ledger session prefixes), and four test traps the BRD topic plan (#1070) sets for anything that drives synthesizeFinalDocument.
metadata:
  type: project
---

A business-requirements document is planned before it is written since #1070 (`DOCS_GEN_TOPIC_PLAN`, default on), so every test that drives `synthesizeFinalDocument` with `"business-requirements"` now goes through the plan, and a past run's planning can be replayed offline from `docs_gen_fact_cache`.

**Why:** #1070 spent most of its debugging time on four things that looked like product bugs and were fixture shapes, and on finding where a finished run's Phase-2 inputs are.

**How to apply — tests:**

- A test that pins the caps applied AFTER writing (`fitSectionToBudget` on a merged section, `fitSectionsToDocumentBudget`) must `vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off")`. Under the plan a section is budgeted first and the caps are a guard that usually does nothing; four `#741` tests in `holistic-synthesizer-batched-sections.test.ts` failed for that reason alone.
- Under the plan each module's OUTPUT estimate is scaled to its share, so the output budget no longer splits a section: a fixture gets ONE batch unless the INPUT cap binds. `DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP=6000` (and `DOCS_GEN_LOCAL_FACTS_CHAR_CAP` for a hybrid router) gives two or three modules a batch.
- The prompts state budgets (`LENGTH LIMIT`, `PLANNED SHARE`) only when the document budget binds. With the default 250k cap and a small fixture every module is planned what it was estimated, and no budget line is written: set `DOCS_GEN_DOCUMENT_MAX_CHARS` (40000 for 12 modules).
- A `FaithfulnessResult` mock with a wrong field name (`unsupported` for `unsupportedClaims`) passes every above-threshold case and throws inside `gradeFaithfulness` below the threshold. The throw is caught: the section gets `grounding-failed`, its score is null, and judge-gated escalation silently does not fire. It reads as a routing bug. Copy `verified()` from `holistic-synthesizer-batched-sections.test.ts`.
- At most three sections escalate per document (`DEFAULT_MAX_ESCALATIONS`): a test where every local section falls short never escalates the last ones.

**How to apply — replaying a run with no model call:**

- `docs_gen_fact_cache` holds one row per Phase-1 CHUNK (run 7: 109 rows, 102 modules). Group by `modulePath`, order by `createdAt`, and rebuild each `ModuleFacts` with `mergePhase1ChunkFacts(rows.map(r => r.facts))`, `formulasJson` and `minedRulesJson` concatenated. That is enough for `planSectionBatches`, `planDocumentTopics` and `buildFactSheet`.
- The published version's `provenanceManifest.sectionSynthesis.records[].markdown` is each section AFTER the section cap and BEFORE the document cap, with citation markers intact; `sections[].omittedTopics` is what both caps left out. Run 7's 87 dropped topics were 53 at the section cap (names only) and 34 at the document cap (text still in the record).
- A run's Phase-2 cost is in `token_usages` by `sessionId` prefix: `docs-facts-` (Phase 1), `docs-synth-` (section calls), `docs-grounding-` (claim extraction and judge). Run 7's BRD: 22 section calls, 1.36M input tokens, $0.67; grounding 88 calls, $0.46.
- The deterministic extractors already hold source-line facts the model then restates: `ExtractedFormula` (`name`, `expression`, `symbolContext` = `file::function`) and mined rules of kind `const` (`summary` = ``Constant `NAME` = value``). Run 7's scheduler interval is `internal/model/feed.go:131`, name `interval`, in `ScheduleNextCheck`.

Links: [[project_read-live-is-not-read-completely]], [[project_never-dropped-silently-needs-a-fixture-per-cap]], [[project_deterministic-gate-over-llm-output-probes]].
