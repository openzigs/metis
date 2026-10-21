---
issue: 1121
section: Fixed
---

- The Runs list no longer fails for someone who can reach more than about 995
  projects on a SQLite deployment. Their projects are read a few hundred at a
  time and merged into the same newest-first page.
