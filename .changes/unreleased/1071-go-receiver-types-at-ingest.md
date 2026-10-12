---
issue: 1071
section: Changed
---

- Go method calls now bind in the code graph at ingest: receiver, field, parameter and
  `x := NewFoo()` types are read from the source, so `h.store.SetEntriesStatus()` reaches
  `Storage::SetEntriesStatus`. A Go method is named `<file>::<ReceiverType>::<name>`.
  - Calls outside the project are `external` on positive evidence, `external-assumed` where the
    receiver's type was not examined; neither is bound by name. Binding has reported ceilings.
  - Existing graphs upgrade in place on their next ingest, once, without regenerating
    auto-updating documents; a file that cannot be upgraded is named and retried when it changes.
  - Impact results, requirement links and "Tested by" can change on Go projects (OPERATIONS §6.6).
