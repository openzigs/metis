---
issue: 2527
section: Added
---

- The document-retrieval eval has a third corpus, `docretrieval-03-analyst-docs`: fourteen
  BRDs, PRDs, FRDs and policies of the kind business analysts upload, with 226 questions.
  `pnpm eval:doc-retrieval --extra-sizes 4096` adds chunk sizes beyond the standard four. On
  this corpus, with the default embedding model, no chunk size beat the default of 2048
  characters, so the default stays and nothing needs re-indexing.
