---
issue: 1073
section: Changed
---

- Walkthrough scoring: an impact analysis is now scored as two rows, its edit candidates on
  precision and recall and its blast radius on recall only. `run.json` `changePlanAccuracy` rows
  take an optional `scope` (`edit` or `blast`); earlier runs' rows still validate and the report
  deck labels them as the old combined scoring. A blast row may record `listed`, the size of the
  list, which the deck prints as a plain count and never as a score.
