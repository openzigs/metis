---
issue: 2022
section: Fixed
---

- A Compliant governing finding no longer stands on a quote that is METIS's own
  question plus the first word of the business analyst's answer: the quote must
  hold the whole answer, or enough of it to say what is done. Cancelling an
  analysis while it is checking company policy no longer stores a partial
  result that silently leaves requirements out, and a cancelled findings
  refresh stops at once instead of waiting its turn. A very long requirement is
  checked against company policy in a bounded number of model calls. A retry
  of an unsettled answer that succeeds, or that the browser abandoned, no
  longer delays the next retry. Still behind the `GOVERNING_DOCS_ENABLED`
  setting, which is off by default.
