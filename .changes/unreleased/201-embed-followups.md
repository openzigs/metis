---
issue: 201
section: Fixed
---

- Cancelling a generated document's search indexing, or its last attempt timing
  out, now marks the document failed with the reason. Before, it stayed
  "processing" forever. Documents already stuck this way are repaired when the
  server starts.
- Chinese, Japanese, Korean and emoji text is now indexed in full. A chunk of such
  text could exceed the embedding model's 2,048-token input and lose its tail. The
  chunker version is now `doc:v3`. Only documents with non-ASCII text need a
  re-ingest; all-ASCII documents re-chunk identically.
