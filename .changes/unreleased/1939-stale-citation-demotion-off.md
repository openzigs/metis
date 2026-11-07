---
issue: 1939
section: Changed
---

- Impact analysis no longer sets aside a saved code link from "Evaluate new requirements" just
  because the code it points at changed since the analysis. Such a link is used again, the
  surer first (unless its file was deleted), and the run's summary says how many of them point at code that changed. On the
  held-out test set, setting them aside found the right file in the top five less often after a
  code change (and made no difference otherwise). An administrator can turn the old behaviour
  back on with `IMPACT_DEMOTE_STALE_CITATIONS=1`.
