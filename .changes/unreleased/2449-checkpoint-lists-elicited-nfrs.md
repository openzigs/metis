---
issue: 2449
section: Fixed
---

- Approving a change request's checkpoint now saves exactly the requirements the checkpoint listed.
  Before, the non-functional requirements the analysis elicited were saved alongside the approved
  ones without ever appearing at the checkpoint, so approving 6 could save 15. They are now listed
  at the checkpoint, marked **Found by the analysis · Non-functional** with their category, and
  each needs its own approval. One you reject is not saved. An elicited requirement whose title
  restates a listed one in another word form (*expiry* for *expires*) is no longer offered at all.
