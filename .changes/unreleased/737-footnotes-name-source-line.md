---
issue: 737
section: Fixed
---

- Generated documents: when a statement clearly restates a rule, limit or default METIS read directly from a module's source code, its footnote names that `file:line` instead of only the module path. A weaker match, or a tie between two rules, keeps the module footnote. The provenance manifest records the lines each source's footnotes named (`citedLines`).
