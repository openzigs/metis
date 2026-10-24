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

## Batch hold and length overrun (PR for #1327, 2026-10-21)

- **Replay the ASSEMBLY of a planned run from its stored records alone.** A version's `sectionSynthesis.records[]` carry `parts` (`budgets`, run-length `runs`; `decodePartRuns`): split each catalogue record back into its batch replies (re-emit the H3/H4 a part wrote under when another part first wrote it), re-merge with `mergeBatchBlocks`, `fitSectionToPlan` at 60k, then `fitDocumentToPlan` with the logged `bodyMaxChars`. With no change applied it reproduces run B exactly (84 cut, same keptChars) — run that control first.
- **Overrun measured on stored records under-reads it:** the records are AFTER the section cap. Use the `Batched section synthesized` `replyChars` at each record's raw/rendered ratio: run B DeepSeek was 1.50–1.64×, not 1.30–1.45×. The log now has `renderedReplyChars`.
- **Discarding text at write time breaks 7 tests** (`cuts nothing while the document fits`, the #741 body-fill pair): the #1113 rule again. The hold REORDERS (overflow to the part's tail) and lets the caps cut.
- **Skip-and-continue packing vs a priority prefix (#1353 review).** `continue` past a topic that does not fit replayed better (84 → 64, Content Entities kept) but keeps a small minor topic ahead of a large core one, so the cap cuts the core one first: a blocking defect. The prefix (`break`) gives 84 → 72 and loses Content Entities: it ties at rank 0 with two larger topics written before it, and the second ends the prefix. Min-cited rank is coarse; ties fall back to written order.
- **Below its share the doc cap still cuts in reading order:** kept topics stay in written order (reviewer's reading-order rule), so when the cap cuts every part under its share the cut is positional again.
- **`factsSourceIdOf` in holistic-synthesizer does not match the minted id** for a module with no repository (`src/m00` vs `facts:src_m00:0`); rank citations with `factsSourceId` from grounding-context.
- **Plan budgets overflow the body by the footnote definitions:** run B planned 244,231 vs `bodyMaxChars` 234,277 (the reserve counted module definitions only; the pinned lines, canonical facts and excerpts were missing, see #1352 below), so a perfectly calibrated run was still cut ~10k at assembly. Fixed by #1352.

Links: [[project_read-live-is-not-read-completely]], [[project_never-dropped-silently-needs-a-fixture-per-cap]], [[project_deterministic-gate-over-llm-output-probes]].

## Footnote reserve and single-call length (PR for #1352, 2026-10-21)

- **A footnote definition is one per READABLE reference (`renderParts`), not per citation id.** `facts:<module>:<idx>` from four sections renders as one `` `module` (module facts) `` definition. What grows: line-pinned module refs (`path:line — module`), canonical facts, retrieved excerpts. Run B published: 96 module, 39 pinned, 16 canonical, 13 rag.
- **Measure definitions from a published version's content:** lines matching `^\[\^src-\d+\]: `. The pre-cut need is `documentMaxChars - bodyMaxChars` from the log.
- **The reserve must come from the modules alone** (`footnoteReserveChars`): a test holds that the facts sheet never moves a budget (reuse-hash invariant).
- **The floor cliff:** `FLOOR_SHARE` 0.5 x 100 topics x `MIN_TOPIC_CHARS` 215 = 43,000. Run B's catalogue budget fell 43,058 to 40,508 and planned-out rose 2 to 8 per section (storage out of Rules, worker out of Formulas).
- **Below the cliff it is linear** (#1366 review): once estimates do not fit, `allocateTopicBudgets` keeps floor(`FLOOR_SHARE` x budget / `MIN_TOPIC_CHARS`) topics, one planned-out topic per 430 chars of section budget. Compare planned-out against section-end cuts in one unit: modules missing from the whole document.
- **Replaying "a model that writes to its plan"** needs an exact fill (whole units, then the next paragraph to the room), or whole-unit truncation leaves slack that hides the reserve. Committed: `server/scripts/eval-brd-plan-replay.ts` (reads dev.db read-only; plan + assembly, every reserve/note configuration).
- **Score a plan change by whole H3 themes lost (not written + cut at ends), not by planned-out pairs.** Run B: note only 47 themes, reserve + note 44; the reserve costs 24 more module-section pairs, 3 modules out of every catalogue section.

## Rank ties in the batch hold (PR for #1368, 2026-10-21)

- **The replay must rank canonical-fact citations as the synthesizer does** (`rankOfSource`: a `facts:canon:` id ranks as its module). Before #1368 it ranked module facts only, so Data Model's "Entry and Media Entities" (cites `internal/model` canon facts, rank 0) read as rank 20 behind three rank-15 topics, and no tie rule could write it. Map canon id → module from `selectedEvidence.primary[].label` (`file:line — NAME`, dirname). `--no-canonical-rank` reproduces the old replay.
- **"kept" by H3 presence lies:** `repliesOf` re-emits a theme's H3 in a later batch over one line, so "Content Entities: kept" was a 43-character stub. The replay now prints `kept (own-upTo)` rendered characters (own = what the heading's batch wrote, by `fit.parts[i].partOf`); check it before claiming a theme survives.
- **Smallest-first among tied ranks, only when it keeps MORE tied topics than the written-order prefix** fixed it (44 → 38 themes lost, both entities written). Plain smallest-first was rejected in review: it trades a large core topic written first for a small one one-for-one. Ranking by most-cited module gave 29 but redefines importance; not taken.

## Single-call reader-BRD length (PR for #1449, 2026-10-23)

- **Overrun does not carry over from batches.** DeepSeek's overrun on single-call reader-BRD
  main sections varied 1.10–1.50× between two runs with identical length notes (per section
  1.02–1.84×). Batch-measured overrun factors do not apply to single-call sections.
- **Separate model variance from prompt changes offline.** A section's facts input can be
  rebuilt from `docs_gen_fact_cache` plus the repo clone; per-section drafts are in the
  provenance manifest's `sectionSynthesis.records[].markdown`. Compare rendered length with
  the words the `LENGTH LIMIT` note asked for.
- **The note rounds.** Each section's ask is rounded to 50 words at 6 chars/word, so a cap
  derived exactly as target/floor asks for slightly LESS than the floor. Leave a margin (1.05)
  and assert the rounded words×6 total, not the ratio (#1449 and its review).
