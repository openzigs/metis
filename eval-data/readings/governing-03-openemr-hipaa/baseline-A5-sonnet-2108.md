# Governing-rules eval — `governing-03-openemr-hipaa`

Set: **held-out** (read for a decision, never tuned on; content hash `71c07441178945b2367af50c2848208b056b6a7a1b8f295011899dbba45c4135`). Record this reading in the set's ANNOTATION.md.

Code: commit `b7f9f8657351a52bbdfb3b59da4d15e41b8f8d8c`, clean tree; combined from 3 invocations (`governing-governing-03-openemr-hipaa-2026-11-09T20-46-36-836Z.json`, `governing-governing-03-openemr-hipaa-2026-11-09T20-47-29-147Z.json`, `governing-governing-03-openemr-hipaa-2026-11-09T20-48-22-270Z.json`).

Requirements: **25** · Rules: **32** (`policy-v1.md`, revision v1) · Runs requested: **3** · Budget: **$18** · Spent: **$2.0293**

Labels: **not yet reviewed by a person** (see ANNOTATION.md).

## Results (mean over runs; 95% bootstrap interval over requirements)

| Arm | Runs | Recall | Non-resembling recall | Precision | Citation accuracy | Citation coverage | Verdict accuracy | Hard errors | Ask rate | Clean negatives | Failures | $ / req | Tokens in / out per req | s / req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A5 | 3 | 0.75 [0.61, 0.88] | 0.50 [0.00, 1.00] | 0.76 [0.60, 0.90] | 1.00 [1.00, 1.00] | 1.00 [1.00, 1.00] | 0.49 [0.37, 0.65] | 0 | 0.67 [0.52, 0.81] | 6/7/7 of 8 | 0 | $0.0271 | 6174 / 1687 | 13.1 |

Hard errors: `compliant` on a pair whose truth is `gap` or `needs-ba-input`, summed over runs. Clean negatives: negative requirements on which the arm ran and applied no rule, per run (a failure is an error, never a clean negative).

## Proposed pass thresholds (proposed, #1867)

| Arm | Bar | Required | Measured | Pass |
|---|---|---|---|---|
| A5 | overallRecall | ≥ 0.90 | 0.75 | **no** |
| A5 | nonResemblingRecall | ≥ 0.85 | 0.50 | **no** |
| A5 | precision | ≥ 0.60 | 0.76 | yes |
| A5 | citationAccuracy | ≥ 0.95 | 1.00 | yes |
| A5 | maxNoEvidenceCompliantErrors | ≤ 0 per run | 0 (worst run) | yes |

## Short-answer pairs, with the BA's answer replayed (#2033)

This set has no short-answer pairs (`baAnswer`), so no answer was replayed.

## Where each error arose (#2108)

Each miss, extra rule and wrong verdict of the scored runs, by the stage of the shipped path it arose in: `not-a-candidate` (neither the top-k search nor the screen found the rule), `judged-does-not-apply` (the applicability judge ruled a candidate out), `applicability-applies` / `applicability-uncertain` (the judge brought an extra rule in, or left a rule uncertain, which is Needs BA input without a findings call), and `findings-call` (the findings call gave the wrong status). Whether a label itself is doubtful is a reader's call, recorded in ANNOTATION.md.

### A5

| Kind | not-a-candidate | judged-does-not-apply | applicability-applies | applicability-uncertain | findings-call |
|---|---|---|---|---|---|
| missed | 0 | 25 | 0 | 0 | 0 |
| extra | 0 | 0 | 16 | 7 | 0 |
| wrong-verdict | 0 | 0 | 0 | 0 | 25 |

- OE-01 → SM-02: extra, applicability-uncertain (label none, said needs-ba-input): 1 of 3 run(s)
- OE-01 → TS-01: extra, applicability-applies (label none, said needs-ba-input): 2 of 3 run(s)
- OE-01 → TS-01: extra, applicability-uncertain (label none, said needs-ba-input): 1 of 3 run(s)
- OE-01 → TS-07: missed, judged-does-not-apply (label needs-ba-input, said none): 3 of 3 run(s)
- OE-03 → TS-05: wrong-verdict, findings-call (label compliant, said needs-ba-input): 3 of 3 run(s)
- OE-04 → SM-01: missed, judged-does-not-apply (label needs-ba-input, said none): 1 of 3 run(s)
- OE-04 → SM-02: wrong-verdict, findings-call (label compliant, said needs-ba-input): 3 of 3 run(s)
- OE-04 → TS-04: wrong-verdict, findings-call (label compliant, said needs-ba-input): 2 of 3 run(s)
- OE-05 → TS-02: extra, applicability-uncertain (label none, said needs-ba-input): 3 of 3 run(s)
- OE-09 → SM-03: extra, applicability-applies (label none, said needs-ba-input): 2 of 3 run(s)
- OE-09 → TS-10: missed, judged-does-not-apply (label needs-ba-input, said none): 3 of 3 run(s)
- OE-11 → PW-02: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 3 run(s)
- OE-11 → PW-07: missed, judged-does-not-apply (label needs-ba-input, said none): 3 of 3 run(s)
- OE-12 → AS-02: wrong-verdict, findings-call (label compliant, said needs-ba-input): 3 of 3 run(s)
- OE-12 → PW-04: wrong-verdict, findings-call (label compliant, said needs-ba-input): 3 of 3 run(s)
- OE-12 → PW-07: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 3 run(s)
- OE-13 → AU-01: extra, applicability-applies (label none, said needs-ba-input): 3 of 3 run(s)
- OE-14 → AS-02: missed, judged-does-not-apply (label needs-ba-input, said none): 3 of 3 run(s)
- OE-14 → AU-01: missed, judged-does-not-apply (label needs-ba-input, said none): 3 of 3 run(s)
- OE-14 → TS-01: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-14 → TS-02: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-15 → AS-02: wrong-verdict, findings-call (label gap, said needs-ba-input): 3 of 3 run(s)
- OE-15 → PW-07: wrong-verdict, findings-call (label needs-ba-input, said gap): 3 of 3 run(s)
- OE-16 → AS-02: wrong-verdict, findings-call (label compliant, said needs-ba-input): 2 of 3 run(s)
- OE-16 → PW-07: missed, judged-does-not-apply (label needs-ba-input, said none): 3 of 3 run(s)
- OE-19 → TS-01: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 3 run(s)
- OE-19 → TS-05: extra, applicability-applies (label none, said needs-ba-input): 3 of 3 run(s)
- OE-19 → TS-06: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-19 → TS-07: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-22 → AU-03: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-22 → AU-03: extra, applicability-uncertain (label none, said needs-ba-input): 2 of 3 run(s)
- OE-23 → SM-02: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-25 → AS-02: wrong-verdict, findings-call (label compliant, said needs-ba-input): 3 of 3 run(s)

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
