---
issue: 1732
section: Fixed
---

- A portfolio report no longer treats a product name inside a longer one as a mention: text about
  "Orders v3" no longer names a product called "Orders" too, so a reader who can see "Orders v3"
  but not "Orders" keeps the entries about it. The longest product name claims its words first.
- The documents that **Generate Documentation** writes now include edges to other products'
  repositories. The Service Map, API Contracts table and Data Flow diagram name each far
  repository as *owner/name (Product)*, or *A restricted repository* when the person generating
  them could not access it. They no longer read "No API contract edges detected." for a product
  whose edges all reach other products.
- The **Provenance** table credits each evidence file to the repository it is in, instead of
  crediting every file to the edge's source repository (#1727).
