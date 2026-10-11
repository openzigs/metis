---
issue: 1034
section: Fixed
---

- "Tested by" now finds Go tests that reach the mapped code through a method call on a receiver or
  struct field (`client.CreateBookmark(…)`, `h.store.SetEntriesStatus(…)`). These links are matched
  by method name, so they are shown under their own label, **Inferred call**, rank below every
  other link, and do not count as strict test coverage.
- An inferred call is listed only when the method name is distinctive or the test is named for it,
  so a stray `Close()` or `t.Run()` in a test no longer marks unrelated code as tested. A
  requirement mapped to a whole file with no line range is unchanged.
