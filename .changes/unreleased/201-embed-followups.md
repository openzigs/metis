---
issue: 201
section: Fixed
---

- Cancelling a generated document's search indexing, or its last attempt timing
  out, now marks the document failed with the reason. This includes a cancel
  that lands while the indexing is still queued. Before, it stayed "pending" or
  "processing" forever. Documents already stuck this way are repaired when the
  server starts.
- Chinese, Japanese, Korean and emoji text is now indexed in full. A chunk of such
  text could exceed the embedding model's 2,048-token input and lose its tail. The
  chunker version is now `doc:v3`, so `embeddings:migrate status` flags every
  project for re-ingest. Documents with non-ASCII text are the ones it repairs;
  all-ASCII documents re-chunk identically.
