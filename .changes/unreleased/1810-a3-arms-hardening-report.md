---
issue: 1810
section: Fixed
---

- The localization eval's agent arms (`A3`, `A3A`, `A3N`) are harder to misread:
  - The eval-only `grep_files` tool no longer follows symlinked directories, so a symlink loop cannot hang a pass.
  - Its 5,000-file cap now counts only the files a `pathContains` search covers, and it says when the cap cut a search short.
  - `A3N` stops with an error when a repository's clone is missing, instead of scoring about 0 at full cost.
  - The report gives, per arm, the passes without a valid answer, turns and tool calls per pass, and how many cited files the code graph held before the resolve step.
  - On a portfolio, the report says that turns per requirement are summed over the per-repository passes.
  - The report says when a resumed run had `A3` and `A3A` read different agent passes.
