---
issue: 1799
section: Added
---

- `pnpm eval:materialize <corpus>` materializes a localization corpus as ingested METIS projects
  for agent-based eval arms. Each repository gets a clone at its pinned commit, a project with a
  GitHub repository connector, the normal code-graph ingest and symbol vectors from the local
  embedder. Everything goes into the gitignored `eval-data/.materialized/` (its own SQLite
  database, never `server/dev.db`). A re-run is a no-op. Every run checks the graph's files and
  qualified names against the committed symbol rows and fails, listing the differences, when
  they disagree.
