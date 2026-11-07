---
issue: 1867
section: Added
---

- `pnpm --filter server eval:governing`: a held-out eval for governing documents. A synthetic
  40-rule company policy and 36 analyst-worded requirements, labelled with the rules that truly
  apply and a compliant / gap / needs-BA-input verdict, scored per arm on applicability recall
  (overall and on rules that do not resemble the requirement), precision, citation accuracy
  against the stored clause, verdict accuracy, hard errors, ask rate and cost. The A0 baseline
  (today's web specialist over chunk retrieval) is committed: recall 0.99 but precision 0.11,
  and a verified citation on only 0.59 of the rules it applies, on DeepSeek.
