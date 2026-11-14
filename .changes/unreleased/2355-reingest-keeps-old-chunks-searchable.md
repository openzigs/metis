---
issue: 2355
section: Fixed
---

- Re-indexing a document no longer takes it out of search while the new version is processed.
  The previous version keeps answering searches and chat until the new chunks are indexed. That
  matters most with model-written chunk contexts and image descriptions, which can take minutes. A
  re-index that fails, or is waiting for review, still takes the old version out of search, as it
  did before.
- When the project's token budget runs out partway through a document's model-written chunk
  contexts, the document is now tagged `model-partial` rather than `model`.
  `embeddings:migrate status` lists it as needing a re-index, which reuses the contexts it already
  has. The budget is now read once per document rather than once per chunk.
