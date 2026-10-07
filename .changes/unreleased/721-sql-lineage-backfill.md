---
issue: 721
section: Fixed
---

- SQL lineage now backfills on an already-ingested repository. Turning lineage on, adding a database
  whose schema changes what lineage resolves, or first reaching the SQL-lineage service after it was
  unreachable re-parses every file on the next ingest instead of waiting for files to change.
  Turning lineage off re-parses once too, which removes the lineage edges; ingest stats report both
  as a lineage backfill. A database that briefly cannot be read does not trigger a re-parse.
- The Gap Report's SQL-lineage coverage no longer counts ordinary code-to-code calls as table
  edges. A project with no SQL lineage used to read "100% resolved" over thousands of code calls.
