---
issue: 1369
section: Security
---

- A table, column, symbol or file name from a repository or database can no longer
  forge a line in the impact-analysis prompts or close their item list: every quoted
  value is now a JSON string, and an unusual name in a list is quoted.
- A support-panel excerpt can no longer forge a `--- path:line ---` header, and a
  lens or absence-check citation now counts only when it names a line it was shown.
