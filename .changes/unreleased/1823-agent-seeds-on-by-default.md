---
issue: 1823
section: Changed
---

- When you run an impact analysis on requirements you already evaluated with "Evaluate new
  requirements", the files Analysis's code agent cited for each requirement now lead the
  files to edit by default (`IMPACT_AGENT_SEEDS`, now on). On the held-out test set this
  found the right file in the top five noticeably more often, and on the table test set it
  did not lower table precision against the same analyses without it. It makes no extra AI
  call. An administrator can turn it off with `IMPACT_AGENT_SEEDS=0`.
