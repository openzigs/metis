---
issue: 1133
section: Fixed
---

- The architecture document's schema check now reads every section, not only
  Data Architecture: a name a sentence calls a database table or column that the
  schema does not have (such as an invented `certificate_cache`) is marked
  *(not in schema)* where it stands, listed in an informational line, and
  recorded in the section's provenance. Nothing is removed or rewritten.
- A Data Architecture section whose names all match the schema now says so in
  one line, with how many names were compared.
