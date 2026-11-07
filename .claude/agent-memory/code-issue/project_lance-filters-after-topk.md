---
name: lance-filters-after-topk
description: LanceVectorStore.search applies where() filters after picking the top-k (vectordb 0.21 prefilter defaults false); LocalVectorStore tests cannot catch it.
metadata:
  type: project
---

The default LanceDB vector store (vectordb 0.21.x) applies `where()` filters **after** it picks the top-k: `prefilter` defaults to `false` and `LanceVectorStore.search` (`server/src/lib/rag/vector-store.ts`) calls `limit(k).where(...)` without setting it. A search that relies on `SearchFilter.documentIds` or `embeddingModel` can return fewer than k hits, or none. The reviewer's probe on PR #1912: a filtered `limit(5)` returned 0 rows where `prefilter(true)` returned 5. Fix tracked in #1917.

**Why:** `LocalVectorStore` filters before ranking, and every test used it, so the governing search (superseded revisions and soft-deleted documents keep their chunks) looked correct in tests and was wrong on the default backend.

**How to apply:** any feature whose correctness depends on a filtered vector search needs a test on a real `LanceVectorStore` in a temp dir, holding more than k filtered-out rows. Related: [[test-harness-false-greens]].
