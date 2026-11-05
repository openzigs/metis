---
issue: 1755
section: Added
---

- `pnpm eval:localization` gains three arms that measure the Analysis code agent's citations as
  impact-analysis seeds, run over a materialized corpus (`pnpm eval:materialize`):
  - `A3`: the citations unioned with today's seeding.
  - `A3A`: the citations alone.
  - `A3N`: an agent given file tools and a text search only, with no code-graph search.

  A cited file counts only when the code graph holds it. The report shows agent-loop turns per
  requirement. There is no product change.
