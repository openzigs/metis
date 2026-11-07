---
issue: 1931
section: Fixed
---

- After "Start from these citations", a similar-requirements list that was still loading is
  loaded again, so it shows the copied code links instead of the ones from before the copy.
- A similar requirement with more than 20 code links no longer shows an exact count: it reads
  "More than 20 code links", and a duplicate warning says "it already links to at least N files".
