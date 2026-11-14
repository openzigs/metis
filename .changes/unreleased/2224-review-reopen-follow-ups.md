---
issue: 2224
section: Fixed
---

- A requirement edited after a review approved it reads "Changed since approval · awaiting
  re-review" with a link to the review, not "draft"; the review header counts such requirements
  and keeps linking the earlier baseline during a re-review. Baselines are named after the review,
  not its id, and a taken name no longer fails the approval. An import re-sync that rewrites an
  approved requirement reopens it, and a silent version change no longer stops later notifications.
  The SQLite requirement picker matches ß/ẞ, Σ/σ/ς and İ/i in any case.
