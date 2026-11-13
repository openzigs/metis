---
issue: 2250
section: Fixed
---

- `eval:doc-understanding`: when one of arm C's section calls fails, no further section call
  starts, and the reading fails only after the calls already running have finished. Their spend
  now stays in that reading, and the next reading no longer runs beside them. A reading records
  the output-token cap it ran at, and `--combine` refuses to pool readings made at different
  caps. It also counts unpriced calls from the readings it keeps. Arms B and C no longer get
  the labelling rubric in their prompt. The baseline write-up now says how arm A's retrieval
  differs from production's, which squash-merged commit each measured commit landed as, and
  that DeepSeek's B and C results are partial.
