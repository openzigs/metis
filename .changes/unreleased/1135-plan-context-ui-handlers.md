---
issue: 1135
section: Fixed
---

- When a spec names a page or a UI action, `/speckit.plan` now gives the model the HTTP
  handlers that serve that page, and the handlers built the same way. Before, a bug seen on a
  page was planned against the page's JavaScript and the storage layer only.
- The plan result now flags a plan that calls a function or file "not visible" when that file
  was in the plan's context. It also flags a plan that renames a parameter the spec states
  (for example `read_at_after` → `read_after`) without saying why. The plan prompt asks for the
  spec's names to be kept, and for any rename to be recorded with its reason.
- Impact analysis of a bug report that changes no stored data no longer lists the functions
  that write a table as files to edit; they stay in the wider list for review. The HTTP
  handlers it finds are ranked higher.
