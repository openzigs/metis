---
issue: 2534
section: Fixed
---

- With `ANALYSIS_DOCUMENT_READER` on, the first round of clarifying questions
  no longer fails with "METIS could not read the clarifying questions" on a
  long requirements document. The round wrote one question for each of the
  hundreds of open ambiguities in one reply, and the reply stopped at the
  model's output limit. A round now writes questions for at most 24 open
  ambiguities, chosen first from the ticked items, then by priority and
  document order, and still asks at most 8. Later rounds choose again from the
  ambiguities still open.
