---
issue: 394
section: Fixed
---

- Code search no longer risks serving a stale symbol set after a re-index that deletes and
  recreates the same number of symbols with the same newest timestamp. The symbol cache now also
  checks when the code graph was last indexed. Concurrent first searches on a project share a
  single symbol load, and a new database index speeds up the check the cache runs on every search.
