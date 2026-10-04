---
issue: 791
section: Fixed
---

- Impact analysis names the functions that write the data a change touches (new
  "Writes affected data" relation), found through SQL lineage, plus their callers:
  the status-change paths for `read_at`, `MarkAllAsReadBeforeDate` and its Google
  Reader caller, `UpdateFeed`/`UpdateFeedError` for a refresh timestamp.
- Go handler calls into storage (`h.store.X()`) now count in the blast radius.
- Go and other application functions are no longer listed as database routines.
- A column matched only by name is dropped once its table is judged tangential.
