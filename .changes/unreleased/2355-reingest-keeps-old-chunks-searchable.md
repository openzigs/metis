---
issue: 2355
section: Fixed
---

- Re-indexing a document no longer takes it out of search while the new version is processed.
  The previous version keeps answering searches and chat until the new chunks are indexed. That
  matters most with model-written chunk contexts and image descriptions, which can take minutes. A
  re-index that fails, or is waiting for review, still takes the old version out of search, as it
  did before.
- Rejecting a document now takes it out of search in every case, including while it is being
  re-indexed and when it was already indexed.
- When a document's model-written chunk contexts stop partway (the project's token budget runs
  out, too many calls fail, or no provider is configured), the document is now tagged
  `model-partial` rather than `model`. A document too large for model contexts is tagged
  `model-oversize` and is not listed as needing a re-index, since one cannot change it. `embeddings:migrate status` lists
  it as needing a re-index, which reuses the contexts it already has. The budget is now read once
  per document rather than once per chunk, and documents of one project indexed at the same time
  share it, rather than each spending all that is left.
