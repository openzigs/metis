---
issue: 1609
section: Changed
---

- A multi-project impact analysis now records an outcome for every project it was run on, so a
  project with nothing affected reads "checked, nothing affected" instead of disappearing from the
  result. A project that was skipped says why: the person who started the run could not open it
  when the run reached it, or it has no indexed code. A project the run failed on is marked as an
  error. The analysis detail returns these as `projectOutcomes`; the page that shows them is
  #1615.
