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

**Run selection and staleness (#1230).**
- The run read is `defaultRequirementsRunIdFor` (`analysis/requirement-runs.ts`), the shared `defaultRequirementsRunId` rule the hub also calls. Do not add a second run query.
- The approved list is a reader BRD's input-snapshot item `approvedRequirements` (`generation-inputs.ts`). Changing what it hashes changes every reader BRD's fingerprint, so each auto-update reader BRD regenerates once.
- That item is rechecked mid-run by `inputsStand`. An approval during a reader BRD generation stops the run with `inputs-changed`; this is intended, not a bug.
- A requirement writer must call `noteRequirementsChanged` after commit. PATCH, PUT and review verdicts do; promote, change-analysis and import do not (yet).

Related: [[docs-gen-drop-retry-and-ledger]], [[redos-fix-ships-beside-new-pattern-fuzz-all]].

**Added 2026-10-18 (#1249):**
- When a deterministic section's hash doubles as an input-snapshot item, hash only the fields the renderer prints. Anything else turns unrelated writes (code links) into paid regenerations and aborts in-flight runs.
- A fixture that "proves" regeneration by calling `ingest()` / `checkIncrementalRegeneration` a second time hides the real path: a check during a running generation queues a task that loses the generation claim after 3 quick retries, and nothing re-checks after publish (#1252 N1). Assert what queues the follow-up check.
- A manual `POST /:docId/regenerate` reuses no sections unless it is routed through `reusePublished` / `previousManifest`, and the checkpoint is cleared on a clean publish. Any new Regenerate button on a `ready` document is a full paid run unless it goes that route (#1267).
- Since #1271 the Approved Requirements section asks the plan for `BRD_MAIN_SECTION_TARGETS.requirements` (16k), the same as the reconstructed section it replaces, rather than for its rendered length. Before that, every approval shifted each appendix section's budget and so its reuse hash. With equal asks, the plan is identical by construction: the first approval makes 0 model calls, and un-approving the last makes 1 (the reconstructed section). Test a "plan room" change by swapping between the two sections, not only by changing the length. An under-budget fixture can't show the coupling; use about 200 rich modules at 250k.
- Which reader-BRD sections a budget change re-plans depends on the cap. At 250k the appendix is the budget-limited part; at 60k the main part is. Measure any "only X is rewritten" copy at both caps (it was wrong twice on #1271).

## Code links, implementation rows and incremental-regeneration errors (#1287)

- A scoped reader BRD's approved list depends on code links. Any new writer of `RequirementCodeMapping` or `RequirementImplementation` must call `noteRequirementsChanged`. Today those writers are `seed-code-links-from-findings.ts` and `living-spec/requirement-sync.ts`; `persistMappings` writes only with `opts.persist`.
- `RequirementImplementation` has no `projectId`. `resolveLinkedRequirements` (`living-spec/requirement-sync.ts`) matches PRs by issue number alone, across every project and repo. Never place or scope a requirement by an implementation row's file path. Trust a PR link only when its `prUrl` names one of the requirement's own project's live repo connections (`connectionsNamedByPrUrl`).
- In `checkIncrementalRegeneration`, every error except `SyntaxError`, `ZodError` and `InvalidStoredPathScopeError` is retried on every ingest. A plain `Error` thrown in `captureGenerationInputs` is retryable, so one corrupt stored row loops a scheduling retry. Validate new stored-input reads in the scope-parse block, and classify them as permanent.

## The main-part code-name check (`docs-gen/main-part-language.ts`, #1223, #1404, #1405)

- `findCodeIdentifiers` (rubric SO3) once missed names ending in an acronym
  (`MinifluxSessionID`) and names in emphasis. `**bold**` cannot hide a name (`*` is not
  `\w`), but underscore emphasis `__X__` did, through the `(?<![\w$])` look-behind. On an
  emphasis miss, check the underscore form first. Fixed in #1404.
- Measure a docs-gen heuristic's false positives by running the head and `main` copies side
  by side (`pnpm --filter ./server exec tsx`) over a real generated document plus a probe
  list of brand and business words. Unit negatives cover only the brands the author thought
  of. Known residual false positives: JPMorgan, SQLServer, MSTeams, LaTeX, KGaA, mySQL
  (#1404 review).
- A regex that starts with an unanchored identifier class (`[A-Za-z_$][\w$]*`) run over
  whole repository files is quadratic (100k chars took 4.2 s). Anchor it with `(?<![\w$])`
  and add a timing test (#1405 review); see [[linearity-tests-count-work-or-thread-cpu]].
- A scope-full reader BRD renders `RC-n` rather than Approved Requirements when a project's
  approved requirements sit only in older runs (#1230, seen on the #1223 run). To score
  SO1's approved branch, approve in the newest run.
