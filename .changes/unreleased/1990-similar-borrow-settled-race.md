---
issue: 1990
section: Changed
---

- After "Start from these citations", a similar-requirements list that was still loading when
  the copy finished, and then loaded or failed, is no longer loaded again: it is reloaded only
  if it lists this requirement, and a list that failed is retried the usual way.
