---
issue: 2560
section: Added
---

- `pnpm eval:localization` adds the agent arm `A20`. It works the way Claude Code does: it
  searches and reads the repository before it answers, using `grep_files`, `list_files`,
  whole-file reads, the code graph and the symbol search. It treats the search's suggestions as
  hints, runs up to 30 turns with no token budget, and stops at $1 per item. Measured against
  the analysis code agent's pass (`A3A`) on the held-out corpora, it found more of the files a
  change edits (pooled Recall@5 +0.09, Miniflux +0.19) at the same edit precision, for about 46%
  more cost per Miniflux requirement (`eval-data/README.md`). Production's impact analysis and
  analysis agent are unchanged.
- The partials of `pnpm eval:localization` now record spend after every model call, so a slice
  killed mid-requirement keeps the calls that returned.
