---
issue: 1135
section: Fixed
---

- When a spec names a page or a UI action, `/speckit.plan` now gives the model the HTTP
  handlers that serve that page, and the handlers built the same way.
- The plan result flags a plan that calls a file "not visible" when it was in the plan's
  context, or a function whose source it was shown, and a plan that renames a parameter the
  spec states (`read_at_after` → `read_after`) without saying why.
- Impact analysis of a bug report that changes no stored data no longer lists table writers as
  files to edit, and ranks HTTP handlers higher. A failed-write report keeps the writers.
