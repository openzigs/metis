---
issue: 2377
section: Fixed
---

- The Generate form's "needs connected source code" warning now checks the scope you chose: a
  By Repository document on an empty repository is flagged even while another repository is
  indexed, and a project whose only files are archive junk (`__MACOSX/`, `.DS_Store`) is flagged
  too. A failed document that never published no longer reads "Queued for indexing", and an
  automatic update that finds no code to document fails once instead of being retried three times.
