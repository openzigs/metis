---
issue: 1469
section: Fixed
---

- The architecture document's schema check no longer marks a config key as a
  missing column because a column word appears elsewhere on the line: the word
  must stand beside the name, in the same clause.
- Data Architecture's schema-check line and the Provenance panel no longer say
  every name matched when some could not be checked. The panel names what the
  names were compared with (the database, a stored schema or the repository's
  SQL), says why nothing could be checked when that happens, and shows the true
  count of unmatched names when only the first 50 are listed.
