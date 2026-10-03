---
issue: 760
section: Fixed
---

- SQL lineage no longer turns bind parameters (`$1`, `?`, `:name`) into
  columns. In a Go project they were 28% of column edges, which also inflated
  the Gap Report's resolved figure.
- Columns that an `UPDATE`, `DELETE` or `MERGE` only filters on are recorded as
  reads, not writes.
- Embedded-SQL edges start from the enclosing function, such as `UpdateFeed`,
  not from a `sql@<line>` symbol. Already-ingested graphs change on the next
  full re-ingest.
