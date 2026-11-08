---
issue: 2008
section: Fixed
---

- An analysis that fails part-way no longer keeps checking governing rules in
  the background, so it stops making (and paying for) model calls once it has
  been marked failed. Checking a large set of governing rules now reuses its
  cached prompt between requirements of different lengths. Still behind the
  `GOVERNING_DOCS_ENABLED` setting, which is off by default.
