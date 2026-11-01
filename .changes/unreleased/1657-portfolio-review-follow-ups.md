---
issue: 1657
section: Fixed
---

- A portfolio assessment no longer shows up for people in another workspace
  because its starter named one of their products, no longer reports the cost
  of repos the reader cannot see, and no longer assesses a deleted requirement.
  An assessment interrupted by a server restart is marked failed instead of
  staying "running" for ever, and a run now stops after a fixed number of model
  calls even when the model has no price. A requirement criterion the search
  never looked for is reported as "could not verify" rather than as a gap. The
  assessment list fills its page even when many recent assessments are hidden
  from you, and an "all products" assessment refuses a product list it would
  have ignored.
- Answering clarifying questions while the requirements were being extracted
  again now says the answers were not saved, instead of reporting success, and
  the count of open questions no longer includes requirements that were removed.
- Product relationship detection no longer reads UI text such as "Delete from
  cart?" as a database query, and finds the tables of a query nested inside
  `EXTRACT(... FROM ...)`.
- Requirements promoted from an analysis now link the same findings on every
  database, because findings are read back in the order they were written.
