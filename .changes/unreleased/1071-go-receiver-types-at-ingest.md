---
issue: 1071
section: Changed
---

- Go method calls now bind in the code graph at ingest: receiver, field, parameter and
  `x := NewFoo()` types are read from the source, so `h.store.SetEntriesStatus()` reaches
  `Storage::SetEntriesStatus`. A Go method is named `<file>::<ReceiverType>::<name>`.
  - Calls outside the project are `external` on positive evidence, `external-assumed` where the
    receiver's type was not examined; neither is bound by name. Bindings are checked against the
    Go type checker on a checked-in corpus.
  - Existing graphs upgrade in place on their next ingest, once, without regenerating documents.
  - Binding has reported ceilings on time and on memory; what the time ceiling leaves is shown in
    the Sync result, finished by the next ingests, and never replaces a stored binding
    (OPERATIONS §6.6).
