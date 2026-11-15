---
issue: 2185
section: Fixed
---

- The analysis start form's summary no longer counts repository and database connector rows as
  documents. A run with no document ticked does not read them as documents, so a project with only
  a connected repository now reads "no documents" instead of "all 40 documents".
- A product's per-service document now labels a shared-table link "writes a shared table" or
  "reads a shared table", as the Service Map and Data Flow diagrams do, instead of `produces` or
  `consumes`.
- A portfolio check's chosen host product now reads "To be built by X" rather than "Built by X",
  which read as already built.
- In a portfolio check's Products table, a summary whose first word only starts like its coverage
  ("Covers items …") is no longer cut ("Ems …").
