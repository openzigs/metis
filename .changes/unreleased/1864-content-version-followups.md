---
issue: 1864
section: Fixed
---

- Chat's tool-result cache stops serving results computed before a document reindex, and stops
  serving a removed repository's files. It no longer reads every document row on each cached tool
  call: the project's content version now uses the document count and a new `documents.updatedAt`
  column. Knowledge searches are cached even while a repository's code graph is still on its first
  ingest.
