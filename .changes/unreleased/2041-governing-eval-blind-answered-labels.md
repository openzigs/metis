---
issue: 2041
section: Fixed
---

- `eval:governing`: a BA answer whose settle failed (a throw, or a reply unreadable twice)
  now counts as a **settle failure**, not as "still asking". "Replay failures" is renamed
  "Requirements failed". A run with no completed runs no longer claims the set has no
  short-answer pairs. The report notes that A4's cost includes the replay. `governing-02`'s
  seven `answeredVerdict` labels were re-derived blind: 7 of 7 agreed, and none changed.
  `governing-01`'s GR-11 question now covers every January purge.
