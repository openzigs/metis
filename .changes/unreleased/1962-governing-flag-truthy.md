---
issue: 1962
section: Fixed
---

- Governing documents: `GOVERNING_DOCS_ENABLED=true` now turns the feature on.
  The setting accepts `1`, `true`, `yes` or `on` (any case), like METIS's other
  on/off settings; before, only `1` worked and `true` left every governing
  route answering "not found" with nothing in the log to say why.
- **Upgrade note:** a deployment whose environment already sets
  `GOVERNING_DOCS_ENABLED` to `true`, `yes` or `on` has been running with
  governing documents off; after this upgrade the pre-release feature is on.
  Unset the variable (or set it to `0`) to keep it off until it is released.
