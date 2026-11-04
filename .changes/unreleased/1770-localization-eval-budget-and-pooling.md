---
issue: 1770
section: Changed
---

- `pnpm eval:localization` now holds the dollar cap across every corpus and the table-precision
  guard, counts a model call that reports no usage as unpriced (and stops), refuses `--runs 0`,
  scores every arm on the runs all arms completed, and writes a pooled comparison over both
  held-out sets (40 items, stratified by corpus) next to the per-corpus reports.
