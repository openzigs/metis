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
- The batched Business Rules section receives every mined rule: a module too
  large for one batch is split into labelled parts instead of having its
  mined-rule list capped, and mined rules cite file:line in every prompt.
- `DOCS_GEN_PHASE1_INCLUDE_TESTS` (default on) lets a run leave test, spec
  and fixture files out of fact extraction and rule mining; they are then
  reported as excluded by policy rather than as missing.
