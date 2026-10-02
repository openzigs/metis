---
issue: 714
section: Fixed
---

- A repository connector can now be pinned to a branch or tag when it is created: the
  "Repository connectors" form has a **Branch or tag** field, so the first connector's automatic
  ingest clones that ref rather than the default branch.
- **Test** no longer replaces the connector's branch or tag with the repository's default branch.
  It keeps a ref that exists, fails with "Branch or tag … was not found" for one that does not,
  and only adopts the default branch for a connector created without a ref whose `main` does not
  exist (for example a `master` repository).
- The connector now reports the commit it last ingested (shown beside the ref), and the code
  graph is labelled with that commit, instead of keeping the default branch's head after a
  tag was ingested.
