---
issue: 774
section: Fixed
---

- The `search_code_graph` `calls` and `calledBy` filters no longer answer for
  an arbitrary symbol when a name is ambiguous. An exact, case-sensitive match
  wins. A name that still matches several symbols returns the candidates, so
  the model can ask again with a qualified name.
- `calls` now also lists probable call sites that the parser could not resolve
  to a symbol (for example Go calls through a receiver or a field, such as
  `h.store.UpdateFeed(...)`), with their `file:line`. Before, a function whose
  production callers were all unresolved looked as if only its tests called
  it, or as if nothing did.
