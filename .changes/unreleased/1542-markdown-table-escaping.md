---
issue: 1542
section: Fixed
---

- A backslash before a `|` no longer splits a Markdown table cell in the Project Overview, the
  database schema document's Used Objects table, spreadsheet, PowerPoint and HTML table imports, the Copilot
  Workspace brief, or a spec-kit `tasks.md` row renamed from a GitHub issue title. PowerPoint
  table cells are also no longer escaped twice. Imported HTML that contains the literal text
  `&amp;lt;` now reads `&lt;`, not `<`.
