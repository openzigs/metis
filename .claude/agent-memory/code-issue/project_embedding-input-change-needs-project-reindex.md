---
name: embedding-input-change-needs-project-reindex
description: pnpm embeddings:migrate reindex --all only touches projects on another model; an embedding-input change that keeps the model needs reindex --project or the Settings button.
metadata:
  type: project
---

`pnpm embeddings:migrate reindex --all` reindexes only projects whose chunks are on another embedding model (#2532 fixer). A change to the embedding INPUT (what text is embedded) that keeps the model identity is invisible to it, and `migrate status` will not flag those projects as stale.

**Why:** staleness is keyed on the model identity, not on the input format.

**How to apply:** a PR that changes embedding input must document `pnpm embeddings:migrate reindex --project <id>` (or the Settings > Reindex button) in its upgrade notes, and must not claim `--all` covers it.
