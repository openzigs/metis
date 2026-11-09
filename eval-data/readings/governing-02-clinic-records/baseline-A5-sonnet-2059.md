# Governing-rules eval — `governing-02-clinic-records`

Set: **held-out** (read for a decision, never tuned on; content hash `9fc02e66cfa37e312b27aa06a1292183ebabea8847c92146055069ac80afe1c9`). Record this reading in the set's ANNOTATION.md.

Code: commit `206adfd5abda6e6468b9ba97f56c3ba3c54351dd`, clean tree; combined from 3 invocations (`governing-governing-02-clinic-records-2026-11-09T02-52-37-029Z.json`, `governing-governing-02-clinic-records-2026-11-09T02-53-26-683Z.json`, `governing-governing-02-clinic-records-2026-11-09T02-54-11-865Z.json`).

Requirements: **36** · Rules: **40** (`policy-v1.md`, revision v1) · Runs requested: **3** · Budget: **$18** · Spent: **$2.5149**

Labels: **not yet reviewed by a person** (see ANNOTATION.md).

## Results (mean over runs; 95% bootstrap interval over requirements)

| Arm | Runs | Recall | Non-resembling recall | Precision | Citation accuracy | Citation coverage | Verdict accuracy | Hard errors | Ask rate | Clean negatives | Failures | $ / req | Tokens in / out per req | s / req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A5 | 3 | 0.94 [0.85, 0.99] | 0.92 [0.77, 1.00] | 0.61 [0.50, 0.74] | 1.00 [1.00, 1.00] | 1.00 [1.00, 1.00] | 0.75 [0.63, 0.86] | 0 | 0.51 [0.41, 0.60] | 6/6/6 of 6 | 0 | $0.0233 | 5694 / 1469 | 12.6 |

Hard errors: `compliant` on a pair whose truth is `gap` or `needs-ba-input`, summed over runs. Clean negatives: negative requirements on which the arm ran and applied no rule, per run (a failure is an error, never a clean negative).

A5: $ / req, tokens, s / req and the cap's per-requirement estimate include the replay of the BA's answers (#2033), so they are not comparable with readings of the same arm from before #2033.

## Proposed pass thresholds (proposed, #1867)

| Arm | Bar | Required | Measured | Pass |
|---|---|---|---|---|
| A5 | overallRecall | ≥ 0.90 | 0.94 | yes |
| A5 | nonResemblingRecall | ≥ 0.85 | 0.92 | yes |
| A5 | precision | ≥ 0.60 | 0.61 | yes |
| A5 | citationAccuracy | ≥ 0.95 | 1.00 | yes |
| A5 | maxNoEvidenceCompliantErrors | ≤ 0 per run | 0 (worst run) | yes |

## Short-answer pairs, with the BA's answer replayed (#2033)

Each pair's `businessFact` is asked and its `baAnswer` given; the finding after the answer is scored against the pair's `answeredVerdict`. The results above read the findings before any answer.

A5: production asks its own questions, about a rule applicability left `uncertain` and (#2059) a rule that applies whose finding is Needs BA input. A question linking a rule with a `baAnswer` gets that answer, and every other question goes unanswered. A pair whose rule was never asked keeps the finding it had before (each record's `answered.questions` lists what was asked).

| Arm | Runs | Pairs | Verdict accuracy after the answer | Given a verdict | Compliant against the label | Still asking | Settle failures | Requirements failed |
|---|---|---|---|---|---|---|---|---|
| A5 | 3 | 7 | 0.48 [0.14, 0.86] | 6/6/6 | 0 | 0/1/1 | 0 | 0 |

Per-run counts are joined with `/`. Compliant against the label: `compliant` after an answer whose labelled verdict is not, summed over runs (a short answer read the wrong way round). Settle failures: pairs whose open rule the settle could not re-judge (its call threw, or its reply could not be read twice), summed over runs; each is a miss, never still asking. Requirements failed: requirements with short-answer pairs on which the arm threw, before or during the replay, summed over runs; their pairs are misses.

A5, pair by pair (each scored run's verdict after the answer):

- KV-02 → TP-01 ("Yes, we do.", labelled compliant): missed, missed, missed
- KV-05 → MS-04 ("No.", labelled gap): gap, gap, gap
- KV-14 → CM-01 ("Yes, they are.", labelled compliant): compliant, gap, needs-ba-input
- KV-26 → TP-03 ("Yes, we do.", labelled compliant): gap, needs-ba-input, gap
- KV-28 → TP-05 ("No.", labelled gap): gap, gap, gap
- KV-31 → IR-04 ("Yes, we do.", labelled compliant): gap, gap, gap
- KV-33 → CM-04 ("No.", labelled gap): gap, gap, gap

## Paired comparison with A0

> At 30 items and a hit rate near 0.5 the standard error is about 9.1 points per arm, so a gap needs roughly 18 to 25 points to be significant. A smaller difference is reported as "no measurable difference", not as a win.

No other arm was run: this report is A0's baseline.

## Summary-screen prompt size

| Rules | Characters | Estimated tokens |
|---|---|---|
| 40 | 4573 | 1144 |
| 200 | 19190 | 4798 |
| 500 | 46650 | 11663 |

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

Non-resembling pairs missed in every run: KV-19 → CM-03.

Hard errors: none.
