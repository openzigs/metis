---
issue: 440
section: Fixed
---

- The Workbench document panel no longer misses a document when another one is deleted or ingested
  while the list is loading. `GET /api/projects/:id/documents` now returns a `nextCursor`, and a
  request with `?cursor=` returns the page after it in a stable order (newest first, then by id),
  without re-counting the project's documents.
- The attached-document chips above the Workbench chat are labelled like the panel rows they came
  from (`README.md — wms-core`, or `Unnamed repository`), and no longer show part of an internal
  repository id.
