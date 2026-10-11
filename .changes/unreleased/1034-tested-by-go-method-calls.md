---
issue: 1034
section: Fixed
---

- "Tested by" now finds Go tests that reach the mapped code through a method call on a receiver or
  struct field (`client.CreateBookmark(…)`, `h.store.SetEntriesStatus(…)`), so such requirements
  are no longer listed as untested. A requirement mapped to a whole file with no line range is
  unchanged.
