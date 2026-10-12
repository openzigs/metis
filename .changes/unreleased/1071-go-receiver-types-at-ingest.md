---
issue: 1071
section: Changed
---

- Go method calls now bind in the code graph at ingest: receiver, struct-field, parameter and
  `x := NewFoo()` / `&Foo{}` types are read from the source, so `h.store.SetEntriesStatus()`
  reaches `Storage::SetEntriesStatus`. A Go method is named `<file>::<ReceiverType>::<name>`.
  - Calls into the standard library or a third-party module are marked as such and never bound
    by name; interface calls stay unresolved.
  - Existing graphs upgrade in place on their next ingest (symbol ids are kept), tracked by the
    new nullable `code_graphs.extractorVersion` column.
