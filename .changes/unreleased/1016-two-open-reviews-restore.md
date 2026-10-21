---
issue: 1016
section: Fixed
---

- Withdrawing one of two open reviews of the same requirement no longer puts
  back a status the other review still depends on: the requirement waits for
  the other review, and the last one withdrawn restores the status from before
  either, in any order. Concurrent withdraws are serialised on Postgres.
- A requirement approved before the review status was tracked (a legacy
  `review:approved` label) stays approved when a review is requested, as the
  Requirements counts and the Request review form already said.
