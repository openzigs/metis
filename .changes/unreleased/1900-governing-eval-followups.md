---
issue: 1900
section: Fixed
---

- `eval:governing`: A0's citation accuracy of 0.61 was an artefact of its reader, which handed
  a finding's first snippet to every rule the finding named. A0 now cites a rule only with a
  snippet that verifies against it; re-read from the same replies, the baseline has a verified
  citation on 0.59 of the rules A0 applies. A bar an arm cannot fail (A0's hard errors, ask rate
  and citation accuracy) prints `n/a`, not a pass; a requirement an arm failed on is an error,
  not a clean negative; the leak check covers requirements, rule summaries and the policy
  title; short subject words (log, tax, PII, VAT) count as shared vocabulary; and the dollar
  cap reserves a per-call estimate from the first concurrent wave.
