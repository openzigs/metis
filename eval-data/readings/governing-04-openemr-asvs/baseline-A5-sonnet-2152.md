# Governing-rules eval — `governing-04-openemr-asvs`

Set: **tuning** (prompts are iterated on this set, so its numbers are not held-out evidence).

Code: commit `dbd9a8aa4db56cfe3c1bf47451e46eb232e2ec3f`, clean tree.

Requirements: **33** · Rules: **30** (`policy-v1.md`, revision v1) · Runs requested: **2** · Budget: **$4** · Spent: **$1.6477**

Labels: **not yet reviewed by a person** (see ANNOTATION.md).

## Results (mean over runs; 95% bootstrap interval over requirements)

| Arm | Runs | Recall | Non-resembling recall | Precision | Citation accuracy | Citation coverage | Verdict accuracy | Hard errors | Ask rate | Clean negatives | Failures | $ / req | Tokens in / out per req | s / req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A5 | 2 | 0.67 [0.56, 0.79] | 0.75 [0.00, 1.00] | 0.70 [0.56, 0.85] | 1.00 [1.00, 1.00] | 1.00 [1.00, 1.00] | 0.59 [0.47, 0.70] | 0 | 0.77 [0.63, 0.87] | 5/4 of 7 | 0 | $0.0250 | 6074 / 1524 | 12.3 |

Hard errors: `compliant` on a pair whose truth is `gap` or `needs-ba-input`, summed over runs. Clean negatives: negative requirements on which the arm ran and applied no rule, per run (a failure is an error, never a clean negative).

## Proposed pass thresholds (proposed, #1867)

| Arm | Bar | Required | Measured | Pass |
|---|---|---|---|---|
| A5 | overallRecall | ≥ 0.90 | 0.67 | **no** |
| A5 | nonResemblingRecall | ≥ 0.85 | 0.75 | **no** |
| A5 | precision | ≥ 0.60 | 0.70 | yes |
| A5 | citationAccuracy | ≥ 0.95 | 1.00 | yes |
| A5 | maxNoEvidenceCompliantErrors | ≤ 0 per run | 0 (worst run) | yes |

## Short-answer pairs, with the BA's answer replayed (#2033)

This set has no short-answer pairs (`baAnswer`), so no answer was replayed.

## Where each error arose (#2108)

Each miss, extra rule and wrong verdict of the scored runs, by the stage of the shipped path it arose in: `not-a-candidate` (neither the top-k search nor the screen found the rule), `judged-does-not-apply` (the applicability judge ruled a candidate out), `applicability-applies` / `applicability-uncertain` (the judge brought an extra rule in, or left a rule uncertain, which is Needs BA input without a findings call), `rule-not-citable` (the rule applied but could not be cited, so no finding was asked for), and `findings-call` (the findings call gave the wrong status). Whether a label itself is doubtful is a reader's call, recorded in ANNOTATION.md.

### A5

| Kind | not-a-candidate | judged-does-not-apply | applicability-applies | applicability-uncertain | rule-not-citable | findings-call |
|---|---|---|---|---|---|---|
| missed | 0 | 31 | 0 | 0 | 0 | 0 |
| extra | 0 | 0 | 19 | 8 | 0 | 0 |
| wrong-verdict | 0 | 0 | 0 | 0 | 0 | 8 |

