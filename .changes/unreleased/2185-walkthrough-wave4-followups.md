---
issue: 2185
section: Fixed
---

- The analysis start form's summary no longer counts repository and database connector rows as
  documents, so a project whose rows all come from a connected repository reads "no documents".
- A product's per-service document labels a shared-table link "writes a shared table" or "reads a
  shared table", as the Service Map and Data Flow diagrams do.
- A portfolio check's chosen host reads "To be built by X" rather than "Built by X".
- A portfolio check's Products table no longer cuts a summary whose first word only starts like
  its coverage ("Covers items …" read "Ems …").
