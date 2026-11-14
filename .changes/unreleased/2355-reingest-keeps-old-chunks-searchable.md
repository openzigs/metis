---
issue: 2355
section: Fixed
---

- Re-indexing a document no longer takes it out of search while the new version is processed:
  the previous version answers until the new chunks are indexed. A re-index that fails, or waits
  for review, still takes the old version out of search, and rejecting a document now always does.
- A document whose model-written chunk contexts stop partway (budget spent, repeated failures, no
  provider) is tagged `model-partial` and listed by `embeddings:migrate status` for a re-index,
  which reuses the contexts it has. The budget is read once per document and shared by documents
  of one project indexed at the same time.
