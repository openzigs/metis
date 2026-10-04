---
issue: 857
section: Fixed
---

- Regenerating a document reuses its finished sections again. The cross-module flow block
  in every section's prompt depended on database edge order, so a code graph rebuilt with
  identical content made every checkpointed section look stale. A run refused at the
  commit fence keeps its finished sections for reuse (not as exportable content), and a
  resumed version lists the sections it reused and why it rewrote the rest.
