---
issue: 1962
section: Fixed
---

- Governing documents: `GOVERNING_DOCS_ENABLED=true` now turns the feature on.
  The setting accepts `1`, `true`, `yes` or `on` (any case), like METIS's other
  on/off settings; before, only `1` worked and `true` left every governing
  route answering "not found" with nothing in the log to say why.
