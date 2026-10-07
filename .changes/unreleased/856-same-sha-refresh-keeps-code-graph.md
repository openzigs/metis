---
issue: 856
section: Fixed
---

- A repository refresh on an unchanged commit no longer re-creates the code graph when the
  SQL-lineage inputs change (for example after adding a database connector). Only the lineage
  of unchanged files is re-extracted, so symbol ids, findings, mappings and embeddings stay
  linked, and an in-flight document's inputs fingerprint is not invalidated.
