# Governing-rules eval — `governing-03-openemr-hipaa`

Set: **held-out** (read for a decision, never tuned on; content hash `71c07441178945b2367af50c2848208b056b6a7a1b8f295011899dbba45c4135`). Record this reading in the set's ANNOTATION.md.

Code: commit `15b11e09e3926c9f2d0e2c6ff5ecf21d9261963a`, clean tree; combined from 3 invocations (`governing-governing-03-openemr-hipaa-2026-11-10T00-42-40-983Z.json`, `governing-governing-03-openemr-hipaa-2026-11-10T00-43-55-920Z.json`, `governing-governing-03-openemr-hipaa-2026-11-10T00-45-08-730Z.json`).

Requirements: **25** · Rules: **32** (`policy-v1.md`, revision v1) · Runs requested: **3** · Budget: **$9** · Spent: **$2.2034**

Labels: **not yet reviewed by a person** (see ANNOTATION.md).

## Results (mean over runs; 95% bootstrap interval over requirements)

| Arm | Runs | Recall | Non-resembling recall | Precision | Citation accuracy | Citation coverage | Verdict accuracy | Hard errors | Ask rate | Clean negatives | Failures | $ / req | Tokens in / out per req | s / req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A5 | 3 | 0.83 [0.70, 0.93] | 0.50 [0.00, 1.00] | 0.65 [0.51, 0.80] | 1.00 [1.00, 1.00] | 1.00 [1.00, 1.00] | 0.55 [0.36, 0.74] | 2 | 0.73 [0.60, 0.83] | 6/7/7 of 8 | 0 | $0.0294 | 6502 / 1871 | 14.6 |

Hard errors: `compliant` on a pair whose truth is `gap` or `needs-ba-input`, summed over runs. Clean negatives: negative requirements on which the arm ran and applied no rule, per run (a failure is an error, never a clean negative).

## Proposed pass thresholds (proposed, #1867)

| Arm | Bar | Required | Measured | Pass |
|---|---|---|---|---|
| A5 | overallRecall | ≥ 0.90 | 0.83 | **no** |
| A5 | nonResemblingRecall | ≥ 0.85 | 0.50 | **no** |
| A5 | precision | ≥ 0.60 | 0.65 | yes |
| A5 | citationAccuracy | ≥ 0.95 | 1.00 | yes |
| A5 | maxNoEvidenceCompliantErrors | ≤ 0 per run | 1 (worst run) | **no** |

## Short-answer pairs, with the BA's answer replayed (#2033)

This set has no short-answer pairs (`baAnswer`), so no answer was replayed.

## Where each error arose (#2108)

Each miss, extra rule and wrong verdict of the scored runs, by the stage of the shipped path it arose in: `not-a-candidate` (neither the top-k search nor the screen found the rule), `judged-does-not-apply` (the applicability judge ruled a candidate out), `applicability-applies` / `applicability-uncertain` (the judge brought an extra rule in, or left a rule uncertain, which is Needs BA input without a findings call), and `findings-call` (the findings call gave the wrong status). Whether a label itself is doubtful is a reader's call, recorded in ANNOTATION.md.

### A5

| Kind | not-a-candidate | judged-does-not-apply | applicability-applies | applicability-uncertain | findings-call |
|---|---|---|---|---|---|
| missed | 0 | 17 | 0 | 0 | 0 |
| extra | 0 | 0 | 39 | 5 | 0 |
| wrong-verdict | 0 | 0 | 0 | 0 | 28 |

