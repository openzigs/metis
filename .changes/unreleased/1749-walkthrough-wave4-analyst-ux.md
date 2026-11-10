---
issue: 1749
section: Fixed
---

- Analysis and portfolio fixes from the fourth walkthrough. Starting an analysis with no document
  selected now says it uses all of the project's documents instead of "0 documents". Leaving the
  code agent out of a run on a project whose code is indexed warns that the run will give no
  implemented, partial or gap verdicts and no code citations. A repository's summary copy of a
  manifest such as `package.json` is labelled "repository summary" in document lists, so it no
  longer reads as a duplicate of the source file. Approve reads "Approved" and is disabled once a
  requirement is approved (Reject likewise), so a second click no longer sends a second update.
  "Start Spec Kit feature" is disabled while Spec Kit is off for the project and links to the
  Spec Kit page. Portfolio: recent checks say which product was chosen to build each one, the
  "choose the product that will build it" link puts focus on the host picker, a downstream
  product two or more hops away gives the hop count, and a check with no host no longer has the
  summary say that no product is affected. The exported Products table no longer repeats the
  coverage in its Summary column, the edges table's Strength select is no longer clipped, and
  product diagrams label a shared-table edge "writes a shared table" or "reads a shared table"
  instead of "produces".
