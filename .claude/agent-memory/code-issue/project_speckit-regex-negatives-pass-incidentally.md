---
name: project_speckit-regex-negatives-pass-incidentally
description: Spec Kit text heuristics over model prose shipped negative tests that passed for an incidental reason; probe each regex with the adversarial near-miss
metadata:
  type: project
---

Reviewer's durable finding on PR #1083 (2026-10-11), verbatim: "in Spec Kit, text heuristics over model prose (contract-check.ts marker and path matching) ship with negative tests that pass for an incidental reason (a leading 'The', a '.go' suffix) rather than the property claimed; probe each regex with the adversarial near-miss directly instead of trusting the negative cases in the suite."

What it looked like in `server/src/lib/spec-kit/contract-check.ts`: `MARKER_RE` ended in `none\b`, and the suite's negative was `The REST surface: none of it changes`, rejected by the leading `The`. `REST surface: none of the existing endpoints change; adds POST /entries/export` matched, so `/speckit.plan` skipped the contract call and wrote `paths: {}`. `planMentionsPath`'s negative was `internal/api/entries.go`, rejected by `.go`; `ui/src/app/entries`, `specs/<slug>` and `and/or` all matched.

**Why:** a negative case proves a property only if that property is the single thing separating it from an accepted input. Otherwise the test stays green while the regex accepts the near-miss.

**How to apply:** for each regex or text heuristic, write the negative as an accepted input changed in ONE respect (same prefix, no extension, no extra word), and say in a comment which rule is meant to reject it. Then mutate that one rule and confirm exactly that test fails. Where two rules both reject an input (whole-line and "names an endpoint"), test each with an input the other one accepts.
