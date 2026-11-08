---
issue: 1877
section: Added
---

- A Business Requirements document generated from requirements (an analysis
  run, a selection or a review) now has a **Governing rules** section when the
  analysis found governing rules that apply. It lists each finding with its
  status, the rule's control id, the policy revision and the clause excerpt
  METIS checked, and your accept or reject decision with its note. Rejected
  findings are listed and marked Rejected. The findings come from what the
  analysis stored, so the document and the analysis view show the same
  statuses. The section never says a requirement is "compliant" with a
  framework; every summary ends "Not an audit opinion." Still behind
  `GOVERNING_DOCS_ENABLED`, off by default; with it off, or with no governing
  document, the document is unchanged.
