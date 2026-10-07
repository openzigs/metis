---
issue: 862
section: Fixed
---

- The embeddings reindex on Settings → Embeddings no longer sits on
  "Re-embedded N/N chunks, 100%" after the documents finish. Re-embedding a
  project's code-symbol vectors, the second phase, now streams its own
  progress ("Re-embedded X/Y code symbols"), and the completion message names
  both. `pnpm embeddings:migrate` labels the two phases the same way.
