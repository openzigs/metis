---
issue: 438
section: Fixed
---

- Clarifying a requirement that has no title or description no longer sends the
  word "undefined" to the model or saves it into the analysis. A missing title,
  description or ambiguity description now counts as empty, as it already did
  for requirements the extractor produced without a title.
