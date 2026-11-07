---
issue: 1947
section: Fixed
---

- Governing documents: one uploaded during `embeddings:migrate reindex --all`
  is searchable afterwards, and search keeps answering while the index rebuilds;
  `embeddings:migrate status` counts governing indexes, so a model change no
  longer reads "Up to date."; an admin can retry a failed or stalled rule
  extraction; extraction's model calls are billed to the workspace in the usage
  ledger; a rule keeps only a control id written beside its own clause, and
  generated ids are `METIS-001`… (never one the policy uses). Still behind
  `GOVERNING_DOCS_ENABLED`, off by default.
