---
issue: 2224
section: Fixed
---

- A requirement a review approved and that was edited since now reads "Changed since approval ·
  awaiting re-review" on its card, linking the review, instead of "draft". The review page says in
  its header how many requirements changed since approval, and keeps linking the earlier baseline
  while a re-review runs.
- Editing a requirement that is both approved and in an open review now warns that the save also
  returns it to awaiting review.
- An import re-sync that rewrites an approved requirement returns it to awaiting review and tells
  the review's people, as an analyst's edit does. A version change that sent no notification no
  longer silences later ones: each person is told once per approved version.
- A baseline created on approval is named after the review ("Security sign-off", then "Security
  sign-off (round 2)"), not after its id, and a name another baseline already holds no longer fails
  the approval.
- The requirement picker on SQLite matches letters with more than two forms, such as ß/ẞ, Σ/σ/ς and
  İ/i, in any case.
- The traceability heading under a requirement card shows the new title after a save.
