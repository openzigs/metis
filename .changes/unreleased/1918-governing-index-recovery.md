---
issue: 1918
section: Fixed
---

- A governing document no longer drops out of search when its new revision
  fails to index: search keeps answering from the previous revision, and says
  which revision each result came from, until the new one is indexed. The
  document list already shows the current revision as `pending` in that state.
- `pnpm embeddings:migrate reindex --all` now also rebuilds the workspaces'
  governing-document indexes from the stored text, so changing the embedding
  model (or migrating the pgvector column) no longer leaves governing search
  returning nothing. The same pass indexes any revision whose upload-time
  indexing failed. Still behind the `GOVERNING_DOCS_ENABLED` setting.
