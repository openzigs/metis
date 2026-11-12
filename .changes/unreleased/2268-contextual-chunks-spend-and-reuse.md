---
issue: 2268
section: Fixed
---

- With contextual chunks in `model` mode, each per-chunk model call now counts as project usage
  and against the monthly token budget, and stops once the budget is spent. Re-ingesting an
  unchanged document reuses the contexts it already has instead of asking the model again, and
  deleting a document mid-ingest stops its remaining calls. `embeddings:migrate status` now lists
  the projects that need a re-ingest after `RAG_CONTEXTUAL_CHUNKS` changes.
