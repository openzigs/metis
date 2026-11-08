---
issue: 1990
section: Changed
---

- After "Start from these citations", a similar-requirements list that finished loading while the
  code links were refreshing is reloaded only if it lists this requirement. If it failed to load,
  the copy does not reload it; it is retried the usual way.
