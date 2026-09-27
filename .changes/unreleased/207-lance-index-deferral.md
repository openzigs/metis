---
issue: 207
section: Fixed
---

- Repository ingest into LanceDB is no longer quadratic. The vector index is built
  once a table passes 1,000 rows and re-trained when the table doubles or a re-sync
  leaves it covering less than half the rows. It is now trained with the cosine metric
  search uses, and old table versions are compacted and reclaimed as ingest runs.
- `RAG_RERANK=1` beside the default worker-thread embedder now refuses to boot with
  a message naming the fixes, instead of aborting the server on the first search (#222).
