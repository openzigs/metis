---
issue: 19
section: Fixed
---

- An analysis whose code agent made far fewer searches than it had
  requirements, or left most of them "could not verify", is now reported as
  degraded (and starved, for the first case), so the analysis page shows the
  code-retrieval warning. Such runs used to be recorded as healthy. Verdicts
  are unchanged.
