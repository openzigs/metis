---
issue: 2196
section: Fixed
---

- **Settings → Embedding backends** no longer freezes its reindex progress bar when the server
  running the reindex stops: while it follows a reindex, the page re-reads the project's
  coverage every 15 seconds, and once nothing is running it drops the bar and offers the reindex
  again. It also no longer stays on *Reindex in progress* with the button disabled after a
  reindex it was following finishes but the server briefly still lists it as running.
- The page keeps the checked project in its address as `?projectId=`, the same name the other
  settings pages use.
- A repository's **Deep Ingest** no longer fails if reporting its file count fails part-way.
