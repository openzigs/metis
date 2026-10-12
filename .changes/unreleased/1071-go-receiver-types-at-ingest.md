---
issue: 1071
section: Changed
---

- Go method calls now bind in the code graph at ingest: receiver, struct-field, parameter and
  `x := NewFoo()` / `&Foo{}` types are read from the source, so `h.store.SetEntriesStatus()`
  reaches `Storage::SetEntriesStatus`. A Go method is named `<file>::<ReceiverType>::<name>`.
  - Calls outside the project are marked external only on positive evidence and never bound by name.
  - Existing graphs upgrade in place on their next ingest (ids kept; new `code_graphs.extractorVersion`).
  - The upgrade spends no model calls: it alone does not regenerate auto-updating documents.
  - Impact results, requirement code links and "Tested by" can change on Go projects
    (`docs/OPERATIONS.md` §6.5). Unparseable files are named and Go binding cost is reported.
