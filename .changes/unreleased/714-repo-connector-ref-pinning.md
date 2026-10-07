---
issue: 714
section: Fixed
---

- A repository connector can be pinned to a branch or tag at creation (**Branch or tag** field),
  so its first ingest clones that ref; **Test** keeps a ref that exists and fails with "Branch or
  tag … was not found" for one that does not, instead of resetting it to the default branch.
- The connector reports the commit it last ingested, and the code graph carries the same commit
  after a Deep Ingest, a **Sync** or a scheduled refresh. A bug scan, an AST cache rebuild or a
  credential rescan no longer moves the recorded commit ahead of the graph, so scan findings no
  longer fail to publish as stale.
