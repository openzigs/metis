---
issue: 1388
section: Fixed
---

- The code agent no longer stops investigating on a reply that is neither a search nor an answer:
  it is asked to continue while turns and budget remain, and an answer that leaves most
  requirements unchecked with most of the budget unused is sent back once.
- A code investigation that still ends with most requirements unchecked, or stops after a few
  look-ups far under budget, reads `degraded` on its card with a plain note, and the run lists
  the limitation, instead of showing a clean `completed`.
