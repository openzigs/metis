---
issue: 97
section: Fixed
---

- The gate working-directory test in the `scripts` package no longer times out on a busy machine.
  It now runs each gate over a small, temporary git index instead of every tracked file, so its
  cost no longer grows with the repository.
