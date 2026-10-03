---
issue: 760
section: Fixed
---

- SQL lineage no longer turns bind parameters (`$1`, `?`, `:name`) into
  columns; in a Go project they were 28% of column edges.
- Columns an `UPDATE`, `DELETE` or `MERGE` only filters on are reads, not
  writes, and an unqualified `SET` target in a multi-table statement is kept.
- Embedded-SQL edges start from the enclosing function, such as `UpdateFeed`,
  not from a `sql@<line>` symbol.
- Projects with lineage on rewrite these edges on their next ingest; no manual
  re-ingest is needed.
