---
issue: 1486
section: Fixed
---

- A PR review's model spend now counts toward the monthly limit as soon as the
  model answers, including when its response cannot be read or GitHub refuses
  the review, so a review that keeps failing can no longer spend unmetered.
- A failure while recording a finished review no longer makes the review run,
  and post, a second time.
- Only a refused GitHub redirect fails a publish or a PR review at once; any
  other GitHub error is retried as before.
