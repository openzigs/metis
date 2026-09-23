---
issue: 157
section: Changed
---

- Business Rules, Key Workflows, Calculations and Data Model are now written in
  batches that together read every relevant module, instead of one call over
  the modules that fit. Each batch is sized to finish within the output limit.
  A batch that is still cut off is split and regenerated. If a single module
  alone is too large for the limit, the document warns and names it. These
  sections take longer to generate on a large project, but they are no longer
  cut off partway through.
