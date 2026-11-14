---
issue: 2503
section: Fixed
---

- The server's test typecheck no longer runs out of memory in CI. It now checks
  `tsconfig.test.json` as several smaller programs, one after another, that together
  cover the same files; each peaks near 6.4 GB instead of one program passing 14 GB.
