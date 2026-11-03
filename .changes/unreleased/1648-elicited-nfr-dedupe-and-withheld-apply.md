---
issue: 1648
section: Fixed
---

- Elicited non-functional requirements are no longer dropped as false
  duplicates (`200ms` vs `1200ms`, `1.5s` vs `15s`, or the same target for a
  different subject), and every one not added is logged. Applying a withheld
  re-synthesis now keeps their drafts. Their verdict is at most "could not
  verify", and one run adds at most 20.
