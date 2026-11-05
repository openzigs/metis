---
issue: 1800
section: Added
---

- `pnpm eval:localization` runs in slices, resumes a stopped run and merges the partial results
  itself. `--shard <n>/<m>` or `--items <from>:<to>` runs a slice; every requirement score is
  recorded as a partial file, so `--resume <dir>` re-runs only the missing ones and
  `--merge <dir>` builds the report from the files with the runner's own scoring and statistics.
  The dollar cap and the unpriced-call stop hold across slices, a changed configuration (arms,
  model, run count, corpus) refuses to resume or merge, and a report lists the requirements still
  missing a score. Slow arms can now be measured in steps of under ten minutes, reproducibly from
  the repository.
