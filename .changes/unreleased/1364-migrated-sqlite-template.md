---
issue: 1364
section: Fixed
---

- The server's SQLite test suites no longer fail at random under a busy test run.
  The migrations now run once per run, before any suite starts, and each suite
  copies the result instead of starting its own migration process (about 240 per
  run before). The suites that build an older schema to test one migration still
  run Prisma. Every test database is checked for all its migrations before a suite
  uses it, and a failed migration run now reports its exit status, the signal and
  Prisma's output.
