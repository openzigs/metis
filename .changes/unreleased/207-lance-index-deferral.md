---
issue: 207
section: Fixed
---

- Repository ingest into LanceDB is no longer quadratic. The vector index is built
  once a table passes 1,000 rows and re-trained only when the table doubles, and old
  table versions are compacted and reclaimed as ingest runs, so disk use tracks the data.
- `RAG_RERANK=1` beside the default worker-thread embedder now refuses to boot with
  a message naming the fixes, instead of aborting the server on the first search (#222).
