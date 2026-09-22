---
issue: 16
section: Fixed
---

- Deep Ingest no longer stops the API from answering. On SQLite the code-graph
  persist phase held the event loop for its whole length (7.5 minutes for this
  repository, with `/healthz` timing out); it now yields every 50 ms and writes
  in batches, so `/healthz` stays under 300 ms and the phase runs about 5x faster.
