---
issue: 0
section: Changed
---

- Documentation generation reads every function and all module-level code of
  every module: a module too large for one fact-extraction call is read in
  several calls, a call cut off by the output limit is split instead of retried
  with a larger limit, and every rule miner runs over the whole source. Files
  the module rules used to drop are now documented, with no module-count cap.
- Batched sections are no longer run through the refine pass, a cut-off draft
  is never refined, and generation progress advances once per batch.
