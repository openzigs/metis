---
issue: 960
section: Security
---

- Every Spec Kit route now checks that the caller can reach the project, not only their role: a
  caller outside the project's workspace gets 404 on every command (including legacy aliases and
  job starts), file, feature artifact, job, archive and restore route, and nothing is written.
