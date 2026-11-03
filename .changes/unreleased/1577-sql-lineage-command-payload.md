---
issue: 1577
section: Fixed
---

- SQL lineage no longer loses a whole file's statements when one of them is a statement the
  parser cannot model, such as Postgres `DROP EXTENSION` or a multi-action `ALTER TABLE`. The
  lineage service used to fail the request (HTTP 500) and the ingest skipped that file's usage.
  It now reports such a statement as uncertain and still extracts the rest of the file.
