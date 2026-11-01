---
issue: 1668
section: Fixed
---

- Portfolio impact now follows a change through a product's own repos and between two
  writers of one table. A product reachable only past one you cannot read now reads
  "Not reached", not "Not affected". The severity no longer rises from a consumer's own
  contract, and an impact path withheld from you no longer shows in a product's summary.
- A stalled assessment that was marked failed stays failed. Clarifying answers refused
  because the requirements were re-extracted can be given again.
