---
name: brd-plan-tests-and-docs-gen-offline-replay
description: What the #1113 review of the BRD topic plan (#1070) taught — never move existing tests behind =off of a new setting, plan budgets are targets, a new generation setting ships off — plus the test traps of the plan path and how to replay a past run's docs-gen Phase 2 with no model call.
metadata:
  type: project
---

A business-requirements document CAN be planned before it is written since #1070 (`DOCS_GEN_TOPIC_PLAN`, **off by default**; only `on` turns it on). A past run's planning can be replayed offline from `docs_gen_fact_cache`.

**Why:** the first version of PR #1113 shipped the plan default-on, moved a nine-test `#741` describe behind `vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off")` and called the failures fixture shapes. The review deleted that stub: three body-fill assertions failed (13,156 / 18,833 / 21,451 against > 27,000 of 30,000) and the run-7 replay kept 12k less than what shipped. The tests were right; the design regressed #995.

**How to apply — the three rules:**

- **When a PR moves existing tests behind `=off` of a new setting, delete that stub and run them on the new path.** Here it exposed a regression of the invariant they guard (#995: a body must use its budget while topics are cut). Keep them on BOTH paths with `describe.each`, and change only an assertion that is legitimately different (there: modules planned out are listed, not read), saying why in the test.
- **A budget plan that discards overrun text before the document is assembled can keep less than a post-hoc fit.** Make plan budgets targets, keep the caps as the only hard limits, and prove "keeps at least as much" as a property over generated inputs against the old fit of the same text (`document-plan.test.ts`). Two details cost a round each: compare CONTENT as well as length (a cut that lists twelve long topic names in its note is as long and holds less), and compare with the old result as it would actually be returned.
- **A new default-on generation setting with no model run behind it ships off.** Off must then be byte-identical to the base commit, proven against output the BASE code produced (a committed fixture written by running the same test file on an archive of the base tree), not against the new code with the setting off.

**How to apply — tests of the plan path:**

- A fixture model that "ignores its budget" under the plan gets cut off by the OUTPUT-token cap, not by the fit: planned shares are small, so the batch planner packs many modules into one call. Set `DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS=100000`, as the section-cap tests already do. A section that is a heading and a note with the document under its cap is that, or modules planned out, before it is the fit.
- A linear-time test that fails only under load (267 ms at 200k, 7 ms at 50k) is still telling the truth: `scanLine` re-searched for a backtick at every dollar sign. The bound hid it on an idle machine.
- Under the plan each module's OUTPUT estimate is scaled to its share, so the output budget no longer splits a section: a fixture gets ONE batch unless the INPUT cap binds. `DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP=6000` (and `DOCS_GEN_LOCAL_FACTS_CHAR_CAP` for a hybrid router) gives two or three modules a batch.
- The prompts state budgets (`LENGTH LIMIT`, `PLANNED SHARE`) only when the document budget binds. With the default 250k cap and a small fixture every module is planned what it was estimated, and no budget line is written: set `DOCS_GEN_DOCUMENT_MAX_CHARS` (40000 for 12 modules).
- A `FaithfulnessResult` mock with a wrong field name (`unsupported` for `unsupportedClaims`) passes every above-threshold case and throws inside `gradeFaithfulness` below the threshold. The throw is caught: the section gets `grounding-failed`, its score is null, and judge-gated escalation silently does not fire. It reads as a routing bug. Copy `verified()` from `holistic-synthesizer-batched-sections.test.ts`.
- At most three sections escalate per document (`DEFAULT_MAX_ESCALATIONS`): a test where every local section falls short never escalates the last ones.

**How to apply — replaying a run with no model call:**

- `docs_gen_fact_cache` holds one row per Phase-1 CHUNK (run 7: 109 rows, 102 modules). Group by `modulePath`, order by `createdAt`, and rebuild each `ModuleFacts` with `mergePhase1ChunkFacts(rows.map(r => r.facts))`, `formulasJson` and `minedRulesJson` concatenated. That is enough for `planSectionBatches`, `planDocumentTopics` and `buildFactSheet`.
- The published version's `provenanceManifest.sectionSynthesis.records[].markdown` is each section AFTER the section cap and BEFORE the document cap, with citation markers intact; `sections[].omittedTopics` is what both caps left out. Run 7's 87 dropped topics were 53 at the section cap (names only) and 34 at the document cap (text still in the record).
- A run's Phase-2 cost is in `token_usages` by `sessionId` prefix: `docs-facts-` (Phase 1), `docs-synth-` (section calls), `docs-grounding-` (claim extraction and judge). Run 7's BRD: 22 section calls, 1.36M input tokens, $0.67; grounding 88 calls, $0.46.
- The deterministic extractors already hold source-line facts the model then restates: `ExtractedFormula` (`name`, `expression`, `symbolContext` = `file::function`) and mined rules of kind `const` (`summary` = ``Constant `NAME` = value``). Run 7's scheduler interval is `internal/model/feed.go:131`, name `interval`, in `ScheduleNextCheck`.

## Topic budgets and the consistency check (PR #1316, refs #995/#1070)

- **Replay a past run's PLANNING with `tsx`:** dump `docs_gen_fact_cache` with `sqlite3 -readonly -json` (by `projectId`, `model`), merge rows with `mergePhase1ChunkFacts`, and call `planDocumentTopics` with a fake router (`sectionMaxChars` 60000, `documentMaxChars` 250000). It reproduced run 8's plan exactly.
- **Compare rendered length with planned budget through `renderedCitationLength(record.markdown)`** (`citation-footnotes.ts`), never raw length: drafts are 26-40% longer from citation tokens. Measured overshoot: DeepSeek 1.30-1.45× its catalogue budgets, Haiku 1.00-1.16×.
- **`allocateTopicBudgets` floors (`document-plan.ts`).** A per-topic minimum near the average share (section budget / topic count) flattens every kept topic to that minimum. Derive floors from a low percentile of measured output, and test with uneven estimates that the largest kept topic gets several times the smallest.
- **`FLOOR_SHARE` must apply only when the budget is short,** or the planner drops topics from sections whose demand fits. Budget fixtures need an everything-fits case too: every Miniflux replay is short.
- **A consistency check limited to facts-sheet names misses the prose contradictions walkthroughs report.** Before shipping any detector, run it over the stored run-8, run-9 and Haiku BRD records for false positives.

Links: [[project_read-live-is-not-read-completely]], [[project_never-dropped-silently-needs-a-fixture-per-cap]], [[project_deterministic-gate-over-llm-output-probes]].
