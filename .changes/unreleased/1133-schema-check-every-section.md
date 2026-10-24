---
issue: 1133
section: Fixed
---

- The architecture document's schema check now reads every section, not only
  Data Architecture: a name a sentence calls a database table or column that the
  schema does not have (such as an invented `certificate_cache`) is marked
  *(not in schema)* where it stands, listed in an informational line, recorded
  in the section's provenance and shown in the version's Provenance panel.
  Nothing is removed or rewritten.
- A Data Architecture section without a Schema check note now says in one line
  how many names were compared and whether every one matched. The line is added
  on each generation, so stored sections are not written again for it.
