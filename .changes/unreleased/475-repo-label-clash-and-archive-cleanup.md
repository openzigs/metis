---
issue: 475
section: Fixed
---

- Adding a repository under a label that a deleted repository in the same project used now answers
  with the usual "label already exists" conflict instead of a server error.
- Deleting an uploaded (.zip) repository now also removes its stored archive from the server.
