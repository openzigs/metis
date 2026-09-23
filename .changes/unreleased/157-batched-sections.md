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
  cut off partway through. If a batch fails or returns nothing, the document
  names the modules it is missing, and if part of a section could not be
  fact-checked, it says which part. Set `DOCS_GEN_BATCHED_SECTIONS=0` to go
  back to one call per section.
