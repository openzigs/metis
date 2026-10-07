---
issue: 758
section: Fixed
---

- The commit shown on a repository connector card is now always the commit its
  code graph was built from. Deep Ingest, Sync and the scheduled refresh record
  it only when the graph ingest completes, in the same write as the graph's own
  label, and the metadata step no longer overwrites it with the remote tip that
  may have moved during a long ingest. A failed ingest leaves both on the
  previous commit.
