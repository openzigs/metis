---
issue: 384
section: Fixed
---

- An analysis no longer queries the database to confirm a cited document on
  every answer. Document ids already confirmed during the run, or present in
  the project's document list once that has been loaded, are answered from
  memory. The id check also caps how many ids it sends in one query.
