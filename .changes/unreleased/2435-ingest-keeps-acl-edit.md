---
issue: 2435
section: Security
---

- A document's access list saved while the document was being indexed now
  stands. Before, the ingest wrote back the list it read when it started, so a
  document restricted mid-ingest became visible to every project member again
  and its chunks were indexed unrestricted. Approval also applies the list the
  document holds when it commits, not the one it started with.