- OE-01 → SM-02: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-01 → SM-02: extra, applicability-uncertain (label none, said needs-ba-input): 1 of 3 run(s)
- OE-01 → TS-01: extra, applicability-applies (label none, said needs-ba-input): 2 of 3 run(s)
- OE-01 → TS-07: missed, judged-does-not-apply (label needs-ba-input, said none): 3 of 3 run(s)
- OE-03 → TS-05: wrong-verdict, findings-call (label compliant, said needs-ba-input): 3 of 3 run(s)
- OE-04 → SM-01: missed, judged-does-not-apply (label needs-ba-input, said none): 1 of 3 run(s)
- OE-04 → SM-02: wrong-verdict, findings-call (label compliant, said needs-ba-input): 3 of 3 run(s)
- OE-04 → TS-04: wrong-verdict, findings-call (label compliant, said needs-ba-input): 2 of 3 run(s)
- OE-05 → TS-02: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-09 → SM-03: extra, applicability-applies (label none, said needs-ba-input): 3 of 3 run(s)
- OE-09 → TS-10: missed, judged-does-not-apply (label needs-ba-input, said none): 3 of 3 run(s)
- OE-11 → PW-03: extra, applicability-applies (label none, said needs-ba-input): 2 of 3 run(s)
- OE-12 → AS-02: wrong-verdict, findings-call (label compliant, said needs-ba-input): 3 of 3 run(s)
- OE-12 → PW-01: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-12 → PW-02: extra, applicability-applies (label none, said needs-ba-input): 3 of 3 run(s)
- OE-12 → PW-04: wrong-verdict, findings-call (label compliant, said needs-ba-input): 3 of 3 run(s)
- OE-13 → AU-01: extra, applicability-applies (label none, said needs-ba-input): 2 of 3 run(s)
- OE-13 → TS-09: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-14 → AS-02: missed, judged-does-not-apply (label needs-ba-input, said none): 3 of 3 run(s)
- OE-15 → AS-02: wrong-verdict, findings-call (label gap, said compliant): 2 of 3 run(s)
- OE-15 → AS-02: wrong-verdict, findings-call (label gap, said needs-ba-input): 1 of 3 run(s)
- OE-15 → PW-01: extra, applicability-applies (label none, said compliant): 1 of 3 run(s)
- OE-15 → PW-01: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-15 → PW-02: extra, applicability-applies (label none, said needs-ba-input): 3 of 3 run(s)
- OE-15 → PW-03: extra, applicability-applies (label none, said needs-ba-input): 3 of 3 run(s)
- OE-15 → PW-07: wrong-verdict, findings-call (label needs-ba-input, said gap): 3 of 3 run(s)
- OE-15 → PW-10: extra, applicability-applies (label none, said needs-ba-input): 2 of 3 run(s)
- OE-15 → TS-03: extra, applicability-applies (label none, said needs-ba-input): 2 of 3 run(s)
- OE-15 → TS-09: missed, judged-does-not-apply (label gap, said none): 1 of 3 run(s)
- OE-15 → TS-09: wrong-verdict, findings-call (label gap, said needs-ba-input): 2 of 3 run(s)
- OE-16 → AS-02: wrong-verdict, findings-call (label compliant, said needs-ba-input): 3 of 3 run(s)
- OE-16 → PW-07: wrong-verdict, findings-call (label needs-ba-input, said gap): 3 of 3 run(s)
- OE-19 → TS-01: missed, judged-does-not-apply (label needs-ba-input, said none): 3 of 3 run(s)
- OE-19 → TS-05: extra, applicability-applies (label none, said needs-ba-input): 2 of 3 run(s)
- OE-19 → TS-05: extra, applicability-uncertain (label none, said needs-ba-input): 1 of 3 run(s)
- OE-22 → AU-03: extra, applicability-uncertain (label none, said needs-ba-input): 3 of 3 run(s)
- OE-23 → SM-02: extra, applicability-applies (label none, said needs-ba-input): 2 of 3 run(s)
- OE-23 → TS-04: extra, applicability-applies (label none, said needs-ba-input): 1 of 3 run(s)
- OE-25 → AS-02: missed, judged-does-not-apply (label compliant, said none): 3 of 3 run(s)
- OE-25 → PW-02: extra, applicability-applies (label none, said needs-ba-input): 3 of 3 run(s)
- OE-25 → PW-07: extra, applicability-applies (label none, said needs-ba-input): 3 of 3 run(s)

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

Hard errors: OE-15 → AS-02 (run 1); OE-15 → AS-02 (run 2).
