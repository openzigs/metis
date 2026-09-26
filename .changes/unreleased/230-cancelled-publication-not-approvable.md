---
issue: 230
section: Fixed
---

- A generated document whose search indexing was cancelled, or whose last attempt
  failed, can no longer be approved into the search index from the review queue.
  Before, a cancel that landed after its chunks were parked left it approvable. It
  no longer appears in the review list, and it still reads as cancelled. Retrying
  the indexing task publishes it normally.
