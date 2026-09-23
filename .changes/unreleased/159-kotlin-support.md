---
issue: 159
section: Added
---

- Kotlin support: `.kt` and `.kts` files are parsed into the code graph
  (classes, objects, interfaces, functions, properties, calls, imports) during
  ingest, and Kotlin modules get a deterministic rule inventory in
  business-requirements generation — `require`/`check` preconditions, guard
  clauses and elvis guards, thrown exceptions, `when` on a status or enum,
  validation annotations, and constants and comparisons against them. The
  rules are saved with the other languages' mined rules and reach the Rules
  section.
