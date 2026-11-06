---
issue: 1837
section: Added
---

- A new API finds requirements similar to a stored requirement or to draft
  text in the same project, labels each one a likely duplicate, an overlap or
  related, and lists its saved code links and how current they are. The labels
  are suggestions for an analyst to confirm. `REQ_SIMILARITY_VERIFIER=1` adds a
  model check of the labels (off by default; on the labelled test set it removed
  every false duplicate).
