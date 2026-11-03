---
issue: 1705
section: Fixed
---

- A run whose requirements waited for approval now gets its elicited
  non-functional requirements too: they are added as drafts, tagged
  `elicited-nfr`, when the approved set is saved, by the same rules as any other
  run (no duplicates, at most 20, verdict at most "could not verify"). The
  document cross-check also runs on such a run now.
