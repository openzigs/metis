---
issue: 1142
section: Fixed
---

- Cancelling an analysis now stops its model spend. Once Cancel answers `cancelled: true`, no
  further model call is made for the run (one already in flight may finish), whatever phase it is
  in, and the run ends `cancelled` instead of running synthesis to `completed`. Cancel answers
  `cancelled: false` when the run has already finished or is recording its result.
