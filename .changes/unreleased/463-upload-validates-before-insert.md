---
issue: 463
section: Fixed
---

- A repository upload with a bad archive can no longer leave its project with
  no primary repository: the archive is checked before the connector is
  created, and the connector is written once, with its stored archive, so a
  failed upload leaves no connector, archive or extraction behind.
