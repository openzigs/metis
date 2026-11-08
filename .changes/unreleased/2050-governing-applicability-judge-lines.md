---
issue: 2050
section: Changed
---

- Governing applicability now catches three kinds of rule it used to rule out.
  The first is encryption in transit when a requirement sends personal information
  to an outside company over a new connection. The second is a supplier's review
  and register entry when the requirement brings in a new supplier. The third is
  the testing and undo rules when a requirement changes how, when or by whom
  changes reach production. Cosmetic changes, such as a new button colour, no
  longer draw the change-management rules just because they will go live. Still
  behind the `GOVERNING_DOCS_ENABLED` setting, which is off by default.
