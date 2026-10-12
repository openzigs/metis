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
  - Binding has reported ceilings on time and memory and stops itself before the heap runs out; what
    is left shows in the Sync result, is finished by later ingests, and never replaces a stored
    binding (OPERATIONS §6.6). With no `go.mod`, an import binds only to a directory holding its whole path; a type reaching over 64 embedded types is left undecided.
