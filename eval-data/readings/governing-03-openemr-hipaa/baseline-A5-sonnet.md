# Governing-rules eval — `governing-03-openemr-hipaa`

Set: **held-out** (read for a decision, never tuned on; content hash `71c07441178945b2367af50c2848208b056b6a7a1b8f295011899dbba45c4135`). Record this reading in the set's ANNOTATION.md.

Code: commit `1a6766257ae3f21e8796b3bdae158555b6ea89a7`, clean tree; combined from 3 invocations (`governing-governing-03-openemr-hipaa-2026-11-09T11-20-17-809Z.json`, `governing-governing-03-openemr-hipaa-2026-11-09T11-21-45-718Z.json`, `governing-governing-03-openemr-hipaa-2026-11-09T11-23-18-522Z.json`).

Requirements: **25** · Rules: **32** (`policy-v1.md`, revision v1) · Runs requested: **3** · Budget: **$18** · Spent: **$1.9480**

Labels: **not yet reviewed by a person** (see ANNOTATION.md).

## Results (mean over runs; 95% bootstrap interval over requirements)

| Arm | Runs | Recall | Non-resembling recall | Precision | Citation accuracy | Citation coverage | Verdict accuracy | Hard errors | Ask rate | Clean negatives | Failures | $ / req | Tokens in / out per req | s / req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A5 | 3 | 0.80 [0.65, 0.92] | 0.50 [0.00, 1.00] | 0.52 [0.38, 0.71] | 1.00 [1.00, 1.00] | 1.00 [1.00, 1.00] | 0.31 [0.17, 0.47] | 0 | 0.72 [0.63, 0.81] | 7/7/7 of 8 | 0 | $0.0260 | 6007 / 1638 | 13.0 |

Hard errors: `compliant` on a pair whose truth is `gap` or `needs-ba-input`, summed over runs. Clean negatives: negative requirements on which the arm ran and applied no rule, per run (a failure is an error, never a clean negative).

## Proposed pass thresholds (proposed, #1867)

| Arm | Bar | Required | Measured | Pass |
|---|---|---|---|---|
| A5 | overallRecall | ≥ 0.90 | 0.80 | **no** |
| A5 | nonResemblingRecall | ≥ 0.85 | 0.50 | **no** |
| A5 | precision | ≥ 0.60 | 0.52 | **no** |
| A5 | citationAccuracy | ≥ 0.95 | 1.00 | yes |
| A5 | maxNoEvidenceCompliantErrors | ≤ 0 per run | 0 (worst run) | yes |

## Short-answer pairs, with the BA's answer replayed (#2033)

This set has no short-answer pairs (`baAnswer`), so no answer was replayed.

## Paired comparison with A0

> At 17 items and a hit rate near 0.5 the standard error is about 12.1 points per arm, so a gap needs roughly 24 to 34 points to be significant. A smaller difference is reported as "no measurable difference", not as a win.

No other arm was run: this report is A0's baseline.

## Summary-screen prompt size

| Rules | Characters | Estimated tokens |
|---|---|---|
| 40 | 4850 | 1213 |
| 200 | 18001 | 4501 |
| 500 | 42582 | 10646 |

Estimated at the repository's 4-characters-per-token heuristic; no model was called.

## Arms

### A5 — the shipped path: applicability, findings, the BA's questions and the refresh

| Setting | Value |
|---|---|
| searcher | production BM25 options (createInMemoryBM25) over rule id + summary, standing in for governingIndexRetriever |
| topK | 8 |
| applicability | decideApplicability, rules with production's source line |
| findings | findingPairsOf + evaluateRequirementFindings, as produceGoverningFindingsForAnalysis |
| questions | openGoverningPairs + openFindingPairs + buildGoverningQuestions: production's question text |
| answers | a question linking a rule with a baAnswer is given that answer; rejudgeAnswered + answersForApplyingPairs + applySettlements; findings produced again when a settlement applied |
| reading | readFindings: status as verdict, the verified clause as citation |
| model | anthropic/claude-sonnet-5-5 |

Code path:

1. governing/applicability.ts decideApplicability (#1872)
2. governing/applicability-store.ts toStoredApplicability
3. governing/findings-store.ts findingPairsOf + governing/findings.ts evaluateRequirementFindings (#1874)
4. governing/applicability-questions.ts openGoverningPairs + openFindingPairs (#2059) + buildGoverningQuestions (#1873)
5. governing/applicability-questions.ts rejudgeAnswered + answersForApplyingPairs (#2059) + governing/applicability-store.ts applySettlements (#1873)
6. governing/findings-store.ts findingPairsOf + governing/findings.ts evaluateRequirementFindings (the refresh after an answer)

Non-resembling pairs missed in every run: OE-01 → TS-07.

Hard errors: none.
