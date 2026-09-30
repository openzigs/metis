---
issue: 457
section: Fixed
---

- A project can no longer end up with two primary repositories when its first
  two repositories are added at the same moment; the database now allows one
  live primary per project, and the upgrade demotes any extras (the oldest
  keeps the flag). An uploaded repository is marked primary as it is created,
  so the create can no longer fail after the connector already exists.
