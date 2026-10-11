---
issue: 1058
section: Fixed
---

- An analysis with clarifying questions on no longer reports "No open questions — requirements look
  complete" when the model's requirements answer could not be read. The unreadable answer is asked
  for again once; if that fails too, the run records the failure and the Questions tab says the
  step failed and to run the analysis again, instead of storing an empty list.
