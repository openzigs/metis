---
issue: 935
section: Fixed
---

- SQL lineage fixes from #859 now reach existing code graphs. The next ingest with lineage on
  re-extracts every file once, so Postgres builtins such as `now()` stop appearing as executed
  procedures, a CTE `UPDATE` records its write, and `UPDATE … FROM` no longer records a write to the
  joined table. A server test now fails if the lineage sidecar's extractor changes without a version
  bump.
