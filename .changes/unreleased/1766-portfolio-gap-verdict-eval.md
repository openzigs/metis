---
issue: 1766
section: Added
---

- `pnpm eval:portfolio-gap` measures how often portfolio gap analysis gets the verdict right on
  the 15 fixture-repo requirements. It reports verdict accuracy (overall and per repository), a
  confusion matrix, uncited `implemented` claims (any one fails the run), citation validity,
  expected-repository recall, cost and time, and paired tests between arms. The committed
  baseline (Claude Sonnet 5.5, 3 runs) reads 0.49 accuracy for the shipped engine and confirms
  only 17% of gaps. #1763's per-repo search shows no measurable difference.
