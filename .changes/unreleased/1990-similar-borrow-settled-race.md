---
issue: 1990
section: Changed
---

- After "Start from these citations", a similar-requirements list that was still loading when
  the copy finished is reloaded only if it lists this requirement. The bound is timing: a list
  that loaded or failed while the code links were refreshing is reloaded only if it loaded and
  lists this requirement, and a failed list is retried the usual way.
