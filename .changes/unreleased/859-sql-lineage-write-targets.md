---
issue: 859
section: Fixed
---

- SQL lineage records a write only on the table a statement actually modifies. An `UPDATE`,
  `DELETE` or `INSERT` inside a `WITH` clause is now a write, not a read, and tables read through
  `UPDATE … FROM`, `DELETE … USING`, `MERGE … USING` or `INSERT … SELECT` are reads. Built-in SQL
  functions such as `now()` and `to_tsvector()` are no longer recorded as procedure calls.
