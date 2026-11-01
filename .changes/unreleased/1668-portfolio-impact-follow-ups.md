---
issue: 1668
section: Fixed
---

- Portfolio impact now follows a change through a product's own repos (an API repo to its
  UI repo, then on to the next product), and between two products that both write one
  table, whichever way it was recorded. A product reached only past one you cannot read
  reads "Not reached" instead of "Not affected", and the summary says the impact was not
  followed past the restricted product.
- A contract change raises a hop's severity only when it is the provider's own contract,
  and the export says the change was the contract's latest version, not this requirement.
- A reader who cannot see an impact path no longer sees its integration kind and
  severity in the product's summary or the Markdown export.
- A portfolio assessment failed after it stalled stays failed instead of completing
  later, and subscribers hear that it failed. A product's list of assessments counts
  only the products each was scoped to.
- Clarifying answers refused because the requirements were re-extracted can now be
  given again: the round stays open.
