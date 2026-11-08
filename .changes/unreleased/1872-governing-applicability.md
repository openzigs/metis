---
issue: 1872
section: Added
---

- An analysis now works out, for each requirement, which of the workspace's
  governing rules apply. It takes the rules closest to the requirement from
  the governing index, and also has the model read the one-line summary of
  every current rule, so a rule that applies without sounding like the
  requirement (audit logging, retention) is not missed. Each rule found is
  judged "applies", "does not apply" or "uncertain"; an uncertain one always
  carries the business question that would settle it. Nothing is shown to the
  analyst yet: the questions and findings that use this come next. Still
  behind the `GOVERNING_DOCS_ENABLED` setting, which is off by default; with
  it off, an analysis is exactly as before.
