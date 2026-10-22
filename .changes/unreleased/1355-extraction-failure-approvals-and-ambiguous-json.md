---
issue: 1355
section: Fixed
---

- When the requirements step fails, the Approvals tab now says that no approval
  checkpoints were created and that the run's requirements were saved without
  review, instead of only "This run has no approval checkpoints".
- A model reply holding two different JSON objects, such as an example in its
  preamble followed by the answer, is no longer read as the first one. METIS
  asks the model again and tells it to send exactly one object.
