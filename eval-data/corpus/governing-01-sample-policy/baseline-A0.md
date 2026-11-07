# Governing-rules eval — `governing-01-sample-policy`

Requirements: **36** · Rules: **40** (`policy-v1.md`, revision v1) · Runs requested: **3** · Budget: **$2** · Spent: **$0.3566**

Labels: **not yet reviewed by a person** (see ANNOTATION.md).

## Results (mean over runs; 95% bootstrap interval over requirements)

| Arm | Runs | Recall | Non-resembling recall | Precision | Citation accuracy | Citation coverage | Verdict accuracy | Hard errors | Ask rate | Clean negatives | Failures | $ / req | Tokens in / out per req | s / req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A0 | 3 | 0.99 [0.97, 1.00] | 1.00 [1.00, 1.00] | 0.11 [0.09, 0.15] | n/a† | 0.59 [0.51, 0.66] | 0.30 [0.16, 0.47] | n/a† | n/a† | 0/0/0 of 6 | 1 | $0.0033 | 2386 / 2689 | 20.1 |

Hard errors: `compliant` on a pair whose truth is `gap` or `needs-ba-input`, summed over runs. Clean negatives: negative requirements on which the arm ran and applied no rule, per run (a failure is an error, never a clean negative).

† Fixed by construction, so it measures nothing and its bar is `n/a`: A0 hardErrors: A0 judges every rule gap, so it never says compliant; A0 askRate: A0 judges every rule gap, so it never asks for business input; A0 citationAccuracy: A0's reader attaches a snippet only when it verifies against the rule.

## Proposed pass thresholds (proposed, #1867)

| Arm | Bar | Required | Measured | Pass |
|---|---|---|---|---|
| A0 | overallRecall | ≥ 0.90 | 0.99 | yes |
| A0 | nonResemblingRecall | ≥ 0.85 | 1.00 | yes |
| A0 | precision | ≥ 0.60 | 0.11 | **no** |
| A0 | citationAccuracy | ≥ 0.95 | 1.00 | n/a† |
| A0 | maxNoEvidenceCompliantErrors | ≤ 0 per run | 0 (worst run) | n/a† |

## Paired comparison with A0

> At 30 items and a hit rate near 0.5 the standard error is about 9.1 points per arm, so a gap needs roughly 18 to 25 points to be significant. A smaller difference is reported as "no measurable difference", not as a win.

No other arm was run: this report is A0's baseline.

## Summary-screen prompt size

| Rules | Characters | Estimated tokens |
|---|---|---|
| 40 | 4191 | 1048 |
| 200 | 17476 | 4369 |
| 500 | 42373 | 10594 |

Estimated at the repository's 4-characters-per-token heuristic; no model was called.

## Arms

### A0 — today's web specialist over chunk retrieval of the policy

| Setting | Value |
|---|---|
| chunker | chunkMarkdown (rag/chunker.ts), default options |
| retrieval | buildRetrievalQueries(web) + runGroundedRetrieval (RRF), requirement as the operator note |
| searcher | production BM25 options (createInMemoryBM25), no vectors |
| k | 10 |
| rerank | false |
| filter | selectWebAgentEvidence |
| agent | runAgent web (analysis/agent-runner.ts) |
| reading | readWebFindings: named or quoted rules, every one judged gap, cited only by a snippet that verifies |
| model | anthropic/deepseek-flash |

Non-resembling pairs missed in every run: none.

Hard errors: none.