- OS-01 → SE-02: extra, applicability-applies (label none, said needs-ba-input): 2 of 2 run(s)
- OS-01 → SE-03: extra, applicability-applies (label none, said needs-ba-input): 1 of 2 run(s)
- OS-01 → SE-03: extra, applicability-uncertain (label none, said needs-ba-input): 1 of 2 run(s)
- OS-01 → SE-06: extra, applicability-uncertain (label none, said needs-ba-input): 1 of 2 run(s)
- OS-02 → PA-14: missed, judged-does-not-apply (label gap, said none): 2 of 2 run(s)
- OS-03 → SE-03: extra, applicability-applies (label none, said needs-ba-input): 2 of 2 run(s)
- OS-03 → SE-05: extra, applicability-applies (label none, said needs-ba-input): 1 of 2 run(s)
- OS-04 → LG-02: extra, applicability-applies (label none, said needs-ba-input): 1 of 2 run(s)
- OS-04 → PA-10: missed, judged-does-not-apply (label needs-ba-input, said none): 1 of 2 run(s)
- OS-04 → SE-01: extra, applicability-applies (label none, said needs-ba-input): 1 of 2 run(s)
- OS-06 → PA-14: missed, judged-does-not-apply (label gap, said none): 2 of 2 run(s)
- OS-08 → PA-04: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 2 run(s)
- OS-09 → PA-06: wrong-verdict, findings-call (label compliant, said needs-ba-input): 2 of 2 run(s)
- OS-10 → PA-04: extra, applicability-uncertain (label none, said needs-ba-input): 1 of 2 run(s)
- OS-11 → PA-08: wrong-verdict, findings-call (label needs-ba-input, said gap): 2 of 2 run(s)
- OS-11 → PA-09: extra, applicability-applies (label none, said needs-ba-input): 1 of 2 run(s)
- OS-13 → LG-04: extra, applicability-applies (label none, said needs-ba-input): 2 of 2 run(s)
- OS-13 → LG-05: extra, applicability-applies (label none, said needs-ba-input): 2 of 2 run(s)
- OS-15 → SE-03: wrong-verdict, findings-call (label compliant, said needs-ba-input): 2 of 2 run(s)
- OS-17 → AZ-03: extra, applicability-applies (label none, said needs-ba-input): 1 of 2 run(s)
- OS-17 → PA-10: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 2 run(s)
- OS-19 → LG-02: extra, applicability-applies (label none, said gap): 1 of 2 run(s)
- OS-19 → LG-02: extra, applicability-applies (label none, said needs-ba-input): 1 of 2 run(s)
- OS-19 → PA-11: extra, applicability-uncertain (label none, said needs-ba-input): 2 of 2 run(s)
- OS-19 → SE-04: extra, applicability-applies (label none, said needs-ba-input): 1 of 2 run(s)
- OS-19 → SE-04: extra, applicability-uncertain (label none, said needs-ba-input): 1 of 2 run(s)
- OS-20 → AZ-01: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 2 run(s)
- OS-26 → PA-04: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 2 run(s)
- OS-26 → PA-05: extra, applicability-uncertain (label none, said needs-ba-input): 2 of 2 run(s)
- OS-27 → PA-04: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 2 run(s)
- OS-28 → PA-03: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 2 run(s)
- OS-29 → AZ-01: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 2 run(s)
- OS-29 → DP-01: wrong-verdict, findings-call (label gap, said needs-ba-input): 2 of 2 run(s)
- OS-30 → PA-10: missed, judged-does-not-apply (label gap, said none): 2 of 2 run(s)
- OS-30 → PA-14: missed, judged-does-not-apply (label gap, said none): 2 of 2 run(s)
- OS-32 → PA-02: extra, applicability-applies (label none, said needs-ba-input): 2 of 2 run(s)
- OS-32 → PA-03: missed, judged-does-not-apply (label needs-ba-input, said none): 1 of 2 run(s)
- OS-32 → PA-04: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 2 run(s)
- OS-32 → PA-11: missed, judged-does-not-apply (label needs-ba-input, said none): 1 of 2 run(s)
- OS-32 → SE-04: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 2 run(s)
- OS-33 → PA-14: missed, judged-does-not-apply (label needs-ba-input, said none): 2 of 2 run(s)

## Paired comparison with A0

> At 26 items and a hit rate near 0.5 the standard error is about 9.8 points per arm, so a gap needs roughly 20 to 27 points to be significant. A smaller difference is reported as "no measurable difference", not as a win.

No other arm was run: this report is A0's baseline.

## Summary-screen prompt size

| Rules | Characters | Estimated tokens |
|---|---|---|
| 40 | 4724 | 1181 |
| 200 | 17741 | 4436 |
| 500 | 41991 | 10498 |

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

Non-resembling pairs missed in every run: OS-20 → AZ-01.

Hard errors: none.
